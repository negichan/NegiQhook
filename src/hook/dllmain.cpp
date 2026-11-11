// Injected side of the PoC: a tiny named-pipe server living inside the target
// process. It deliberately does no QQ-specific work yet; it only proves that
// code can run in-process and talk to the injector.
#include "../common/pipe_protocol.h"

#include <shellapi.h>
#include <tlhelp32.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

namespace {

HMODULE g_module = nullptr;
std::atomic<bool> g_unloading{false};

std::string WideToUtf8(const std::wstring& text) {
    if (text.empty()) {
        return {};
    }
    const int size = WideCharToMultiByte(CP_UTF8, 0, text.data(),
                                         static_cast<int>(text.size()), nullptr, 0,
                                         nullptr, nullptr);
    if (size <= 0) {
        return {};
    }
    std::string result(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                        result.data(), size, nullptr, nullptr);
    return result;
}

std::string JsonEscape(const std::string& text) {
    std::string out;
    out.reserve(text.size() + 8);
    for (char c : text) {
        switch (c) {
            case '\\': out += "\\\\"; break;
            case '"': out += "\\\""; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8] = {};
                    snprintf(buf, sizeof(buf), "\\u%04x",
                             static_cast<unsigned>(static_cast<unsigned char>(c)));
                    out += buf;
                } else {
                    out.push_back(c);
                }
        }
    }
    return out;
}

std::string Trim(std::string text) {
    while (!text.empty() &&
           (text.back() == '\r' || text.back() == '\n' || text.back() == ' ' ||
            text.back() == '\t')) {
        text.pop_back();
    }
    size_t start = 0;
    while (start < text.size() &&
           (text[start] == ' ' || text[start] == '\t')) {
        ++start;
    }
    return text.substr(start);
}

bool Base64Decode(const std::string& input, std::string& output) {
    static const char kTable[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    int lookup[256];
    for (int& slot : lookup) {
        slot = -1;
    }
    for (int i = 0; i < 64; ++i) {
        lookup[static_cast<unsigned char>(kTable[i])] = i;
    }

    output.clear();
    output.reserve(input.size() * 3 / 4 + 4);
    int value = 0;
    int bits = -8;
    for (const char raw : input) {
        const unsigned char c = static_cast<unsigned char>(raw);
        if (c == '=') {
            break;
        }
        if (lookup[c] < 0) {
            if (c == ' ' || c == '\r' || c == '\n' || c == '\t') {
                continue;
            }
            return false;
        }
        value = (value << 6) + lookup[c];
        bits += 6;
        if (bits >= 0) {
            output.push_back(static_cast<char>((value >> bits) & 0xFF));
            bits -= 8;
        }
    }
    return true;
}

std::string LowerAscii(std::string text) {
    for (char& c : text) {
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }
    return text;
}

std::string ExecutablePath() {
    wchar_t buffer[MAX_PATH * 4] = {};
    const DWORD length = GetModuleFileNameW(nullptr, buffer, _countof(buffer));
    if (length == 0) {
        return {};
    }
    return WideToUtf8(std::wstring(buffer, length));
}

struct ModuleInfo {
    std::wstring name;
    uintptr_t base = 0;
    uint32_t size = 0;
};

std::vector<ModuleInfo> SnapshotModules() {
    std::vector<ModuleInfo> modules;
    const HANDLE snapshot =
        CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32,
                                 GetCurrentProcessId());
    if (snapshot == INVALID_HANDLE_VALUE) {
        return modules;
    }

    MODULEENTRY32W entry = {};
    entry.dwSize = sizeof(entry);
    if (Module32FirstW(snapshot, &entry)) {
        do {
            ModuleInfo info;
            info.name = entry.szModule;
            info.base = reinterpret_cast<uintptr_t>(entry.modBaseAddr);
            info.size = entry.modBaseSize;
            modules.push_back(std::move(info));
        } while (Module32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return modules;
}

std::string FormatModuleLine(const ModuleInfo& module) {
    char buffer[512] = {};
    snprintf(buffer, sizeof(buffer), "base=0x%llx size=0x%x name=%s",
             static_cast<unsigned long long>(module.base),
             static_cast<unsigned>(module.size),
             WideToUtf8(module.name).c_str());
    return std::string(buffer);
}

std::string HandleInfo() {
    const std::vector<ModuleInfo> modules = SnapshotModules();
    const ModuleInfo* wrapper = nullptr;
    for (const ModuleInfo& module : modules) {
        if (LowerAscii(WideToUtf8(module.name)).find("wrapper") != std::string::npos) {
            wrapper = &module;
            break;
        }
    }

    std::string out;
    out += "{\"pid\":";
    out += std::to_string(static_cast<unsigned long>(GetCurrentProcessId()));
    out += ",\"exe\":\"";
    out += JsonEscape(ExecutablePath());
    out += "\",\"module_count\":";
    out += std::to_string(modules.size());
    out += ",\"uptime_ms\":";
    out += std::to_string(static_cast<unsigned long long>(GetTickCount64()));
    out += ",\"wrapper\":";
    if (wrapper != nullptr) {
        out += "{\"name\":\"";
        out += JsonEscape(WideToUtf8(wrapper->name));
        out += "\",\"base\":\"0x";
        char base[32] = {};
        snprintf(base, sizeof(base), "%llx",
                 static_cast<unsigned long long>(wrapper->base));
        out += base;
        out += "\",\"size\":";
        out += std::to_string(wrapper->size);
        out += "}";
    } else {
        out += "null";
    }
    out += "}";
    return out;
}

struct WindowEnumContext {
    DWORD pid = 0;
    std::string out;
};

BOOL CALLBACK CollectWindowCallback(HWND window, LPARAM lparam) {
    auto* context = reinterpret_cast<WindowEnumContext*>(lparam);
    DWORD pid = 0;
    const DWORD tid = GetWindowThreadProcessId(window, &pid);
    if (pid != context->pid) {
        return TRUE;
    }
    wchar_t class_name[256] = {};
    wchar_t title[512] = {};
    GetClassNameW(window, class_name, _countof(class_name));
    GetWindowTextW(window, title, _countof(title));
    char line[1200] = {};
    snprintf(line, sizeof(line),
             "hwnd=0x%llx tid=%lu visible=%d class=%s title=%s\n",
             static_cast<unsigned long long>(
                 reinterpret_cast<uintptr_t>(window)),
             static_cast<unsigned long>(tid), IsWindowVisible(window) ? 1 : 0,
             WideToUtf8(class_name).c_str(), WideToUtf8(title).c_str());
    context->out += line;
    return TRUE;
}

std::string HandleWindows() {
    WindowEnumContext context;
    context.pid = GetCurrentProcessId();
    EnumWindows(CollectWindowCallback, reinterpret_cast<LPARAM>(&context));
    return context.out.empty() ? "no top-level windows" : context.out;
}

struct ThreadRow {
    DWORD tid = 0;
    unsigned long long created = 0;
};

std::string HandleThreads() {
    std::vector<ThreadRow> rows;
    const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snapshot == INVALID_HANDLE_VALUE) {
        return "thread snapshot failed";
    }
    THREADENTRY32 entry = {};
    entry.dwSize = sizeof(entry);
    if (Thread32First(snapshot, &entry)) {
        do {
            if (entry.th32OwnerProcessID != GetCurrentProcessId()) {
                continue;
            }
            unsigned long long created = 0;
            const HANDLE thread = OpenThread(THREAD_QUERY_LIMITED_INFORMATION,
                                             FALSE, entry.th32ThreadID);
            if (thread != nullptr) {
                FILETIME creation = {};
                FILETIME exit = {};
                FILETIME kernel = {};
                FILETIME user = {};
                if (GetThreadTimes(thread, &creation, &exit, &kernel, &user)) {
                    ULARGE_INTEGER value = {};
                    value.LowPart = creation.dwLowDateTime;
                    value.HighPart = creation.dwHighDateTime;
                    created = value.QuadPart;
                }
                CloseHandle(thread);
            }
            ThreadRow row;
            row.tid = entry.th32ThreadID;
            row.created = created;
            rows.push_back(row);
        } while (Thread32Next(snapshot, &entry));
    }
    CloseHandle(snapshot);

    std::sort(rows.begin(), rows.end(),
              [](const ThreadRow& left, const ThreadRow& right) {
                  return left.created < right.created;
              });
    std::string out;
    for (const ThreadRow& row : rows) {
        char line[128] = {};
        snprintf(line, sizeof(line), "tid=%lu created=%llu\n",
                 static_cast<unsigned long>(row.tid), row.created);
        out += line;
        if (out.size() > poc::kMaxFrameBytes - 1024) {
            break;
        }
    }
    return out.empty() ? "no threads" : out;
}

std::string HandleModules(const std::string& filter) {
    const std::string needle = LowerAscii(filter);
    std::string out;
    for (const ModuleInfo& module : SnapshotModules()) {
        const std::string name = WideToUtf8(module.name);
        if (!needle.empty() && LowerAscii(name).find(needle) == std::string::npos) {
            continue;
        }
        out += FormatModuleLine(module);
        out += '\n';
        if (out.size() > poc::kMaxFrameBytes - 1024) {
            out += "... (truncated)\n";
            break;
        }
    }
    if (out.empty()) {
        out = "no matching modules\n";
    }
    return out;
}

void AppendLog(const std::string& line) {
    wchar_t temp[MAX_PATH] = {};
    if (GetTempPathW(_countof(temp), temp) == 0) {
        return;
    }
    wchar_t path[MAX_PATH] = {};
    swprintf_s(path, L"%sqqhookpoc_%lu.log", temp,
               static_cast<unsigned long>(GetCurrentProcessId()));
    const HANDLE file = CreateFileW(path, FILE_APPEND_DATA,
                                    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                                    OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return;
    }
    const std::string text = line + "\r\n";
    DWORD written = 0;
    WriteFile(file, text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
    CloseHandle(file);
}

// ---------------------------------------------------------------------------
// Minimal V8 bridge probe.
//
// QQNT.dll exports the Node/V8 C++ API. We resolve just enough of it to run a
// script on the target's main thread. This is intentionally a probe: it only
// writes a temp file, so a failure cannot alter QQ state.
// ---------------------------------------------------------------------------
namespace v8mini {

class Isolate;
class Context;
class String;
class Script;
class Value;

template <typename T>
struct Local {
    T* ptr;
};

template <typename T>
struct MaybeLocal {
    T* ptr;
};

enum NewStringType {
    kNormal = 0,
    kInternalized = 1,
};

// MSVC returns Local/MaybeLocal through a hidden return pointer (sret),
// because V8_TRIVIAL_ABI is a clang attribute. All handle-returning exports
// are therefore declared with an explicit first out-parameter.
using GetCurrentIsolateFn = Isolate* (*)();
// Member functions put `this` in RCX and the hidden return buffer in RDX.
using GetContextFn = void (*)(Isolate* self, Local<Context>* out);
using NewStringFn = void (*)(MaybeLocal<String>* out, Isolate*,
                             const char*, int, int);
using CompileFn = void (*)(MaybeLocal<Script>* out, Local<Context>,
                           Local<String>, void*);
using RunFn = void (*)(Script* self, MaybeLocal<Value>* out,
                       Local<Context>);
using ValueToStringFn = void (*)(Value* self, MaybeLocal<String>* out,
                                 Local<Context>);
using Utf8LengthFn = size_t (*)(String* self, Isolate*);
using WriteUtf8Fn = size_t (*)(String* self, Isolate*, char*, size_t, int,
                               size_t*);
using HandleScopeCtorFn = void (*)(void*, Isolate*);
using HandleScopeDtorFn = void (*)(void*);

struct Api {
    GetCurrentIsolateFn get_current_isolate = nullptr;
    GetContextFn get_entered_context = nullptr;
    GetContextFn get_current_context = nullptr;
    GetContextFn get_incumbent_context = nullptr;
    NewStringFn new_string = nullptr;
    CompileFn compile = nullptr;
    RunFn run = nullptr;
    ValueToStringFn value_to_string = nullptr;
    Utf8LengthFn utf8_length = nullptr;
    WriteUtf8Fn write_utf8 = nullptr;
    HandleScopeCtorFn scope_ctor = nullptr;
    HandleScopeDtorFn scope_dtor = nullptr;
};

template <typename T>
T ResolveExport(HMODULE module, const char* name) {
    return reinterpret_cast<T>(
        reinterpret_cast<void*>(GetProcAddress(module, name)));
}

bool LoadApi(Api& api, std::string& detail) {
    HMODULE module = GetModuleHandleW(L"QQNT.dll");
    if (module == nullptr) {
        // Node testbed fallback: node.exe exports the same V8 surface.
        module = GetModuleHandleW(nullptr);
    }
    if (module == nullptr) {
        detail = "QQNT.dll not loaded";
        return false;
    }

    wchar_t module_name[MAX_PATH] = {};
    GetModuleFileNameW(module, module_name, _countof(module_name));
    char base[32] = {};
    snprintf(base, sizeof(base), "0x%llx",
             static_cast<unsigned long long>(
                 reinterpret_cast<uintptr_t>(module)));
    detail = std::string("module=") + WideToUtf8(module_name) + " base=" + base;

    auto missing = [&detail](const char* name) {
        detail += " missing:";
        detail += name;
    };

    api.get_current_isolate = ResolveExport<GetCurrentIsolateFn>(
        module, "?GetCurrent@Isolate@v8@@SAPEAV12@XZ");
    if (api.get_current_isolate == nullptr) {
        missing("v8::Isolate::GetCurrent");
    }
    api.get_entered_context = ResolveExport<GetContextFn>(
        module,
        "?GetEnteredOrMicrotaskContext@Isolate@v8@@QEAA?AV?$Local@VContext@v8@@@2@XZ");
    if (api.get_entered_context == nullptr) {
        missing("GetEnteredOrMicrotaskContext");
    }
    api.get_current_context = ResolveExport<GetContextFn>(
        module,
        "?GetCurrentContext@Isolate@v8@@QEAA?AV?$Local@VContext@v8@@@2@XZ");
    if (api.get_current_context == nullptr) {
        missing("GetCurrentContext");
    }
    api.get_incumbent_context = ResolveExport<GetContextFn>(
        module,
        "?GetIncumbentContext@Isolate@v8@@QEAA?AV?$Local@VContext@v8@@@2@XZ");
    if (api.get_incumbent_context == nullptr) {
        missing("GetIncumbentContext");
    }
    api.new_string = ResolveExport<NewStringFn>(
        module,
        "?NewFromUtf8@String@v8@@SA?AV?$MaybeLocal@VString@v8@@@2@PEAVIsolate@2@PEBDW4NewStringType@2@H@Z");
    if (api.new_string == nullptr) {
        missing("String::NewFromUtf8");
    }
    api.compile = ResolveExport<CompileFn>(
        module,
        "?Compile@Script@v8@@SA?AV?$MaybeLocal@VScript@v8@@@2@V?$Local@VContext@v8@@@2@V?$Local@VString@v8@@@2@PEAVScriptOrigin@2@@Z");
    if (api.compile == nullptr) {
        missing("Script::Compile");
    }
    api.run = ResolveExport<RunFn>(
        module,
        "?Run@Script@v8@@QEAA?AV?$MaybeLocal@VValue@v8@@@2@V?$Local@VContext@v8@@@2@@Z");
    if (api.run == nullptr) {
        missing("Script::Run");
    }
    api.value_to_string = ResolveExport<ValueToStringFn>(
        module,
        "?ToString@Value@v8@@QEBA?AV?$MaybeLocal@VString@v8@@@2@V?$Local@VContext@v8@@@2@@Z");
    if (api.value_to_string == nullptr) {
        missing("Value::ToString");
    }
    api.utf8_length = ResolveExport<Utf8LengthFn>(
        module,
        "?Utf8LengthV2@String@v8@@QEBA_KPEAVIsolate@2@@Z");
    if (api.utf8_length == nullptr) {
        missing("String::Utf8LengthV2");
    }
    api.write_utf8 = ResolveExport<WriteUtf8Fn>(
        module,
        "?WriteUtf8V2@String@v8@@QEBA_KPEAVIsolate@2@PEAD_KHPEA_K@Z");
    if (api.write_utf8 == nullptr) {
        missing("String::WriteUtf8V2");
    }
    api.scope_ctor = ResolveExport<HandleScopeCtorFn>(
        module, "??0HandleScope@v8@@QEAA@PEAVIsolate@1@@Z");
    if (api.scope_ctor == nullptr) {
        missing("HandleScope ctor");
    }
    api.scope_dtor = ResolveExport<HandleScopeDtorFn>(
        module, "??1HandleScope@v8@@QEAA@XZ");
    if (api.scope_dtor == nullptr) {
        missing("HandleScope dtor");
    }

    detail += GetProcAddress(module, "napi_create_string_utf8") != nullptr
                  ? " napi=ok"
                  : " napi=missing";

    return api.get_current_isolate != nullptr &&
           api.get_entered_context != nullptr &&
           api.get_current_context != nullptr &&
           api.get_incumbent_context != nullptr &&
           api.new_string != nullptr && api.compile != nullptr &&
           api.run != nullptr && api.value_to_string != nullptr &&
           api.utf8_length != nullptr && api.write_utf8 != nullptr &&
           api.scope_ctor != nullptr && api.scope_dtor != nullptr;
}

}  // namespace v8mini

std::string HexPtr(const void* pointer) {
    char buffer[32] = {};
    snprintf(buffer, sizeof(buffer), "0x%llx",
             static_cast<unsigned long long>(
                 reinterpret_cast<uintptr_t>(pointer)));
    return std::string(buffer);
}

std::string ReadV8ProbeFile() {
    wchar_t temp[MAX_PATH] = {};
    if (GetTempPathW(_countof(temp), temp) == 0) {
        return {};
    }
    const std::wstring path = std::wstring(temp) + L"qqhook_v8probe.txt";
    const HANDLE file =
        CreateFileW(path.c_str(), GENERIC_READ,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return {};
    }
    char buffer[512] = {};
    DWORD read = 0;
    ReadFile(file, buffer, sizeof(buffer) - 1, &read, nullptr);
    CloseHandle(file);
    std::string result(buffer, read);
    while (!result.empty() &&
           (result.back() == '\r' || result.back() == '\n' || result.back() == ' ')) {
        result.pop_back();
    }
    return result;
}

std::string ExecuteV8Script(v8mini::Api& api, const char* source) {
    v8mini::Isolate* isolate = api.get_current_isolate();
    if (isolate == nullptr) {
        return "isolate=null (not on a V8 thread)";
    }
    AppendLog("v8 isolate=" + HexPtr(isolate));

    // A HandleScope must exist before V8 returns any Local handle.
    alignas(16) unsigned char scope_storage[512] = {};
    api.scope_ctor(scope_storage, isolate);

    v8mini::Local<v8mini::Context> context{nullptr};
    api.get_current_context(isolate, &context);
    std::string context_kind = "current";
    if (context.ptr == nullptr) {
        api.get_entered_context(isolate, &context);
        context_kind = "entered";
    }
    if (context.ptr == nullptr) {
        api.get_incumbent_context(isolate, &context);
        context_kind = "incumbent";
    }
    if (context.ptr == nullptr) {
        api.scope_dtor(scope_storage);
        return "context=null isolate=" + HexPtr(isolate);
    }
    AppendLog("v8 context=" + HexPtr(context.ptr) + " kind=" + context_kind);

    std::string detail;
    v8mini::MaybeLocal<v8mini::String> source_string{nullptr};
    api.new_string(&source_string, isolate, source, v8mini::kNormal, -1);
    if (source_string.ptr == nullptr) {
        detail = "NewFromUtf8=null";
    } else {
        v8mini::MaybeLocal<v8mini::Script> script{nullptr};
        api.compile(&script, context,
                    v8mini::Local<v8mini::String>{source_string.ptr}, nullptr);
        if (script.ptr == nullptr) {
            detail = "ERR: compile failed";
        } else {
            AppendLog("v8 script compiled, running");
            v8mini::MaybeLocal<v8mini::Value> value{nullptr};
            api.run(script.ptr, &value, context);
            if (value.ptr == nullptr) {
                detail = "ERR: script threw";
            } else {
                v8mini::MaybeLocal<v8mini::String> text{nullptr};
                api.value_to_string(value.ptr, &text, context);
                if (text.ptr == nullptr) {
                    detail = "ERR: result is not stringifiable";
                } else {
                    const size_t length = api.utf8_length(text.ptr, isolate);
                    std::string text_value(length, '\0');
                    const size_t written = api.write_utf8(
                        text.ptr, isolate, text_value.data(), length, 0, nullptr);
                    text_value.resize(written);
                    if (text_value.size() > poc::kMaxFrameBytes - 2048) {
                        text_value.resize(poc::kMaxFrameBytes - 2048);
                        text_value += "\n... (truncated)";
                    }
                    detail = text_value;
                }
            }
        }
    }

    api.scope_dtor(scope_storage);
    AppendLog("v8 result=" + detail + " context=" + HexPtr(context.ptr));
    return detail;
}

constexpr UINT kProbeMessage = WM_APP + 0x51;

std::mutex g_probe_mutex;
HANDLE g_probe_event = nullptr;
HHOOK g_probe_hook = nullptr;
std::atomic<int> g_hook_calls{0};
std::string g_probe_result;

struct WindowSearch {
    DWORD pid = 0;
    DWORD tid = 0;
    HWND window = nullptr;
    bool visible = false;
};

BOOL CALLBACK FindWindowCallback(HWND window, LPARAM lparam) {
    auto* search = reinterpret_cast<WindowSearch*>(lparam);
    DWORD pid = 0;
    const DWORD tid = GetWindowThreadProcessId(window, &pid);
    if (pid != search->pid) {
        return TRUE;
    }
    const bool visible = IsWindowVisible(window) != FALSE;
    if (search->window == nullptr || (visible && !search->visible)) {
        search->tid = tid;
        search->window = window;
        search->visible = visible;
    }
    return visible ? FALSE : TRUE;
}

WindowSearch FindMainWindow(DWORD pid) {
    WindowSearch search;
    search.pid = pid;
    EnumWindows(FindWindowCallback, reinterpret_cast<LPARAM>(&search));
    return search;
}

DWORD FindMainThread(DWORD pid) {
    const WindowSearch search = FindMainWindow(pid);
    if (search.tid != 0) {
        return search.tid;
    }

    // No top-level window (tray only, console host, etc.): fall back to the
    // oldest thread of the process, which is normally the main thread.
    const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snapshot == INVALID_HANDLE_VALUE) {
        return 0;
    }
    DWORD best = 0;
    THREADENTRY32 entry = {};
    entry.dwSize = sizeof(entry);
    if (Thread32First(snapshot, &entry)) {
        do {
            if (entry.th32OwnerProcessID == pid &&
                (best == 0 || entry.th32ThreadID < best)) {
                best = entry.th32ThreadID;
            }
        } while (Thread32Next(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return best;
}

std::string RunV8ProbeOnMainThread() {
    v8mini::Api api;
    std::string api_detail;
    if (!v8mini::LoadApi(api, api_detail)) {
        const std::string result = "V8 API not available: " + api_detail;
        AppendLog("v8probe: " + result);
        return result;
    }

    static const char* kProbeScript = R"JS((function(){
  var g = globalThis, p = g.process;
  var req = (typeof require !== 'undefined') ? require :
    (p && p.getBuiltinModule ? function(n){ return p.getBuiltinModule(n); } :
    (p && p.mainModule ? p.mainModule.require.bind(p.mainModule) : null));
  if (!req) throw new Error('no require');
  var fs = req('fs');
  var dir = (p && p.env && p.env.TEMP) ? p.env.TEMP : 'C:/Windows/Temp';
  var file = dir + '/qqhook_v8probe.txt';
  fs.writeFileSync(file, 'v8-ok node=' + p.version + ' arch=' + p.arch);
  return file;
})())JS";

    std::string result = ExecuteV8Script(api, kProbeScript);
    const std::string file = ReadV8ProbeFile();
    result += file.empty() ? " probe_file=<missing>" : " probe_file=" + file;
    AppendLog("v8probe: " + result);
    return result;
}

LRESULT CALLBACK ProbeCallWndProc(int code, WPARAM wparam, LPARAM lparam) {
    if (code >= 0 && lparam != 0) {
        const CWPSTRUCT* message = reinterpret_cast<const CWPSTRUCT*>(lparam);
        const int call_index = g_hook_calls.fetch_add(1);
        if (call_index < 5) {
            AppendLog("callwndproc msg=0x" +
                      std::to_string(static_cast<unsigned>(message->message)));
        }
        if (message->message == kProbeMessage) {
            const std::string result = RunV8ProbeOnMainThread();
            std::lock_guard<std::mutex> lock(g_probe_mutex);
            g_probe_result = result;
            if (g_probe_event != nullptr) {
                SetEvent(g_probe_event);
            }
            if (g_probe_hook != nullptr) {
                UnhookWindowsHookEx(g_probe_hook);
                g_probe_hook = nullptr;
            }
        }
    }
    return CallNextHookEx(nullptr, code, wparam, lparam);
}

std::string RequestV8Probe(DWORD requested_thread) {
    const WindowSearch window = FindMainWindow(GetCurrentProcessId());
    if (window.window == nullptr) {
        return "no top-level window to dispatch the probe";
    }
    const DWORD main_thread =
        requested_thread != 0 ? requested_thread : window.tid;
    if (main_thread == 0) {
        return "main thread not found";
    }
    if (requested_thread != 0 && requested_thread != window.tid) {
        return "thread " + std::to_string(requested_thread) +
               " does not own the main window (window tid=" +
               std::to_string(window.tid) + ")";
    }

    const HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (event == nullptr) {
        return "CreateEvent failed: " + std::to_string(GetLastError());
    }

    {
        std::lock_guard<std::mutex> lock(g_probe_mutex);
        g_probe_result.clear();
        g_probe_event = event;
    }
    g_hook_calls.store(0);

    // Same-process, thread-specific hook: hMod must be NULL.
    const HHOOK hook = SetWindowsHookExW(WH_CALLWNDPROC, ProbeCallWndProc,
                                         nullptr, main_thread);
    if (hook == nullptr) {
        const DWORD error = GetLastError();
        std::lock_guard<std::mutex> lock(g_probe_mutex);
        g_probe_event = nullptr;
        CloseHandle(event);
        return "SetWindowsHookEx failed: " + std::to_string(error);
    }
    {
        std::lock_guard<std::mutex> lock(g_probe_mutex);
        g_probe_hook = hook;
    }

    DWORD_PTR message_result = 0;
    const LRESULT sent = SendMessageTimeoutW(
        window.window, kProbeMessage, 0, 0, SMTO_ABORTIFHUNG | SMTO_BLOCK, 5000,
        &message_result);
    const DWORD send_error = sent == 0 ? GetLastError() : ERROR_SUCCESS;
    const DWORD wait = WaitForSingleObject(event, 1000);

    std::lock_guard<std::mutex> lock(g_probe_mutex);
    std::string result;
    if (wait == WAIT_OBJECT_0) {
        result = g_probe_result;
    } else {
        result = "no probe result: sent=" + std::to_string(sent) +
                 " send_error=" + std::to_string(send_error) +
                 " hook_calls=" + std::to_string(g_hook_calls.load()) +
                 " thread=" + std::to_string(main_thread) + " window=" +
                 HexPtr(window.window);
    }
    if (g_probe_hook != nullptr) {
        UnhookWindowsHookEx(g_probe_hook);
        g_probe_hook = nullptr;
    }
    g_probe_event = nullptr;
    CloseHandle(event);
    return result;
}

// ---------------------------------------------------------------------------
// libuv probe: uv_async_send is the thread-safe way to wake the event loop.
// If this callback runs, we are on the thread that owns Node's loop, which is
// also where V8 expects to be used.
// ---------------------------------------------------------------------------
namespace uvm {

using Loop = void;
using Async = void;
using AsyncCallback = void (*)(Async*);
using DefaultLoopFn = Loop* (*)();
using AsyncInitFn = int (*)(Loop*, Async*, AsyncCallback);
using AsyncSendFn = int (*)(Async*);

}  // namespace uvm

std::mutex g_uv_mutex;
HANDLE g_uv_event = nullptr;
std::string g_uv_result;
std::string g_uv_pending;
alignas(16) unsigned char g_uv_handle[1024] = {};
bool g_uv_initialized = false;
uvm::AsyncSendFn g_uv_async_send = nullptr;

std::string RunJsOnLoopThread(const std::string& code) {
    v8mini::Api api;
    std::string detail;
    if (!v8mini::LoadApi(api, detail)) {
        return "ERR: " + detail;
    }
    return ExecuteV8Script(api, code.c_str());
}

void OnUvAsync(uvm::Async*) {
    std::string code;
    {
        std::lock_guard<std::mutex> lock(g_uv_mutex);
        code.swap(g_uv_pending);
    }
    if (code.empty()) {
        return;
    }
    AppendLog("uv async callback thread=" +
              std::to_string(GetCurrentThreadId()));
    const std::string result = RunJsOnLoopThread(code);
    std::lock_guard<std::mutex> lock(g_uv_mutex);
    g_uv_result = result;
    if (g_uv_event != nullptr) {
        SetEvent(g_uv_event);
    }
}

bool EnsureUvBridge(std::string& error) {
    if (g_uv_initialized) {
        return true;
    }

    HMODULE module = GetModuleHandleW(L"QQNT.dll");
    if (module == nullptr) {
        module = GetModuleHandleW(nullptr);
    }
    if (module == nullptr) {
        error = "no module to resolve libuv from";
        return false;
    }

    const auto default_loop =
        v8mini::ResolveExport<uvm::DefaultLoopFn>(module, "uv_default_loop");
    const auto async_init =
        v8mini::ResolveExport<uvm::AsyncInitFn>(module, "uv_async_init");
    const auto async_send =
        v8mini::ResolveExport<uvm::AsyncSendFn>(module, "uv_async_send");
    if (default_loop == nullptr || async_init == nullptr ||
        async_send == nullptr) {
        error = "libuv exports missing";
        return false;
    }

    uvm::Loop* loop = default_loop();
    if (loop == nullptr) {
        error = "uv_default_loop returned null";
        return false;
    }

    memset(g_uv_handle, 0, sizeof(g_uv_handle));
    const int init_rc = async_init(
        loop, reinterpret_cast<uvm::Async*>(g_uv_handle), OnUvAsync);
    if (init_rc != 0) {
        error = "uv_async_init rc=" + std::to_string(init_rc);
        return false;
    }
    g_uv_async_send = async_send;
    g_uv_initialized = true;
    return true;
}

std::string RunJsOnLoop(const std::string& code, DWORD timeout_ms = 5000) {
    std::string error;
    if (!EnsureUvBridge(error)) {
        return "ERR: " + error;
    }

    const HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (event == nullptr) {
        return "ERR: CreateEvent failed: " + std::to_string(GetLastError());
    }
    {
        std::lock_guard<std::mutex> lock(g_uv_mutex);
        g_uv_result.clear();
        g_uv_pending = code;
        g_uv_event = event;
    }

    const int send_rc =
        g_uv_async_send(reinterpret_cast<uvm::Async*>(g_uv_handle));
    if (send_rc != 0) {
        std::lock_guard<std::mutex> lock(g_uv_mutex);
        g_uv_pending.clear();
        g_uv_event = nullptr;
        CloseHandle(event);
        return "ERR: uv_async_send rc=" + std::to_string(send_rc);
    }

    const DWORD wait = WaitForSingleObject(event, timeout_ms);
    std::lock_guard<std::mutex> lock(g_uv_mutex);
    std::string result;
    if (wait == WAIT_OBJECT_0) {
        result = g_uv_result;
    } else {
        result = "ERR: timeout waiting for uv_async callback";
        g_uv_pending.clear();
    }
    g_uv_event = nullptr;
    CloseHandle(event);
    return result;
}

std::string RequestUvProbe() {
    static const char* kProbeScript = R"JS((function(){
  var g = globalThis, p = g.process;
  var req = (typeof require !== 'undefined') ? require :
    (p && p.getBuiltinModule ? function(n){ return p.getBuiltinModule(n); } :
    (p && p.mainModule ? p.mainModule.require.bind(p.mainModule) : null));
  if (!req) throw new Error('no require');
  var fs = req('fs');
  var dir = (p && p.env && p.env.TEMP) ? p.env.TEMP : 'C:/Windows/Temp';
  var file = dir + '/qqhook_v8probe.txt';
  fs.writeFileSync(file, 'v8-ok node=' + p.version + ' arch=' + p.arch);
  return file;
})())JS";

    std::string result = RunJsOnLoop(kProbeScript);
    const std::string file = ReadV8ProbeFile();
    result += file.empty() ? " probe_file=<missing>" : " probe_file=" + file;
    return result;
}

// ---------------------------------------------------------------------------
// Native tray suppression.
//
// Electron's Windows Tray lives in QQNT.dll and calls
// shell32!Shell_NotifyIconW through its import table. Repointing that one IAT
// slot before QQ creates its tray means Windows never adds a notification
// icon. QQ's JS still has a Tray object, so close-to-tray and its tooltip
// updates keep working; only the icon (and icon balloons) disappear. No QQ
// files are touched.
//
// The watcher exists because the injector can run before QQNT.dll is loaded
// and because the loader may rebind an import after we have patched it. It
// keeps the slot pointed at us while blocking is requested and restores the
// real function on `trayhook off`.
// ---------------------------------------------------------------------------
using ShellNotifyIconWFn = BOOL(WINAPI*)(DWORD, PNOTIFYICONDATAW);

std::mutex g_tray_mutex;
std::vector<void**> g_tray_slots;
HMODULE g_tray_patched_module = nullptr;
std::atomic<bool> g_tray_blocked{false};
std::atomic<bool> g_tray_desired{false};
std::atomic<bool> g_tray_watch_running{false};
std::atomic<ShellNotifyIconWFn> g_shell_notify_icon_w{nullptr};
std::atomic<unsigned long long> g_tray_blocked_calls{0};
std::atomic<DWORD> g_tray_last_message{0xFFFFFFFFu};

BOOL WINAPI TrayShellNotifyIconW(DWORD message, PNOTIFYICONDATAW data) {
    if (g_tray_blocked.load(std::memory_order_relaxed)) {
        g_tray_last_message.store(message, std::memory_order_relaxed);
        g_tray_blocked_calls.fetch_add(1, std::memory_order_relaxed);
        return TRUE;
    }
    const ShellNotifyIconWFn real =
        g_shell_notify_icon_w.load(std::memory_order_relaxed);
    return real != nullptr ? real(message, data) : FALSE;
}

// Returns the number of matching import slots in `module` (including slots
// that were already pointed at our hook by an earlier pass).
int PatchTrayIat(HMODULE module) {
    if (module == nullptr) {
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

    const HMODULE shell32 = GetModuleHandleW(L"shell32.dll");
    if (shell32 == nullptr) {
        return 0;
    }
    const auto real = reinterpret_cast<ShellNotifyIconWFn>(
        GetProcAddress(shell32, "Shell_NotifyIconW"));
    if (real == nullptr) {
        return 0;
    }
    g_shell_notify_icon_w.store(real, std::memory_order_relaxed);

    std::lock_guard<std::mutex> lock(g_tray_mutex);
    int patched = 0;
    auto* descriptor =
        reinterpret_cast<IMAGE_IMPORT_DESCRIPTOR*>(base + imports.VirtualAddress);
    for (; descriptor->Name != 0; ++descriptor) {
        const char* dll_name =
            reinterpret_cast<const char*>(base + descriptor->Name);
        if (_stricmp(dll_name, "SHELL32.dll") != 0) {
            continue;
        }
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
                match = strcmp(reinterpret_cast<const char*>(by_name->Name),
                               "Shell_NotifyIconW") == 0;
            }
            void** slot = reinterpret_cast<void**>(&first[i].u1.Function);
            if (!match && *slot == reinterpret_cast<void*>(real)) {
                match = true;
            }
            if (!match) {
                continue;
            }
            bool known = false;
            for (void** existing : g_tray_slots) {
                if (existing == slot) {
                    known = true;
                    break;
                }
            }
            if (!known) {
                DWORD old_protect = 0;
                if (!VirtualProtect(slot, sizeof(void*), PAGE_READWRITE,
                                    &old_protect)) {
                    continue;
                }
                *slot = reinterpret_cast<void*>(&TrayShellNotifyIconW);
                VirtualProtect(slot, sizeof(void*), old_protect, &old_protect);
                g_tray_slots.push_back(slot);
            }
            ++patched;
        }
    }
    if (patched > 0) {
        g_tray_patched_module = module;
    }
    return patched;
}

bool TraySlotsIntact() {
    std::lock_guard<std::mutex> lock(g_tray_mutex);
    if (g_tray_slots.empty()) {
        return false;
    }
    for (void** slot : g_tray_slots) {
        if (*slot != reinterpret_cast<void*>(&TrayShellNotifyIconW)) {
            return false;
        }
    }
    return true;
}

void RestoreTrayIat() {
    const auto real = g_shell_notify_icon_w.load(std::memory_order_relaxed);
    std::lock_guard<std::mutex> lock(g_tray_mutex);
    for (void** slot : g_tray_slots) {
        if (*slot != reinterpret_cast<void*>(&TrayShellNotifyIconW)) {
            continue;
        }
        DWORD old_protect = 0;
        if (!VirtualProtect(slot, sizeof(void*), PAGE_READWRITE,
                            &old_protect)) {
            continue;
        }
        *slot = reinterpret_cast<void*>(real);
        VirtualProtect(slot, sizeof(void*), old_protect, &old_protect);
    }
    g_tray_slots.clear();
    g_tray_patched_module = nullptr;
}

void StartTrayWatch();

DWORD WINAPI TrayWatchThread(LPVOID) {
    AppendLog("traywatch: thread started");
    bool announced = false;
    while (g_tray_desired.load(std::memory_order_relaxed)) {
        const HMODULE qqnt = GetModuleHandleW(L"QQNT.dll");
        if (qqnt != nullptr) {
            if (g_tray_patched_module != qqnt || !TraySlotsIntact()) {
                const int slots = PatchTrayIat(qqnt);
                if (slots > 0 && !announced) {
                    announced = true;
                    AppendLog("traywatch: hooked QQNT.dll slots=" +
                              std::to_string(slots));
                }
            }
        } else if (g_tray_patched_module == nullptr || !TraySlotsIntact()) {
            // Before QQNT.dll loads: the standalone test host imports the API
            // itself. QQ's main exe does not, so this is a no-op there.
            const int slots = PatchTrayIat(GetModuleHandleW(nullptr));
            if (slots > 0 && !announced) {
                announced = true;
                AppendLog("traywatch: hooked main module slots=" +
                          std::to_string(slots));
            }
        }

        const bool intact = TraySlotsIntact();
        g_tray_blocked.store(intact, std::memory_order_relaxed);
        Sleep(intact ? 500 : 100);
    }
    g_tray_blocked.store(false);
    RestoreTrayIat();
    g_tray_watch_running.store(false);
    AppendLog("traywatch: thread stopped");
    // A quick off/on may have raced with this exit; make sure the request is
    // not lost.
    if (g_tray_desired.load(std::memory_order_relaxed)) {
        StartTrayWatch();
    }
    return 0;
}

void StartTrayWatch() {
    if (g_tray_watch_running.exchange(true)) {
        return;
    }
    const HANDLE thread =
        CreateThread(nullptr, 0, TrayWatchThread, nullptr, 0, nullptr);
    if (thread != nullptr) {
        CloseHandle(thread);
    } else {
        g_tray_watch_running.store(false);
        AppendLog("traywatch: CreateThread failed");
    }
}

void SetTrayDesired(bool block) {
    if (block) {
        g_tray_desired.store(true, std::memory_order_relaxed);
        StartTrayWatch();
        return;
    }
    g_tray_desired.store(false, std::memory_order_relaxed);
    g_tray_blocked.store(false, std::memory_order_relaxed);
    RestoreTrayIat();
}

std::string TrayHookStatus() {
    size_t slots = 0;
    {
        std::lock_guard<std::mutex> lock(g_tray_mutex);
        slots = g_tray_slots.size();
    }
    const HMODULE qqnt = GetModuleHandleW(L"QQNT.dll");
    char buffer[256] = {};
    snprintf(buffer, sizeof(buffer),
             "trayhook installed=%d blocked=%d desired=%d slots=%zu calls=%llu "
             "last=%ld qqnt=%s",
             slots > 0 ? 1 : 0,
             g_tray_blocked.load(std::memory_order_relaxed) ? 1 : 0,
             g_tray_desired.load(std::memory_order_relaxed) ? 1 : 0, slots,
             static_cast<unsigned long long>(
                 g_tray_blocked_calls.load(std::memory_order_relaxed)),
             static_cast<long>(g_tray_last_message.load(
                 std::memory_order_relaxed)),
             qqnt != nullptr ? "loaded" : "absent");
    return buffer;
}

std::string HandleCommand(const std::string& raw, bool& should_unload) {
    const std::string line = Trim(raw);
    const size_t space = line.find(' ');
    const std::string verb = LowerAscii(line.substr(0, space));
    const std::string rest =
        space == std::string::npos ? std::string() : Trim(line.substr(space + 1));

    if (verb == "ping") {
        return "pong";
    }
    if (verb == "info") {
        return HandleInfo();
    }
    if (verb == "modules") {
        return HandleModules(rest);
    }
    if (verb == "windows") {
        return HandleWindows();
    }
    if (verb == "threads") {
        return HandleThreads();
    }
    if (verb == "echo") {
        return rest;
    }
    if (verb == "v8probe") {
        const DWORD tid =
            rest.empty() ? 0 : static_cast<DWORD>(strtoul(rest.c_str(), nullptr, 10));
        return RequestV8Probe(tid);
    }
    if (verb == "uvprobe") {
        return RequestUvProbe();
    }
    if (verb == "js") {
        return RunJsOnLoop(rest);
    }
    if (verb == "jseval" || verb == "jsb64") {
        std::string source;
        if (!Base64Decode(rest, source)) {
            return "error: jseval expects base64-encoded UTF-8 JavaScript";
        }
        return RunJsOnLoop(source, 20000);
    }
    if (verb == "trayhook") {
        const std::string mode = LowerAscii(rest);
        if (mode == "on") {
            SetTrayDesired(true);
            return TrayHookStatus();
        }
        if (mode == "off") {
            SetTrayDesired(false);
            return TrayHookStatus();
        }
        if (mode.empty() || mode == "status") {
            return TrayHookStatus();
        }
        return "error: trayhook expects status|on|off";
    }
    if (verb == "unload") {
        if (g_uv_initialized) {
            // The uv_async handle is registered on Node's loop and cannot be
            // closed from here safely yet. Unmapping now would leave a dangling
            // callback and take QQ down with it.
            return "error: V8/uv bridge is active; unload disabled";
        }
        should_unload = true;
        return "bye";
    }
    if (verb == "help" || verb.empty()) {
        return "commands: ping | info | modules [filter] | windows | threads | echo <text> | v8probe [tid] | uvprobe | js <code> | jseval <base64> | trayhook [status|on|off] | unload | help";
    }
    return "error: unknown command '" + verb + "'; try help";
}

DWORD WINAPI PipeThread(LPVOID) {
    Sleep(50);  // Let DllMain return before the thread does real work.
    wchar_t tray_env[16] = {};
    const DWORD tray_len =
        GetEnvironmentVariableW(L"QQHOOK_TRAY", tray_env, _countof(tray_env));
    if (tray_len > 0 && tray_len < _countof(tray_env)) {
        const std::string mode =
            LowerAscii(WideToUtf8(std::wstring(tray_env, tray_len)));
        if (mode == "0" || mode == "off" || mode == "block" ||
            mode == "none") {
            AppendLog("traywatch: requested by QQHOOK_TRAY=" + mode);
            SetTrayDesired(true);
        }
    }
    AppendLog("pipe thread started");

    for (;;) {
        const std::wstring pipe_name = poc::PipeNameForPid(GetCurrentProcessId());
        const HANDLE pipe = CreateNamedPipeW(
            pipe_name.c_str(), PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 64 * 1024,
            64 * 1024, 0, nullptr);
        if (pipe == INVALID_HANDLE_VALUE) {
            AppendLog("CreateNamedPipeW failed: " +
                      std::to_string(GetLastError()));
            return 0;
        }

        const BOOL connected = ConnectNamedPipe(pipe, nullptr);
        if (!connected && GetLastError() != ERROR_PIPE_CONNECTED) {
            AppendLog("ConnectNamedPipe failed: " +
                      std::to_string(GetLastError()));
            CloseHandle(pipe);
            continue;
        }

        AppendLog("client connected");
        std::string request;
        while (poc::ReadFrame(pipe, request)) {
            bool should_unload = false;
            const std::string reply = HandleCommand(request, should_unload);
            if (!poc::WriteFrame(pipe, reply)) {
                break;
            }
            FlushFileBuffers(pipe);
            if (should_unload) {
                g_unloading = true;
                AppendLog("unload requested");
                DisconnectNamedPipe(pipe);
                CloseHandle(pipe);
                FreeLibraryAndExitThread(g_module, 0);
            }
        }

        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
        if (g_unloading.load()) {
            break;
        }
    }
    return 0;
}

}  // namespace

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_module = module;
        DisableThreadLibraryCalls(module);
        const HANDLE thread =
            CreateThread(nullptr, 0, PipeThread, nullptr, 0, nullptr);
        if (thread == nullptr) {
            return FALSE;
        }
        CloseHandle(thread);
    }
    return TRUE;
}
