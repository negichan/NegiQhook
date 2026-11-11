// Boot-only DLL for the headless QQ main.
//
// QQ is started suspended, this DLL is injected before its first instruction,
// and it redirects two file opens in-process:
//
//   ...\resources\app\package.json  -> <dll dir>\app.package.json
//   ...\resources\app\app.main.js   -> <dll dir>\app.main.js
//
// The package copy only changes "main" to ./app.main.js; Electron loads our
// main instead of QQ's UI. No QQ file is modified. We hook CreateFileW and the
// file-attribute queries in the main module immediately. QQNT.dll (which hosts
// Node/Electron and does the actual read) is loaded later, so it is patched
// from wrapped LoadLibrary* calls and by a short polling fallback.
//
// After the boot main has been read the hooks are restored and the DLL unloads
// itself. The rest of the process is pure JS driving the QQNT wrapper/session.
//
// Diagnostics: create an empty file named "appinit.trace" next to this DLL (the
// launcher does that for --trace) and every hook entry is logged, with a
// per-thread re-entrancy guard that keeps a hooked call from redirecting itself.
#include <windows.h>

#include <atomic>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <intrin.h>
#include <mutex>
#include <string>
#include <vector>

namespace {

using CreateFileWFn = HANDLE(WINAPI*)(LPCWSTR, DWORD, DWORD,
                                      LPSECURITY_ATTRIBUTES, DWORD, DWORD,
                                      HANDLE);
using LoadLibraryExWFn = HMODULE(WINAPI*)(LPCWSTR, HANDLE, DWORD);
using LoadLibraryExAFn = HMODULE(WINAPI*)(LPCSTR, HANDLE, DWORD);
using LoadLibraryWFn = HMODULE(WINAPI*)(LPCWSTR);
using LoadLibraryAFn = HMODULE(WINAPI*)(LPCSTR);
using GetFileAttributesWFn = DWORD(WINAPI*)(LPCWSTR);
using GetFileAttributesExWFn = BOOL(WINAPI*)(LPCWSTR, GET_FILEEX_INFO_LEVELS,
                                             LPVOID);
using CreateFile2Fn = HANDLE(WINAPI*)(LPCWSTR, DWORD, DWORD, DWORD,
                                      const CREATEFILE2_EXTENDED_PARAMETERS*);
// winbase.h / kernel32: BOOL GetFileInformationByName(PCWSTR,
// FILE_INFO_BY_NAME_CLASS, PVOID, ULONG). The enum is passed as an int here so
// the hook does not need a newer SDK; the ABI is a plain 32-bit value.
using GetFileInformationByNameFn = BOOL(WINAPI*)(LPCWSTR, int, PVOID, ULONG);
using ExitProcessFn = void(WINAPI*)(UINT);
using TerminateProcessFn = BOOL(WINAPI*)(HANDLE, UINT);

HMODULE g_module = nullptr;
CreateFileWFn g_real_create = nullptr;
LoadLibraryExWFn g_real_load_w = nullptr;
LoadLibraryExAFn g_real_load_a = nullptr;
LoadLibraryWFn g_real_load_plain_w = nullptr;
LoadLibraryAFn g_real_load_plain_a = nullptr;
GetFileAttributesWFn g_real_attrs_w = nullptr;
GetFileAttributesExWFn g_real_attrs_ex_w = nullptr;
CreateFile2Fn g_real_create2 = nullptr;
GetFileInformationByNameFn g_real_info_by_name = nullptr;
ExitProcessFn g_real_exit = nullptr;
TerminateProcessFn g_real_terminate = nullptr;

std::wstring g_target_package;
std::wstring g_target_main;
std::wstring g_log_path;
std::wstring g_dll_dir;
// Directory of QQ.exe. Only modules from this tree are ever patched: a hook in
// advapi32.dll or kernelbase.dll would be a much larger footprint than the two
// redirected boot reads are worth, and patching shared system modules is the
// kind of thing that breaks a process for reasons that have nothing to do with
// QQ. The redirect only needs the main module and the Node/Electron host.
std::wstring g_install_dir;
std::atomic<int> g_modules_patched{0};

std::mutex g_patch_mutex;
std::vector<void**> g_create_slots;
std::vector<void**> g_attrs_slots;
std::vector<void**> g_attrs_ex_slots;
std::vector<void**> g_create2_slots;
std::vector<void**> g_info_by_name_slots;
std::vector<void**> g_exit_slots;
std::vector<void**> g_terminate_slots;
std::vector<void**> g_load_w_slots;
std::vector<void**> g_load_a_slots;
std::vector<void**> g_plain_load_w_slots;
std::vector<void**> g_plain_load_a_slots;

std::atomic<bool> g_main_served{false};
std::atomic<bool> g_package_served{false};
// QQ's boot verifier reads resources/app/package.json first and hashes it against
// the RSA-2048 signature stored in resources/app/application.json. Handing it the
// rewritten file gives "文件已损坏，请重新安装" + ExitProcess(0). Only the Node side
// needs our copy, and Node's Module._load of package.json necessarily comes after
// that verifier, so the first real open passes through untouched and everything
// from the second read on sees our file. app.main.js is unaffected: it does not
// exist on disk at all, so there is nothing to verify.
std::atomic<bool> g_package_redirect_armed{false};
std::atomic<bool> g_package_redirect_logged{false};
std::atomic<int> g_in_hook{0};
std::atomic<bool> g_trace{false};
std::atomic<int> g_trace_lines{0};
std::atomic<int> g_exit_logged{0};

// A hook re-entered on the same thread must not redirect again, or a hooked call
// that ends up back in a hook would recurse into a stack overflow.
thread_local int t_hook_depth = 0;

struct HookGuard {
    bool reentrant = false;
    HookGuard() {
        reentrant = t_hook_depth > 0;
        ++t_hook_depth;
        g_in_hook.fetch_add(1, std::memory_order_relaxed);
    }
    ~HookGuard() {
        --t_hook_depth;
        g_in_hook.fetch_sub(1, std::memory_order_relaxed);
    }
};

wchar_t LowerAscii(wchar_t value) {
    return value >= L'A' && value <= L'Z' ? static_cast<wchar_t>(value + 32)
                                          : value;
}

// Which module a hooked call came back from, as module+offset. This is how a
// silent early QQ exit gets attributed: ExitProcess/TerminateProcess carry no
// log of their own, and "code=0 after 2s" only means something once we know
// whether it was QQNT.dll (Node called process.exit) or QQ.exe's stub.
std::wstring CallerAt(void* address) {
    if (address == nullptr) {
        return L"(unknown)";
    }
    wchar_t hex[40] = {};
    HMODULE module = nullptr;
    if (!GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            static_cast<LPCWSTR>(address), &module) ||
        module == nullptr) {
        swprintf_s(hex, L"%p", address);
        std::wstring text = L"(unresolved ";
        text += hex;
        text += L")";
        return text;
    }
    wchar_t name[MAX_PATH * 4] = {};
    const DWORD length = GetModuleFileNameW(module, name, _countof(name));
    std::wstring result;
    if (length > 0 && length < _countof(name)) {
        const std::wstring full(name, length);
        const size_t slash = full.find_last_of(L"\\/");
        result = full.substr(slash == std::wstring::npos ? 0 : slash + 1);
    } else {
        result = L"(module)";
    }
    swprintf_s(hex, L"+0x%llX",
               static_cast<unsigned long long>(
                   reinterpret_cast<unsigned char*>(address) -
                   reinterpret_cast<unsigned char*>(module)));
    result += hex;
    return result;
}

void WriteLog(const std::wstring& text);
void WriteLog(const char* text);

// One line per hooked call, only when <dll dir>\appinit.trace exists. The string
// is not built at all when tracing is off, since these are hot paths.
void TraceApi(const wchar_t* api, const wchar_t* path) {
    if (!g_trace.load(std::memory_order_relaxed)) {
        return;
    }
    if (g_trace_lines.fetch_add(1, std::memory_order_relaxed) >= 2000) {
        return;
    }
    std::wstring text = L"trace ";
    text += api;
    text += L" ";
    text += (path != nullptr ? path : L"(null)");
    WriteLog(text);
}


std::wstring ModuleDirectory() {
    wchar_t path[MAX_PATH * 4] = {};
    const DWORD length = GetModuleFileNameW(g_module, path, _countof(path));
    if (length == 0) {
        return L".";
    }
    std::wstring result(path, length);
    const size_t slash = result.find_last_of(L"\\/");
    return slash == std::wstring::npos ? L"." : result.substr(0, slash);
}

bool EndsWithPath(const wchar_t* path, const wchar_t* suffix) {
    if (path == nullptr || suffix == nullptr) {
        return false;
    }
    const size_t path_length = wcslen(path);
    const size_t suffix_length = wcslen(suffix);
    if (path_length < suffix_length) {
        return false;
    }
    const wchar_t* tail = path + (path_length - suffix_length);
    // ASCII folding only: the suffixes we match are plain ASCII, and this keeps
    // the hooks out of the CRT locale machinery (towlower touches the per-thread
    // locale block, which is not something a file-creation hook should depend on).
    for (size_t i = 0; i < suffix_length; ++i) {
        wchar_t a = tail[i];
        wchar_t b = suffix[i];
        if (a == L'/') {
            a = L'\\';
        }
        if (b == L'/') {
            b = L'\\';
        }
        if (LowerAscii(a) != LowerAscii(b)) {
            return false;
        }
    }
    return true;
}

void WriteLogUtf8(const std::string& text) {
    if (g_log_path.empty()) {
        return;
    }
    SYSTEMTIME now = {};
    GetLocalTime(&now);
    char stamp[64] = {};
    snprintf(stamp, sizeof(stamp), "%04u-%02u-%02u %02u:%02u:%02u ",
             static_cast<unsigned>(now.wYear),
             static_cast<unsigned>(now.wMonth),
             static_cast<unsigned>(now.wDay),
             static_cast<unsigned>(now.wHour),
             static_cast<unsigned>(now.wMinute),
             static_cast<unsigned>(now.wSecond));
    const HANDLE file = CreateFileW(
        g_log_path.c_str(), FILE_APPEND_DATA,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return;
    }
    const std::string line = std::string(stamp) + text + "\r\n";
    DWORD written = 0;
    WriteFile(file, line.data(), static_cast<DWORD>(line.size()), &written,
              nullptr);
    CloseHandle(file);
}

void WriteLog(const std::wstring& text) {
    if (text.empty()) {
        return;
    }
    const int size = WideCharToMultiByte(CP_UTF8, 0, text.data(),
                                         static_cast<int>(text.size()), nullptr,
                                         0, nullptr, nullptr);
    if (size <= 0) {
        return;
    }
    std::string utf8(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                        utf8.data(), size, nullptr, nullptr);
    WriteLogUtf8(utf8);
}

void WriteLog(const char* text) {
    if (text != nullptr) {
        WriteLogUtf8(text);
    }
}

// Patches one imported function by name in a module's import table. `original`
// is used as a fallback for bound/ordinal-only imports.
template <typename Fn>
int PatchImport(HMODULE module, const char* wanted, Fn hook, void* original,
                std::vector<void**>& slots) {
    if (module == nullptr || module == g_module || wanted == nullptr) {
        return 0;
    }
    auto* base = reinterpret_cast<unsigned char*>(module);
    auto* dos = reinterpret_cast<IMAGE_DOS_HEADER*>(base);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) {
        return 0;
    }
    auto* nt = reinterpret_cast<IMAGE_NT_HEADERS*>(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) {
        return 0;
    }
    const auto& imports =
        nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (imports.VirtualAddress == 0 || imports.Size == 0) {
        return 0;
    }

    std::lock_guard<std::mutex> lock(g_patch_mutex);
    int patched = 0;
    auto* descriptor =
        reinterpret_cast<IMAGE_IMPORT_DESCRIPTOR*>(base + imports.VirtualAddress);
    for (; descriptor->Name != 0; ++descriptor) {
        auto* first =
            reinterpret_cast<IMAGE_THUNK_DATA*>(base + descriptor->FirstThunk);
        auto* names = descriptor->OriginalFirstThunk != 0
                          ? reinterpret_cast<IMAGE_THUNK_DATA*>(
                                base + descriptor->OriginalFirstThunk)
                          : nullptr;
        for (size_t i = 0; first[i].u1.Function != 0; ++i) {
            bool match = false;
            if (names != nullptr &&
                !IMAGE_SNAP_BY_ORDINAL(names[i].u1.Ordinal)) {
                const auto* by_name =
                    reinterpret_cast<const IMAGE_IMPORT_BY_NAME*>(
                        base + names[i].u1.AddressOfData);
                match = _stricmp(reinterpret_cast<const char*>(by_name->Name),
                                 wanted) == 0;
            }
            void** slot = reinterpret_cast<void**>(&first[i].u1.Function);
            if (!match && original != nullptr && *slot == original) {
                match = true;
            }
            if (!match) {
                continue;
            }
            bool known = false;
            for (void** existing : slots) {
                if (existing == slot) {
                    known = true;
                    break;
                }
            }
            if (known) {
                continue;
            }
            DWORD old_protect = 0;
            if (!VirtualProtect(slot, sizeof(void*), PAGE_READWRITE,
                                &old_protect)) {
                continue;
            }
            *slot = reinterpret_cast<void*>(hook);
            VirtualProtect(slot, sizeof(void*), old_protect, &old_protect);
            slots.push_back(slot);
            ++patched;
        }
    }
    return patched;
}

HANDLE WINAPI HookedCreateFileW(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES,
                                DWORD, DWORD, HANDLE);
HMODULE WINAPI HookedLoadLibraryExW(LPCWSTR, HANDLE, DWORD);
HMODULE WINAPI HookedLoadLibraryExA(LPCSTR, HANDLE, DWORD);
HMODULE WINAPI HookedLoadLibraryW(LPCWSTR);
HMODULE WINAPI HookedLoadLibraryA(LPCSTR);
DWORD WINAPI HookedGetFileAttributesW(LPCWSTR);
BOOL WINAPI HookedGetFileAttributesExW(LPCWSTR, GET_FILEEX_INFO_LEVELS, LPVOID);
HANDLE WINAPI HookedCreateFile2(LPCWSTR, DWORD, DWORD, DWORD,
                                const CREATEFILE2_EXTENDED_PARAMETERS*);
BOOL WINAPI HookedGetFileInformationByName(LPCWSTR, int, PVOID, ULONG);
void WINAPI HookedExitProcess(UINT);
BOOL WINAPI HookedTerminateProcess(HANDLE, UINT);

// The path Node/Electron should see instead of the logical one, or nullptr.
// package.json is gated: the boot verifier must get the file that is really on
// disk (its hash is signed in application.json), Node gets our copy afterwards.
const wchar_t* RedirectedPath(const wchar_t* file_name) {
    if (file_name == nullptr) {
        return nullptr;
    }
    if (EndsWithPath(file_name, L"resources\\app\\app.main.js")) {
        return g_target_main.c_str();
    }
    if (g_package_redirect_armed.load(std::memory_order_relaxed) &&
        EndsWithPath(file_name, L"resources\\app\\package.json")) {
        return g_target_package.c_str();
    }
    return nullptr;
}

int PatchCreateFile(HMODULE module) {
    if (g_real_create == nullptr) {
        return 0;
    }
    return PatchImport(module, "CreateFileW", &HookedCreateFileW,
                       reinterpret_cast<void*>(g_real_create), g_create_slots);
}

int PatchFileApis(HMODULE module) {
    int patched = PatchCreateFile(module);
    if (g_real_attrs_w != nullptr) {
        patched += PatchImport(module, "GetFileAttributesW",
                               &HookedGetFileAttributesW,
                               reinterpret_cast<void*>(g_real_attrs_w),
                               g_attrs_slots);
    }
    if (g_real_attrs_ex_w != nullptr) {
        patched += PatchImport(module, "GetFileAttributesExW",
                               &HookedGetFileAttributesExW,
                               reinterpret_cast<void*>(g_real_attrs_ex_w),
                               g_attrs_ex_slots);
    }
    // Node can query the same path through CreateFile2 rather than CreateFileW,
    // so the redirect has to cover both or the boot main looks like it is absent.
    if (g_real_create2 != nullptr) {
        patched += PatchImport(module, "CreateFile2", &HookedCreateFile2,
                               reinterpret_cast<void*>(g_real_create2),
                               g_create2_slots);
    }
    // QQ/Electron may stat a boot file without opening it. NapCat covers this
    // API too; without it a new client that switches from GetFileAttributesExW
    // to this path would see the real app.main.js (which does not exist).
    if (g_real_info_by_name != nullptr) {
        patched += PatchImport(
            module, "GetFileInformationByName", &HookedGetFileInformationByName,
            reinterpret_cast<void*>(g_real_info_by_name), g_info_by_name_slots);
    }
    return patched;
}

// Diagnostics: who asked the process to stop. ExitProcess/TerminateProcess are
// patched and restored like the rest, and only ever log and pass through.
int PatchExitApis(HMODULE module) {
    int patched = 0;
    if (g_real_exit != nullptr) {
        patched += PatchImport(module, "ExitProcess", &HookedExitProcess,
                               reinterpret_cast<void*>(g_real_exit),
                               g_exit_slots);
    }
    if (g_real_terminate != nullptr) {
        patched += PatchImport(module, "TerminateProcess",
                               &HookedTerminateProcess,
                               reinterpret_cast<void*>(g_real_terminate),
                               g_terminate_slots);
    }
    return patched;
}

// Everything this DLL wants from one module: the boot redirect always, the exit
// logging only while --trace asked for it.
int PatchModule(HMODULE module) {
    int patched = PatchFileApis(module);
    if (g_trace.load(std::memory_order_relaxed)) {
        patched += PatchExitApis(module);
    }
    return patched;
}

bool UnderInstallDir(const std::wstring& path) {
    if (g_install_dir.empty() || path.size() < g_install_dir.size()) {
        return false;
    }
    for (size_t i = 0; i < g_install_dir.size(); ++i) {
        if (LowerAscii(path[i]) != LowerAscii(g_install_dir[i])) {
            return false;
        }
    }
    return true;
}

void PatchModuleLoaded(HMODULE module) {
    if (module == nullptr || module == g_module) {
        return;
    }
    if (g_modules_patched.load(std::memory_order_relaxed) > 64) {
        return;
    }
    wchar_t name[MAX_PATH * 4] = {};
    const DWORD length = GetModuleFileNameW(module, name, _countof(name));
    if (length == 0 || length >= _countof(name)) {
        return;
    }
    const std::wstring path(name, length);
    if (!UnderInstallDir(path)) {
        if (g_trace.load(std::memory_order_relaxed)) {
            TraceApi(L"skip module (outside install dir)", path.c_str());
        }
        return;
    }
    const int patched = PatchModule(module);
    if (patched <= 0) {
        return;
    }
    g_modules_patched.fetch_add(1, std::memory_order_relaxed);
    WriteLog(L"patched " + path + L" (" + std::to_wstring(patched) + L" slots)");
}

void PatchLoaders(HMODULE module) {
    if (g_real_load_w != nullptr) {
        PatchImport(module, "LoadLibraryExW", &HookedLoadLibraryExW,
                    reinterpret_cast<void*>(g_real_load_w), g_load_w_slots);
    }
    if (g_real_load_a != nullptr) {
        PatchImport(module, "LoadLibraryExA", &HookedLoadLibraryExA,
                    reinterpret_cast<void*>(g_real_load_a), g_load_a_slots);
    }
    if (g_real_load_plain_w != nullptr) {
        PatchImport(module, "LoadLibraryW", &HookedLoadLibraryW,
                    reinterpret_cast<void*>(g_real_load_plain_w),
                    g_plain_load_w_slots);
    }
    if (g_real_load_plain_a != nullptr) {
        PatchImport(module, "LoadLibraryA", &HookedLoadLibraryA,
                    reinterpret_cast<void*>(g_real_load_plain_a),
                    g_plain_load_a_slots);
    }
}

HANDLE WINAPI HookedCreateFileW(LPCWSTR file_name, DWORD access, DWORD share,
                                LPSECURITY_ATTRIBUTES security,
                                DWORD disposition, DWORD flags,
                                HANDLE template_file) {
    HookGuard guard;
    if (guard.reentrant) {
        return g_real_create(file_name, access, share, security, disposition,
                             flags, template_file);
    }
    TraceApi(L"CreateFileW", file_name);
    if (file_name != nullptr) {
        if (EndsWithPath(file_name, L"resources\\app\\app.main.js")) {
            if (!g_main_served.exchange(true)) {
                WriteLog("create: app.main.js -> app.main.js");
            }
            return g_real_create(g_target_main.c_str(), access, share, security,
                                 disposition, flags, template_file);
        }
        if (EndsWithPath(file_name, L"resources\\app\\package.json")) {
            if (!g_package_redirect_armed.exchange(true)) {
                // The verifier's read: hand it the file that is really on disk.
                if (!g_package_served.exchange(true)) {
                    WriteLog("create: package.json verifier read passed through");
                }
                return g_real_create(file_name, access, share, security,
                                     disposition, flags, template_file);
            }
            if (!g_package_redirect_logged.exchange(true)) {
                WriteLog("create: package.json -> app.package.json (armed)");
            }
            return g_real_create(g_target_package.c_str(), access, share,
                                 security, disposition, flags, template_file);
        }
    }
    return g_real_create(file_name, access, share, security, disposition, flags,
                         template_file);
}

DWORD WINAPI HookedGetFileAttributesW(LPCWSTR file_name) {
    HookGuard guard;
    if (guard.reentrant) {
        return g_real_attrs_w(file_name);
    }
    TraceApi(L"GetFileAttributesW", file_name);
    const wchar_t* target = RedirectedPath(file_name);
    return g_real_attrs_w(target != nullptr ? target : file_name);
}

BOOL WINAPI HookedGetFileAttributesExW(LPCWSTR file_name,
                                       GET_FILEEX_INFO_LEVELS level,
                                       LPVOID info) {
    HookGuard guard;
    if (guard.reentrant) {
        return g_real_attrs_ex_w(file_name, level, info);
    }
    TraceApi(L"GetFileAttributesExW", file_name);
    const wchar_t* target = RedirectedPath(file_name);
    return g_real_attrs_ex_w(target != nullptr ? target : file_name, level, info);
}

HANDLE WINAPI HookedCreateFile2(LPCWSTR file_name, DWORD access, DWORD share,
                                DWORD disposition,
                                const CREATEFILE2_EXTENDED_PARAMETERS* params) {
    HookGuard guard;
    if (guard.reentrant) {
        return g_real_create2(file_name, access, share, disposition, params);
    }
    TraceApi(L"CreateFile2", file_name);
    const wchar_t* target = RedirectedPath(file_name);
    return g_real_create2(target != nullptr ? target : file_name, access, share,
                          disposition, params);
}

BOOL WINAPI HookedGetFileInformationByName(LPCWSTR file_name, int info_class,
                                           PVOID info, ULONG info_size) {
    HookGuard guard;
    if (guard.reentrant) {
        return g_real_info_by_name(file_name, info_class, info, info_size);
    }
    TraceApi(L"GetFileInformationByName", file_name);
    const wchar_t* target = RedirectedPath(file_name);
    return g_real_info_by_name(target != nullptr ? target : file_name, info_class,
                               info, info_size);
}

void WINAPI HookedExitProcess(UINT code) {
    const int count = g_exit_logged.fetch_add(1, std::memory_order_relaxed);
    if (count < 8) {
        WriteLog(L"ExitProcess code=" + std::to_wstring(code) + L" from " +
                 CallerAt(_ReturnAddress()));
    }
    g_real_exit(code);
}

BOOL WINAPI HookedTerminateProcess(HANDLE process, UINT code) {
    const int count = g_exit_logged.fetch_add(1, std::memory_order_relaxed);
    const HANDLE self = GetCurrentProcess();
    if (count < 8 && (process == self || process == nullptr)) {
        WriteLog(L"TerminateProcess on itself, code=" + std::to_wstring(code) +
                 L" from " + CallerAt(_ReturnAddress()));
    }
    return g_real_terminate(process, code);
}

HMODULE WINAPI HookedLoadLibraryExW(LPCWSTR name, HANDLE file, DWORD flags) {
    HookGuard guard;
    HMODULE module = g_real_load_w(name, file, flags);
    if (!guard.reentrant) {
        TraceApi(L"LoadLibraryExW", name);
        if (module != nullptr) {
            PatchModuleLoaded(module);
        }
    }
    return module;
}

HMODULE WINAPI HookedLoadLibraryExA(LPCSTR name, HANDLE file, DWORD flags) {
    HookGuard guard;
    HMODULE module = g_real_load_a(name, file, flags);
    if (!guard.reentrant) {
        TraceApi(L"LoadLibraryExA", nullptr);
        if (module != nullptr) {
            PatchModuleLoaded(module);
        }
    }
    return module;
}

HMODULE WINAPI HookedLoadLibraryW(LPCWSTR name) {
    HookGuard guard;
    HMODULE module = g_real_load_plain_w(name);
    if (!guard.reentrant) {
        TraceApi(L"LoadLibraryW", name);
        if (module != nullptr) {
            PatchModuleLoaded(module);
        }
    }
    return module;
}

HMODULE WINAPI HookedLoadLibraryA(LPCSTR name) {
    HookGuard guard;
    HMODULE module = g_real_load_plain_a(name);
    if (!guard.reentrant) {
        TraceApi(L"LoadLibraryA", nullptr);
        if (module != nullptr) {
            PatchModuleLoaded(module);
        }
    }
    return module;
}

void RestoreSlots(std::vector<void**>& slots, void* real) {
    std::vector<void**> local;
    {
        std::lock_guard<std::mutex> lock(g_patch_mutex);
        local.swap(slots);
    }
    for (void** slot : local) {
        if (real != nullptr && *slot != real) {
            DWORD old_protect = 0;
            if (!VirtualProtect(slot, sizeof(void*), PAGE_READWRITE,
                                &old_protect)) {
                continue;
            }
            *slot = real;
            VirtualProtect(slot, sizeof(void*), old_protect, &old_protect);
        }
    }
}

void RestoreAll() {
    RestoreSlots(g_plain_load_w_slots,
                 reinterpret_cast<void*>(g_real_load_plain_w));
    RestoreSlots(g_plain_load_a_slots,
                 reinterpret_cast<void*>(g_real_load_plain_a));
    RestoreSlots(g_load_w_slots, reinterpret_cast<void*>(g_real_load_w));
    RestoreSlots(g_load_a_slots, reinterpret_cast<void*>(g_real_load_a));
    RestoreSlots(g_attrs_ex_slots, reinterpret_cast<void*>(g_real_attrs_ex_w));
    RestoreSlots(g_attrs_slots, reinterpret_cast<void*>(g_real_attrs_w));
    RestoreSlots(g_create2_slots, reinterpret_cast<void*>(g_real_create2));
    RestoreSlots(g_info_by_name_slots,
                 reinterpret_cast<void*>(g_real_info_by_name));
    RestoreSlots(g_create_slots, reinterpret_cast<void*>(g_real_create));
    RestoreSlots(g_exit_slots, reinterpret_cast<void*>(g_real_exit));
    RestoreSlots(g_terminate_slots, reinterpret_cast<void*>(g_real_terminate));
    WriteLog("hooks restored");
}

DWORD WINAPI WatchThread(LPVOID) {
    const ULONGLONG start = GetTickCount64();
    int qqnt_slots = 0;
    while (!g_main_served.load(std::memory_order_relaxed) &&
           GetTickCount64() - start < 60000) {
        HMODULE qqnt = GetModuleHandleW(L"QQNT.dll");
        if (qqnt != nullptr && qqnt_slots == 0) {
            qqnt_slots = PatchModule(qqnt);
            if (qqnt_slots > 0) {
                WriteLogUtf8("watch: patched QQNT.dll (" +
                             std::to_string(qqnt_slots) + " slots)");
            }
        }
        Sleep(qqnt_slots > 0 ? 100 : 20);
    }

    if (g_main_served.load()) {
        // Give Electron a moment to finish reading other boot files before the
        // import slots go back to the real functions.
        Sleep(3000);
    } else {
        WriteLog("timeout: app.main.js was not requested");
    }

    RestoreAll();
    // A thread may have loaded a patched pointer just before the restore.
    // Give it time to enter (and be counted), then wait for all hooks to leave.
    Sleep(300);
    bool idle = false;
    for (int i = 0; i < 200 && !idle; ++i) {
        idle = g_in_hook.load(std::memory_order_relaxed) == 0;
        if (!idle) {
            Sleep(20);
        }
    }
    if (!idle) {
        // Never unmap code a thread may still be executing; a resident module
        // is better than a crash. This has not happened in testing.
        WriteLog("hook still in flight; appinit.dll stays loaded");
        return 0;
    }
    WriteLog("unloading appinit.dll");
    FreeLibraryAndExitThread(g_module, 0);
    return 0;
}

}  // namespace

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
    if (reason != DLL_PROCESS_ATTACH) {
        return TRUE;
    }
    g_module = module;
    DisableThreadLibraryCalls(module);

    g_dll_dir = ModuleDirectory();
    g_target_package = g_dll_dir + L"\\app.package.json";
    g_target_main = g_dll_dir + L"\\app.main.js";
    g_log_path = g_dll_dir + L"\\appinit.log";

    wchar_t self[MAX_PATH * 4] = {};
    const DWORD self_length = GetModuleFileNameW(nullptr, self, _countof(self));
    if (self_length > 0 && self_length < _countof(self)) {
        std::wstring exe_path(self, self_length);
        const size_t slash = exe_path.find_last_of(L"\\/");
        if (slash != std::wstring::npos) {
            g_install_dir = exe_path.substr(0, slash);
        }
    }

    // Optional hook-by-hook tracing, requested by scripts/headless_launch.js
    // --trace through a sentinel file so the DLL needs no environment block.
    if (GetFileAttributesW((g_dll_dir + L"\\appinit.trace").c_str()) !=
        INVALID_FILE_ATTRIBUTES) {
        g_trace.store(true, std::memory_order_relaxed);
    }

    if (GetFileAttributesW(g_target_package.c_str()) == INVALID_FILE_ATTRIBUTES ||
        GetFileAttributesW(g_target_main.c_str()) == INVALID_FILE_ATTRIBUTES) {
        WriteLog("missing app.package.json or app.main.js; boot redirect disabled");
        return TRUE;
    }

    const HMODULE kernel32 = GetModuleHandleW(L"kernel32.dll");
    if (kernel32 == nullptr) {
        return TRUE;
    }
    g_real_create = reinterpret_cast<CreateFileWFn>(
        GetProcAddress(kernel32, "CreateFileW"));
    g_real_load_w = reinterpret_cast<LoadLibraryExWFn>(
        GetProcAddress(kernel32, "LoadLibraryExW"));
    g_real_load_a = reinterpret_cast<LoadLibraryExAFn>(
        GetProcAddress(kernel32, "LoadLibraryExA"));
    g_real_load_plain_w = reinterpret_cast<LoadLibraryWFn>(
        GetProcAddress(kernel32, "LoadLibraryW"));
    g_real_load_plain_a = reinterpret_cast<LoadLibraryAFn>(
        GetProcAddress(kernel32, "LoadLibraryA"));
    g_real_attrs_w = reinterpret_cast<GetFileAttributesWFn>(
        GetProcAddress(kernel32, "GetFileAttributesW"));
    g_real_attrs_ex_w = reinterpret_cast<GetFileAttributesExWFn>(
        GetProcAddress(kernel32, "GetFileAttributesExW"));
    g_real_create2 = reinterpret_cast<CreateFile2Fn>(
        GetProcAddress(kernel32, "CreateFile2"));
    g_real_info_by_name = reinterpret_cast<GetFileInformationByNameFn>(
        GetProcAddress(kernel32, "GetFileInformationByName"));
    g_real_exit = reinterpret_cast<ExitProcessFn>(
        GetProcAddress(kernel32, "ExitProcess"));
    g_real_terminate = reinterpret_cast<TerminateProcessFn>(
        GetProcAddress(kernel32, "TerminateProcess"));
    if (g_real_create == nullptr) {
        WriteLog("CreateFileW not resolved");
        return TRUE;
    }

    HMODULE main_module = GetModuleHandleW(nullptr);
    PatchModule(main_module);
    PatchLoaders(main_module);
    {
        HMODULE qqnt = GetModuleHandleW(L"QQNT.dll");
        if (qqnt != nullptr) {
            PatchModule(qqnt);
        }
    }
    WriteLogUtf8("appinit attached; create slots=" +
                 std::to_string(g_create_slots.size() + g_create2_slots.size()) +
                 " (w=" + std::to_string(g_create_slots.size()) +
                 " create2=" + std::to_string(g_create2_slots.size()) +
                 ") attrs slots=" +
                 std::to_string(g_attrs_slots.size() + g_attrs_ex_slots.size()) +
                 " info-name slots=" + std::to_string(g_info_by_name_slots.size()) +
                 " loader slots=" +
                 std::to_string(g_load_w_slots.size() + g_load_a_slots.size() +
                                g_plain_load_w_slots.size() +
                                g_plain_load_a_slots.size()) +
                 " exit slots=" +
                 std::to_string(g_exit_slots.size() + g_terminate_slots.size()) +
                 " trace=" + std::to_string(g_trace.load() ? 1 : 0));

    const HANDLE thread =
        CreateThread(nullptr, 0, WatchThread, nullptr, 0, nullptr);
    if (thread != nullptr) {
        CloseHandle(thread);
    }
    return TRUE;
}
