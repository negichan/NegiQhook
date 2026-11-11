// Injector side of the PoC. Windows x64 only.
//
// What it does:
//   1. Finds the QQ main process (or uses --pid).
//   2. Injects qqhook.dll with the classic LoadLibraryW + CreateRemoteThread
//      path. This is intentionally simple; manual mapping is a later decision.
//   3. Connects to the DLL's named pipe and issues plain-text commands.
#include <winsock2.h>
#include <ws2tcpip.h>

#include "../common/pipe_protocol.h"

#include <tlhelp32.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <random>
#include <string>
#include <utility>
#include <vector>

namespace {

struct Options {
    DWORD pid = 0;
    std::wstring exe_name = L"QQ.exe";
    std::wstring dll_path;
    std::vector<std::string> commands;
    bool list_only = false;
    bool unload = false;
    bool listen = false;
    bool bridge_only = false;
    bool self_test = false;
    bool raw_events = false;
    bool console_mode = false;
    int port = 47821;
    int console_port = 47830;
    std::string console_token;
    std::wstring js_file;
    bool launch = false;
    bool force_launch = false;
    bool launch_keep_tray = false;
    bool headless = false;
    bool inject_only = false;
    // --no-std-handles: leave STARTF_USESTDHANDLES unset instead of passing
    // INVALID_HANDLE_VALUE, i.e. start the child exactly the way Explorer does.
    bool no_std_handles = false;
    std::wstring launch_path;
    std::wstring launch_uin;
    // --report-exit <ms>: after resuming the launched process, watch it for this
    // long and print its exit code if it stops. Headless boot diagnostics need
    // this because a silent early QQ exit leaves no log of its own.
    int report_exit_ms = 0;
};

struct ProcessInfo {
    DWORD pid = 0;
    DWORD parent_pid = 0;
    std::wstring name;
};

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

std::wstring Utf8ToWide(const char* text) {
    if (text == nullptr || *text == '\0') {
        return {};
    }
    const int size = MultiByteToWideChar(CP_UTF8, 0, text, -1, nullptr, 0);
    if (size <= 1) {
        return {};
    }
    std::vector<wchar_t> buffer(static_cast<size_t>(size), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text, -1, buffer.data(), size);
    return std::wstring(buffer.data(), static_cast<size_t>(size - 1));
}

bool EqualsNoCase(const std::wstring& a, const std::wstring& b) {
    return _wcsicmp(a.c_str(), b.c_str()) == 0;
}

std::vector<ProcessInfo> SnapshotProcesses() {
    std::vector<ProcessInfo> processes;
    const HANDLE snapshot =
        CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) {
        return processes;
    }
    PROCESSENTRY32W entry = {};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot, &entry)) {
        do {
            ProcessInfo info;
            info.pid = entry.th32ProcessID;
            info.parent_pid = entry.th32ParentProcessID;
            info.name = entry.szExeFile;
            processes.push_back(std::move(info));
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return processes;
}

std::vector<ProcessInfo> FindCandidates(const std::wstring& exe_name) {
    const std::vector<ProcessInfo> processes = SnapshotProcesses();
    std::vector<ProcessInfo> matches;
    for (const ProcessInfo& process : processes) {
        if (process.pid != 0 && EqualsNoCase(process.name, exe_name)) {
            matches.push_back(process);
        }
    }

    // Renderer / GPU / utility processes are children of the main process.
    // Keep only the top-level ones so a PoC run does not inject into a sandbox.
    std::vector<ProcessInfo> roots;
    for (const ProcessInfo& candidate : matches) {
        bool parent_is_same_exe = false;
        for (const ProcessInfo& possible_parent : matches) {
            if (possible_parent.pid == candidate.parent_pid) {
                parent_is_same_exe = true;
                break;
            }
        }
        if (!parent_is_same_exe) {
            roots.push_back(candidate);
        }
    }
    return roots;
}

std::wstring ProcessImagePath(DWORD pid) {
    const HANDLE process =
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (process == nullptr) {
        return {};
    }
    wchar_t buffer[32768] = {};
    DWORD size = _countof(buffer);
    std::wstring result;
    if (QueryFullProcessImageNameW(process, 0, buffer, &size)) {
        result.assign(buffer, size);
    }
    CloseHandle(process);
    return result;
}

uintptr_t FindModuleBase(DWORD pid, const std::wstring& module_name);

BOOL CALLBACK CollectWindowPidProc(HWND hwnd, LPARAM param) {
    auto* pids = reinterpret_cast<std::vector<DWORD>*>(param);
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != 0) {
        pids->push_back(pid);
    }
    return TRUE;
}

std::vector<DWORD> TopLevelWindowPids() {
    std::vector<DWORD> pids;
    EnumWindows(CollectWindowPidProc, reinterpret_cast<LPARAM>(&pids));
    return pids;
}

// QQ keeps the name QQ.exe for the browser/main process, every renderer, GPU
// and utility process. Parent-process filtering removes most of them, but a
// launcher/versioned pair or two accounts can still leave several roots. Score
// the survivors by things only the real main process owns.
struct CandidateScore {
    ProcessInfo info;
    int score = 0;
    bool has_wrapper = false;
    bool has_qqnt = false;
    bool has_window = false;
};

std::vector<CandidateScore> ScoreCandidates(
    const std::vector<ProcessInfo>& candidates) {
    const std::vector<DWORD> window_pids = TopLevelWindowPids();
    std::vector<CandidateScore> scored;
    scored.reserve(candidates.size());
    for (const ProcessInfo& candidate : candidates) {
        CandidateScore item;
        item.info = candidate;
        if (FindModuleBase(candidate.pid, L"wrapper.node") != 0) {
            item.has_wrapper = true;
            item.score += 100;
        }
        if (FindModuleBase(candidate.pid, L"QQNT.dll") != 0) {
            item.has_qqnt = true;
            item.score += 20;
        }
        if (std::find(window_pids.begin(), window_pids.end(), candidate.pid) !=
            window_pids.end()) {
            item.has_window = true;
            item.score += 30;
        }
        scored.push_back(item);
    }
    return scored;
}

void PrintCandidate(const CandidateScore& candidate) {
    printf("  pid=%lu ppid=%lu score=%d%s%s%s exe=%s\n",
           static_cast<unsigned long>(candidate.info.pid),
           static_cast<unsigned long>(candidate.info.parent_pid),
           candidate.score,
           candidate.has_wrapper ? " wrapper.node" : "",
           candidate.has_qqnt ? " QQNT.dll" : "",
           candidate.has_window ? " window" : "",
           WideToUtf8(ProcessImagePath(candidate.info.pid)).c_str());
}

std::wstring InjectorDirectory() {
    wchar_t buffer[MAX_PATH * 4] = {};
    const DWORD length = GetModuleFileNameW(nullptr, buffer, _countof(buffer));
    if (length == 0) {
        return {};
    }
    std::wstring path(buffer, length);
    const size_t slash = path.find_last_of(L"\\/");
    if (slash == std::wstring::npos) {
        return L".";
    }
    return path.substr(0, slash);
}

std::wstring AbsolutePath(const std::wstring& path) {
    wchar_t buffer[MAX_PATH * 4] = {};
    const DWORD length = GetFullPathNameW(path.c_str(), _countof(buffer), buffer,
                                          nullptr);
    if (length == 0 || length >= _countof(buffer)) {
        return path;
    }
    return std::wstring(buffer, length);
}

std::wstring FileNameOf(const std::wstring& path) {
    const size_t slash = path.find_last_of(L"\\/");
    return slash == std::wstring::npos ? path : path.substr(slash + 1);
}

HANDLE ConnectToHook(DWORD pid, int timeout_ms) {
    const std::wstring pipe_name = poc::PipeNameForPid(pid);
    const int step_ms = 100;
    for (int waited = 0; waited <= timeout_ms; waited += step_ms) {
        const HANDLE pipe = CreateFileW(
            pipe_name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
            OPEN_EXISTING, 0, nullptr);
        if (pipe != INVALID_HANDLE_VALUE) {
            return pipe;
        }
        if (GetLastError() == ERROR_PIPE_BUSY) {
            WaitNamedPipeW(pipe_name.c_str(), step_ms);
        }
        Sleep(step_ms);
    }
    return INVALID_HANDLE_VALUE;
}

uintptr_t FindModuleBase(DWORD pid, const std::wstring& module_name) {
    const HANDLE snapshot = CreateToolhelp32Snapshot(
        TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
    if (snapshot == INVALID_HANDLE_VALUE) {
        return 0;
    }
    uintptr_t base = 0;
    MODULEENTRY32W entry = {};
    entry.dwSize = sizeof(entry);
    if (Module32FirstW(snapshot, &entry)) {
        do {
            if (_wcsicmp(entry.szModule, module_name.c_str()) == 0) {
                base = reinterpret_cast<uintptr_t>(entry.modBaseAddr);
                break;
            }
        } while (Module32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return base;
}

bool InjectDll(HANDLE process, const std::wstring& dll_path) {
    const SIZE_T bytes = (dll_path.size() + 1) * sizeof(wchar_t);
    void* remote = VirtualAllocEx(process, nullptr, bytes,
                                  MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (remote == nullptr) {
        printf("[error] VirtualAllocEx failed: %lu\n", GetLastError());
        return false;
    }

    bool ok = false;
    if (!WriteProcessMemory(process, remote, dll_path.c_str(), bytes, nullptr)) {
        printf("[error] WriteProcessMemory failed: %lu\n", GetLastError());
    } else {
        const HMODULE kernel32 = GetModuleHandleW(L"kernel32.dll");
        const FARPROC load_library =
            kernel32 == nullptr ? nullptr : GetProcAddress(kernel32, "LoadLibraryW");
        if (load_library == nullptr) {
            printf("[error] could not resolve LoadLibraryW\n");
        } else {
            const HANDLE thread = CreateRemoteThread(
                process, nullptr, 0,
                reinterpret_cast<LPTHREAD_START_ROUTINE>(load_library), remote, 0,
                nullptr);
            if (thread == nullptr) {
                printf("[error] CreateRemoteThread failed: %lu\n", GetLastError());
            } else {
                const DWORD wait = WaitForSingleObject(thread, 15000);
                DWORD remote_module = 0;
                if (wait != WAIT_OBJECT_0) {
                    printf("[error] injection thread did not finish: %lu\n", wait);
                } else if (!GetExitCodeThread(thread, &remote_module)) {
                    printf("[error] GetExitCodeThread failed: %lu\n", GetLastError());
                } else if (remote_module == 0) {
                    printf(
                        "[error] LoadLibraryW returned NULL inside the target; "
                        "the DLL was probably blocked or failed to start\n");
                } else {
                    // CreateRemoteThread only carries a DWORD exit code, so on
                    // x64 the returned HMODULE is truncated. The caller verifies
                    // the real base through the target's module list.
                    ok = true;
                }
                CloseHandle(thread);
            }
        }
    }

    VirtualFreeEx(process, remote, 0, MEM_RELEASE);
    return ok;
}

void PrintUsage() {
    printf(
        "usage: qqinject.exe [options]\n"
        "  --list              list scored QQ main-process candidates\n"
        "  --pid <n>           target process id (omit to auto-detect)\n"
        "  --exe <name>        process name to auto-detect, default QQ.exe\n"
        "  --dll <path>        hook DLL path, default <exe dir>\\qqhook.dll\n"
        "  --cmd <text>        command to send; may be repeated\n"
        "  --cmd-file <path>   read one command per line from a UTF-8 file\n"
        "  --listen            install the message bridge and stream events\n"
        "  --bridge-only       install the protocol bridge and exit (no local listener)\n"
        "  --console           serve the friend/send test page from inside QQ\n"
        "  --console-port <n>  web console port, default 47830\n"
        "  --console-token <s> web console token, default random\n"
        "  --port <n>          event TCP port on 127.0.0.1, default 47821\n"
        "  --self-test         with --listen, emit synthetic parsed events\n"
        "  --json              with --listen, print raw JSON event lines\n"
        "  --js-file <path>    bridge script, default <exe>/../scripts/msg_bridge.js\n"
        "                      (--bridge-only uses scripts/proto_bridge.js)\n"
        "  --launch [path]     start QQ suspended, inject the DLL, then resume;\n"
        "                      default %s\n"
        "                      sets QQHOOK_TRAY=0 so no tray icon is created\n"
        "  --uin <uin>         with --launch: pass -q <uin> for quick login\n"
        "  --keep-tray         with --launch: keep the tray (QQHOOK_TRAY=1)\n"
        "  --headless          boot-DLL launch: no tray env, no --enable-logging,\n"
        "                      no control pipe; the boot main installs the bridge\n"
        "  --inject-only       inject the DLL and exit without opening the pipe\n"
        "  --report-exit <ms>  with --launch: after resuming, wait up to <ms> for\n"
        "                      the child and print its exit code\n"
        "  --no-std-handles    with --launch: do not set STARTF_USESTDHANDLES\n"
        "  --force             with --launch: start even if this copy of QQ is running\n"
        "  --unload            send 'unload' after the other commands\n"
        "  -h, --help          show this help\n",
        "C:\\Program Files\\Tencent\\QQNT\\QQ.exe");
}

bool ReadCommandFile(const std::wstring& path, std::vector<std::string>& commands) {
    const HANDLE file = CreateFileW(path.c_str(), GENERIC_READ,
                                    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                                    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }
    std::string data;
    char buffer[4096] = {};
    DWORD read = 0;
    while (ReadFile(file, buffer, sizeof(buffer), &read, nullptr) && read > 0) {
        data.append(buffer, read);
    }
    CloseHandle(file);

    size_t start = 0;
    while (start <= data.size()) {
        const size_t end = data.find('\n', start);
        std::string line = end == std::string::npos
                               ? data.substr(start)
                               : data.substr(start, end - start);
        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
        }
        if (!line.empty()) {
            commands.push_back(std::move(line));
        }
        if (end == std::string::npos) {
            break;
        }
        start = end + 1;
    }
    return true;
}

bool ReadWholeFile(const std::wstring& path, std::string& data) {
    const HANDLE file = CreateFileW(path.c_str(), GENERIC_READ,
                                    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                                    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }
    data.clear();
    char buffer[8192] = {};
    DWORD read = 0;
    while (ReadFile(file, buffer, sizeof(buffer), &read, nullptr) && read > 0) {
        data.append(buffer, read);
    }
    CloseHandle(file);
    return true;
}

std::string Base64Encode(const std::string& input) {
    static const char kTable[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve((input.size() + 2) / 3 * 4);
    size_t i = 0;
    while (i + 2 < input.size()) {
        const unsigned a = static_cast<unsigned char>(input[i]);
        const unsigned b = static_cast<unsigned char>(input[i + 1]);
        const unsigned c = static_cast<unsigned char>(input[i + 2]);
        out.push_back(kTable[a >> 2]);
        out.push_back(kTable[((a & 3) << 4) | (b >> 4)]);
        out.push_back(kTable[((b & 15) << 2) | (c >> 6)]);
        out.push_back(kTable[c & 63]);
        i += 3;
    }
    if (i < input.size()) {
        const unsigned a = static_cast<unsigned char>(input[i]);
        const unsigned b = i + 1 < input.size()
                               ? static_cast<unsigned char>(input[i + 1])
                               : 0;
        out.push_back(kTable[a >> 2]);
        out.push_back(kTable[((a & 3) << 4) | (b >> 4)]);
        if (i + 1 < input.size()) {
            out.push_back(kTable[(b & 15) << 2]);
        } else {
            out.push_back('=');
        }
        out.push_back('=');
    }
    return out;
}

// Pulls a single JSON string field out of one event line. This is only used
// for the human-readable console banner; --json prints the raw frame instead.
bool ExtractJsonString(const std::string& json, const std::string& key,
                       std::string& value) {
    const std::string needle = "\"" + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) {
        return false;
    }
    pos += needle.size();
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) {
        ++pos;
    }
    if (pos >= json.size() || json[pos] != ':') {
        return false;
    }
    ++pos;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) {
        ++pos;
    }
    if (pos >= json.size() || json[pos] != '"') {
        return false;
    }
    ++pos;
    std::string result;
    while (pos < json.size()) {
        const char c = json[pos++];
        if (c == '"') {
            value = std::move(result);
            return true;
        }
        if (c != '\\') {
            result.push_back(c);
            continue;
        }
        if (pos >= json.size()) {
            break;
        }
        const char esc = json[pos++];
        switch (esc) {
            case '"': result.push_back('"'); break;
            case '\\': result.push_back('\\'); break;
            case '/': result.push_back('/'); break;
            case 'b': result.push_back('\b'); break;
            case 'f': result.push_back('\f'); break;
            case 'n': result.push_back('\n'); break;
            case 'r': result.push_back('\r'); break;
            case 't': result.push_back('\t'); break;
            case 'u': {
                if (pos + 4 > json.size()) {
                    return false;
                }
                unsigned code = 0;
                for (int i = 0; i < 4; ++i) {
                    const char h = json[pos + i];
                    code <<= 4;
                    if (h >= '0' && h <= '9') {
                        code |= static_cast<unsigned>(h - '0');
                    } else if (h >= 'a' && h <= 'f') {
                        code |= static_cast<unsigned>(h - 'a' + 10);
                    } else if (h >= 'A' && h <= 'F') {
                        code |= static_cast<unsigned>(h - 'A' + 10);
                    }
                }
                pos += 4;
                if (code < 0x80) {
                    result.push_back(static_cast<char>(code));
                } else if (code < 0x800) {
                    result.push_back(static_cast<char>(0xC0 | (code >> 6)));
                    result.push_back(static_cast<char>(0x80 | (code & 0x3F)));
                } else {
                    result.push_back(static_cast<char>(0xE0 | (code >> 12)));
                    result.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
                    result.push_back(static_cast<char>(0x80 | (code & 0x3F)));
                }
                break;
            }
            default: result.push_back(esc); break;
        }
    }
    return false;
}

std::string TrimAscii(std::string text) {
    while (!text.empty() && (text.back() == '\r' || text.back() == '\n' ||
                             text.back() == ' ' || text.back() == '\t')) {
        text.pop_back();
    }
    size_t start = 0;
    while (start < text.size() &&
           (text[start] == ' ' || text[start] == '\t')) {
        ++start;
    }
    return text.substr(start);
}

void PrintEventLine(const std::string& line, bool raw) {
    if (raw) {
        printf("%s\n", line.c_str());
        fflush(stdout);
        return;
    }
    std::string display;
    if (ExtractJsonString(line, "display", display)) {
        printf("%s\n", display.c_str());
    } else {
        printf("%s\n", line.c_str());
    }
    fflush(stdout);
}

SOCKET StartEventServer(int port, std::string& error) {
    WSADATA wsa = {};
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        error = "WSAStartup failed";
        return INVALID_SOCKET;
    }
    const SOCKET server = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (server == INVALID_SOCKET) {
        error = "socket failed: " + std::to_string(WSAGetLastError());
        WSACleanup();
        return INVALID_SOCKET;
    }
    BOOL exclusive = TRUE;
    setsockopt(server, SOL_SOCKET, SO_EXCLUSIVEADDRUSE,
               reinterpret_cast<const char*>(&exclusive), sizeof(exclusive));

    sockaddr_in address = {};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<unsigned short>(port));
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(server, reinterpret_cast<const sockaddr*>(&address),
             sizeof(address)) == SOCKET_ERROR) {
        error = "bind 127.0.0.1:" + std::to_string(port) + " failed: " +
                std::to_string(WSAGetLastError());
        closesocket(server);
        WSACleanup();
        return INVALID_SOCKET;
    }
    if (listen(server, 1) == SOCKET_ERROR) {
        error = "listen failed: " + std::to_string(WSAGetLastError());
        closesocket(server);
        WSACleanup();
        return INVALID_SOCKET;
    }
    return server;
}

SOCKET AcceptEventClient(SOCKET server, int timeout_ms) {
    fd_set set;
    FD_ZERO(&set);
    FD_SET(server, &set);
    timeval tv = {};
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;
    const int ready = select(0, &set, nullptr, nullptr, &tv);
    if (ready <= 0) {
        return INVALID_SOCKET;
    }
    return accept(server, nullptr, nullptr);
}

// Streams newline-delimited JSON events until the bridge disconnects.
void StreamEvents(SOCKET client, bool raw) {
    std::string pending;
    char buffer[8192];
    for (;;) {
        const int read = recv(client, buffer, sizeof(buffer), 0);
        if (read <= 0) {
            break;
        }
        pending.append(buffer, static_cast<size_t>(read));
        size_t newline = 0;
        while ((newline = pending.find('\n')) != std::string::npos) {
            std::string line = pending.substr(0, newline);
            pending.erase(0, newline + 1);
            line = TrimAscii(std::move(line));
            if (!line.empty()) {
                PrintEventLine(line, raw);
            }
        }
    }
}

bool SendCommand(HANDLE pipe, const std::string& command, std::string& reply) {
    if (!poc::WriteFrame(pipe, command)) {
        return false;
    }
    return poc::ReadFrame(pipe, reply);
}

std::wstring DefaultScriptPath(const wchar_t* file_name) {
    const std::wstring near_exe =
        InjectorDirectory() + L"\\..\\scripts\\" + file_name;
    if (GetFileAttributesW(near_exe.c_str()) != INVALID_FILE_ATTRIBUTES) {
        return AbsolutePath(near_exe);
    }
    const std::wstring beside_exe = InjectorDirectory() + L"\\" + file_name;
    if (GetFileAttributesW(beside_exe.c_str()) != INVALID_FILE_ATTRIBUTES) {
        return AbsolutePath(beside_exe);
    }
    return {};
}

std::wstring DefaultBridgePath() {
    return DefaultScriptPath(L"msg_bridge.js");
}

std::wstring DefaultProtocolBridgePath() {
    return DefaultScriptPath(L"proto_bridge.js");
}

std::wstring DirectoryOf(const std::wstring& path) {
    const size_t slash = path.find_last_of(L"\\/");
    if (slash == std::wstring::npos) {
        return {};
    }
    return path.substr(0, slash);
}

std::wstring DefaultQQPath() {
    const wchar_t* candidates[] = {
        L"C:\\Program Files\\Tencent\\QQNT\\QQ.exe",
        L"C:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe",
    };
    for (const wchar_t* candidate : candidates) {
        if (GetFileAttributesW(candidate) != INVALID_FILE_ATTRIBUTES) {
            return candidate;
        }
    }
    wchar_t local[MAX_PATH] = {};
    const DWORD length =
        GetEnvironmentVariableW(L"LOCALAPPDATA", local, _countof(local));
    if (length > 0 && length < _countof(local)) {
        const std::wstring path =
            std::wstring(local) + L"\\Programs\\Tencent\\QQNT\\QQ.exe";
        if (GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES) {
            return path;
        }
    }
    return {};
}

// `--launch` injects while QQ is still suspended, so the DLL is already there
// before Electron exists. Wait until QQ's app main is loaded before sending the
// bridge, otherwise the bridge has no session and no require() target.
bool WaitForQqMain(HANDLE pipe, int timeout_ms) {
    const DWORD start = GetTickCount();
    for (;;) {
        std::string reply;
        if (SendCommand(pipe,
                        "js (typeof process !== 'undefined' && "
                        "process.mainModule) ? 'ready' : 'wait'",
                        reply)) {
            const std::string value = TrimAscii(reply);
            if (value == "ready") {
                return true;
            }
        }
        if (GetTickCount() - start >= static_cast<DWORD>(timeout_ms)) {
            return false;
        }
        Sleep(500);
    }
}

std::string MakeConsoleToken() {
    std::random_device random;
    static const char kHex[] = "0123456789abcdef";
    std::string token;
    token.reserve(32);
    for (int i = 0; i < 32; ++i) {
        token.push_back(kHex[random() & 0xF]);
    }
    return token;
}

bool IsValidConsoleToken(const std::string& token) {
    if (token.empty() || token.size() > 128) {
        return false;
    }
    for (const char raw : token) {
        const unsigned char c = static_cast<unsigned char>(raw);
        const bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
                        (c >= 'A' && c <= 'Z') || c == '-' || c == '_';
        if (!ok) {
            return false;
        }
    }
    return true;
}

int RunConsoleMode(HANDLE pipe, const Options& options) {
    const std::wstring js_path = DefaultScriptPath(L"web_console.js");
    const std::wstring html_path = DefaultScriptPath(L"console.html");
    if (js_path.empty() || html_path.empty()) {
        printf("[error] could not locate scripts/web_console.js and scripts/console.html\n");
        return 1;
    }
    std::string js_source;
    std::string html_source;
    if (!ReadWholeFile(js_path, js_source) || js_source.empty()) {
        printf("[error] could not read %s\n", WideToUtf8(js_path).c_str());
        return 1;
    }
    if (!ReadWholeFile(html_path, html_source) || html_source.empty()) {
        printf("[error] could not read %s\n", WideToUtf8(html_path).c_str());
        return 1;
    }

    std::string token = options.console_token;
    if (token.empty()) {
        token = MakeConsoleToken();
    }
    if (!IsValidConsoleToken(token)) {
        printf("[error] --console-token may only contain A-Z a-z 0-9 - _\n");
        return 1;
    }

    std::string reply;
    if (!SendCommand(pipe,
                     "js globalThis.__qqhookConsolePort = " +
                         std::to_string(options.console_port),
                     reply) ||
        !SendCommand(pipe,
                     "js globalThis.__qqhookConsoleToken = '" + token + "'",
                     reply) ||
        !SendCommand(pipe,
                     "js globalThis.__qqhookConsoleHtml = Buffer.from('" +
                         Base64Encode(html_source) +
                         "','base64').toString('utf8')",
                     reply)) {
        printf("[error] failed to configure the web console\n");
        return 1;
    }

    const std::string encoded_js = Base64Encode(js_source);
    if (!SendCommand(pipe, "jseval " + encoded_js, reply)) {
        printf("[error] failed to install the web console\n");
        return 1;
    }
    if (reply.find("unknown command") != std::string::npos) {
        printf("[*] jseval unavailable, falling back to js eval\n");
        const std::string legacy =
            "js eval(Buffer.from('" + encoded_js + "','base64').toString('utf8'))";
        if (!SendCommand(pipe, legacy, reply)) {
            printf("[error] failed to install the web console\n");
            return 1;
        }
    }

    printf("[console] %s\n", reply.c_str());
    if (reply.rfind("ERR:", 0) == 0 || reply.rfind("error:", 0) == 0 ||
        reply.rfind("isolate=null", 0) == 0 ||
        reply.rfind("context=null", 0) == 0) {
        printf("[error] web console failed to start inside QQ\n");
        return 1;
    }

    printf("[+] open: http://127.0.0.1:%d/?token=%s\n", options.console_port,
           token.c_str());
    return 0;
}

// Installs the protocol bridge inside QQ and exits. The bridge is a TCP client;
// the protocol endpoint process owns the listening socket, so this mode never
// opens a local listener (unlike --listen).
int RunInstallMode(HANDLE pipe, const Options& options) {
    std::wstring js_path = options.js_file;
    if (js_path.empty()) {
        js_path = DefaultProtocolBridgePath();
    }
    if (js_path.empty()) {
        printf("[error] could not locate scripts/proto_bridge.js; use --js-file\n");
        return 1;
    }
    std::string source;
    if (!ReadWholeFile(js_path, source) || source.empty()) {
        printf("[error] could not read bridge script: %s\n",
               WideToUtf8(js_path).c_str());
        return 1;
    }

    std::string reply;
    if (!SendCommand(pipe, "js globalThis.__qqhookProtoPort = " +
                               std::to_string(options.port),
                     reply)) {
        printf("[error] failed to set protocol bridge port inside QQ\n");
        return 1;
    }
    const std::string encoded = Base64Encode(source);
    if (!SendCommand(pipe, "jseval " + encoded, reply)) {
        printf("[error] failed to install the protocol bridge\n");
        return 1;
    }
    if (reply.find("unknown command") != std::string::npos) {
        printf("[*] jseval unavailable, falling back to js eval\n");
        const std::string legacy =
            "js eval(Buffer.from('" + encoded + "','base64').toString('utf8'))";
        if (!SendCommand(pipe, legacy, reply)) {
            printf("[error] failed to install the protocol bridge\n");
            return 1;
        }
    }

    printf("[proto-bridge] %s\n", reply.c_str());
    CloseHandle(pipe);
    if (reply.rfind("ERR:", 0) == 0 || reply.rfind("error:", 0) == 0 ||
        reply.rfind("isolate=null", 0) == 0 ||
        reply.rfind("context=null", 0) == 0) {
        printf("[error] protocol bridge install failed inside QQ\n");
        return 1;
    }
    return 0;
}

int RunListenMode(HANDLE pipe, const Options& options) {
    std::wstring js_path = options.js_file;
    if (js_path.empty()) {
        js_path = DefaultBridgePath();
    }
    if (js_path.empty()) {
        printf("[error] could not locate scripts/msg_bridge.js; use --js-file\n");
        return 1;
    }
    std::string source;
    if (!ReadWholeFile(js_path, source) || source.empty()) {
        printf("[error] could not read bridge script: %s\n",
               WideToUtf8(js_path).c_str());
        return 1;
    }

    std::string socket_error;
    const SOCKET server = StartEventServer(options.port, socket_error);
    if (server == INVALID_SOCKET) {
        printf("[error] %s\n", socket_error.c_str());
        return 1;
    }

    std::string reply;
    if (!SendCommand(pipe, "js globalThis.__qqhookEventPort = " +
                               std::to_string(options.port),
                     reply)) {
        printf("[error] failed to set event port inside QQ\n");
        closesocket(server);
        WSACleanup();
        return 1;
    }
    const std::string encoded = Base64Encode(source);
    if (!SendCommand(pipe, "jseval " + encoded, reply)) {
        printf("[error] failed to install the message bridge\n");
        closesocket(server);
        WSACleanup();
        return 1;
    }
    if (reply.find("unknown command") != std::string::npos) {
        // Older qqhook.dll builds have no `jseval`; the same source can be
        // evaluated through plain `js` because Buffer exists in QQ's context.
        printf("[*] jseval unavailable, falling back to js eval\n");
        const std::string legacy =
            "js eval(Buffer.from('" + encoded + "','base64').toString('utf8'))";
        if (!SendCommand(pipe, legacy, reply)) {
            printf("[error] failed to install the message bridge\n");
            closesocket(server);
            WSACleanup();
            return 1;
        }
    }
    printf("[bridge] %s\n", reply.c_str());
    if (reply.rfind("ERR:", 0) == 0 || reply.rfind("error:", 0) == 0 ||
        reply.rfind("isolate=null", 0) == 0 ||
        reply.rfind("context=null", 0) == 0) {
        printf("[error] bridge install failed inside QQ\n");
        closesocket(server);
        WSACleanup();
        return 1;
    }

    if (options.self_test) {
        const std::string test =
            "js (() => { const b = globalThis.__qqhookBridge; "
            "return b ? b.selfTest() : 'bridge missing'; })()";
        if (!SendCommand(pipe, test, reply)) {
            printf("[error] failed to run the self-test\n");
        } else {
            printf("[self-test] %s\n", reply.c_str());
        }
    }

    // The bridge owns its own TCP socket now; release the single-instance
    // control pipe so other qqinject commands can still talk to the DLL.
    CloseHandle(pipe);

    printf("[*] listening on 127.0.0.1:%d (Ctrl+C to stop)\n", options.port);
    fflush(stdout);
    for (;;) {
        const SOCKET client = AcceptEventClient(server, 30000);
        if (client == INVALID_SOCKET) {
            continue;
        }
        printf("[+] bridge connected\n");
        fflush(stdout);
        StreamEvents(client, options.raw_events);
        shutdown(client, SD_BOTH);
        closesocket(client);
        printf("[*] bridge disconnected; waiting for reconnect\n");
        fflush(stdout);
    }
    closesocket(server);
    WSACleanup();
    return 0;
}

bool ParseArgs(int argc, char** argv, Options& options) {
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        auto next_value = [&](const char* name) -> const char* {
            if (i + 1 >= argc) {
                printf("[error] %s needs a value\n", name);
                return nullptr;
            }
            return argv[++i];
        };

        if (arg == "--list") {
            options.list_only = true;
        } else if (arg == "--unload") {
            options.unload = true;
        } else if (arg == "--listen") {
            options.listen = true;
        } else if (arg == "--bridge-only") {
            options.bridge_only = true;
        } else if (arg == "--console") {
            options.console_mode = true;
        } else if (arg == "--console-port") {
            const char* value = next_value("--console-port");
            if (value == nullptr) {
                return false;
            }
            const long port = strtol(value, nullptr, 10);
            if (port <= 0 || port > 65535) {
                printf("[error] --console-port must be between 1 and 65535\n");
                return false;
            }
            options.console_port = static_cast<int>(port);
        } else if (arg == "--console-token") {
            const char* value = next_value("--console-token");
            if (value == nullptr) {
                return false;
            }
            options.console_token = value;
        } else if (arg == "--self-test") {
            options.self_test = true;
        } else if (arg == "--json") {
            options.raw_events = true;
        } else if (arg == "--port") {
            const char* value = next_value("--port");
            if (value == nullptr) {
                return false;
            }
            const long port = strtol(value, nullptr, 10);
            if (port <= 0 || port > 65535) {
                printf("[error] --port must be between 1 and 65535\n");
                return false;
            }
            options.port = static_cast<int>(port);
        } else if (arg == "--js-file") {
            const char* value = next_value("--js-file");
            if (value == nullptr) {
                return false;
            }
            options.js_file = Utf8ToWide(value);
        } else if (arg == "--launch") {
            options.launch = true;
            // The path is optional: `--launch --bridge-only` must not swallow
            // the next flag as a path.
            if (i + 1 < argc && argv[i + 1][0] != '-') {
                options.launch_path = Utf8ToWide(argv[++i]);
            }
        } else if (arg == "--uin") {
            const char* value = next_value("--uin");
            if (value == nullptr) {
                return false;
            }
            options.launch_uin = Utf8ToWide(value);
        } else if (arg == "--keep-tray") {
            options.launch_keep_tray = true;
        } else if (arg == "--headless") {
            options.headless = true;
            options.inject_only = true;
        } else if (arg == "--inject-only") {
            options.inject_only = true;
        } else if (arg == "--report-exit") {
            const char* value = next_value("--report-exit");
            if (value == nullptr) {
                return false;
            }
            options.report_exit_ms = atoi(value);
        } else if (arg == "--no-std-handles") {
            options.no_std_handles = true;
        } else if (arg == "--force") {
            options.force_launch = true;
        } else if (arg == "-h" || arg == "--help") {
            PrintUsage();
            return false;
        } else if (arg == "--pid") {
            const char* value = next_value("--pid");
            if (value == nullptr) {
                return false;
            }
            options.pid = static_cast<DWORD>(strtoul(value, nullptr, 10));
        } else if (arg == "--exe") {
            const char* value = next_value("--exe");
            if (value == nullptr) {
                return false;
            }
            options.exe_name = Utf8ToWide(value);
        } else if (arg == "--dll") {
            const char* value = next_value("--dll");
            if (value == nullptr) {
                return false;
            }
            options.dll_path = Utf8ToWide(value);
        } else if (arg == "--cmd-file") {
            const char* value = next_value("--cmd-file");
            if (value == nullptr) {
                return false;
            }
            if (!ReadCommandFile(Utf8ToWide(value), options.commands)) {
                printf("[error] could not read command file: %s\n", value);
                return false;
            }
        } else if (arg == "--cmd") {
            const char* value = next_value("--cmd");
            if (value == nullptr) {
                return false;
            }
            options.commands.emplace_back(value);
        } else {
            printf("[error] unknown argument: %s\n", arg.c_str());
            PrintUsage();
            return false;
        }
    }
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleCP(CP_UTF8);
    setvbuf(stdout, nullptr, _IONBF, 0);

    Options options;
    if (!ParseArgs(argc, argv, options)) {
        return 1;
    }

    if (options.dll_path.empty()) {
        options.dll_path = InjectorDirectory() + L"\\qqhook.dll";
    }
    options.dll_path = AbsolutePath(options.dll_path);

    if (options.headless && !options.launch) {
        printf("[error] --headless must be used with --launch (the boot DLL "
               "has to be injected before QQ starts)\n");
        return 1;
    }

    if (options.launch) {
        if (options.pid != 0) {
            printf("[error] --launch and --pid cannot be combined\n");
            return 1;
        }
        if (options.list_only) {
            printf("[error] --launch and --list cannot be combined\n");
            return 1;
        }
        const std::wstring exe =
            options.launch_path.empty() ? DefaultQQPath()
                                        : AbsolutePath(options.launch_path);
        if (exe.empty() ||
            GetFileAttributesW(exe.c_str()) == INVALID_FILE_ATTRIBUTES) {
            printf("[error] QQ.exe not found; pass --launch \"<path to QQ.exe>\"\n");
            return 1;
        }
        if (!options.force_launch) {
            // Only this exact copy counts. The private client under qqclient\ is
            // meant to sit next to a normal QQ install: another QQ.exe must not
            // block the launch, and we must never inject into it by accident.
            for (const ProcessInfo& running : FindCandidates(L"QQ.exe")) {
                const std::wstring image = ProcessImagePath(running.pid);
                if (!image.empty() && EqualsNoCase(image, exe)) {
                    printf("[error] this copy of QQ is already running (pid=%lu): %ls\n"
                           "        close it first, or pass --force to start another "
                           "instance\n",
                           static_cast<unsigned long>(running.pid), exe.c_str());
                    return 1;
                }
            }
        }

        std::wstring command = L"\"" + exe + L"\"";
        if (!options.headless) {
            command += L" --enable-logging";
        }
        if (!options.launch_uin.empty()) {
            command += L" -q " + options.launch_uin;
        }
        // Inherited by the child. qqhook.dll reads this in its pipe thread and
        // installs the Shell_NotifyIconW block before Electron creates a Tray.
        // The boot DLL does not need it and headless mode must not leave the
        // extra environment fingerprint in QQ.
        if (!options.headless) {
            SetEnvironmentVariableW(L"QQHOOK_TRAY",
                                    options.launch_keep_tray ? L"1" : L"0");
        }

        const std::wstring workdir = DirectoryOf(exe);
        STARTUPINFOW startup = {};
        startup.cb = sizeof(startup);
        // No console handles: QQ is a GUI process, and this keeps a test host
        // from writing into the injector's terminal after the injector exits.
        // --no-std-handles leaves this unset instead, which is what a shell
        // launch does; used to tell the two startup shapes apart.
        if (!options.no_std_handles) {
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = INVALID_HANDLE_VALUE;
            startup.hStdOutput = INVALID_HANDLE_VALUE;
            startup.hStdError = INVALID_HANDLE_VALUE;
        }
        PROCESS_INFORMATION child = {};
        std::vector<wchar_t> mutable_command(command.begin(), command.end());
        mutable_command.push_back(L'\0');
        // bInheritHandles = FALSE. QQ has no business with the injector's
        // handles, and when it did inherit them our caller's stdout pipe stayed
        // open in QQ's process: node's spawnSync then never saw EOF and only
        // returned after its own timeout, even though QQ was fine and running.
        if (!CreateProcessW(exe.c_str(), mutable_command.data(), nullptr, nullptr,
                            FALSE,
                            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                            nullptr,
                            workdir.empty() ? nullptr : workdir.c_str(),
                            &startup, &child)) {
            printf("[error] CreateProcessW failed: %lu\n", GetLastError());
            return 1;
        }
        printf("[+] launched pid=%lu: %s\n",
               static_cast<unsigned long>(child.dwProcessId),
               WideToUtf8(command).c_str());
        printf("[*] hook dll  = %s\n", WideToUtf8(options.dll_path).c_str());
        if (!options.headless) {
            printf("[*] tray      = %s\n",
                   options.launch_keep_tray ? "kept (QQHOOK_TRAY=1)"
                                            : "suppressed (QQHOOK_TRAY=0)");
        }

        const auto fail_launch = [&child](const char* message) {
            printf("%s\n", message);
            TerminateProcess(child.hProcess, 1);
            if (child.hThread != nullptr) {
                CloseHandle(child.hThread);
            }
            CloseHandle(child.hProcess);
            return 1;
        };

        if (!InjectDll(child.hProcess, options.dll_path)) {
            return fail_launch(
                "[error] DLL injection failed; suspended process terminated");
        }
        const uintptr_t base =
            FindModuleBase(child.dwProcessId, FileNameOf(options.dll_path));
        if (base == 0) {
            return fail_launch(
                "[error] qqhook.dll is not in the target module list; "
                "the load was blocked; suspended process terminated");
        }
        printf("[+] injected %s base = 0x%llx\n",
               WideToUtf8(FileNameOf(options.dll_path)).c_str(),
               static_cast<unsigned long long>(base));

        if (ResumeThread(child.hThread) == static_cast<DWORD>(-1)) {
            return fail_launch(
                "[error] ResumeThread failed; process terminated");
        }
        CloseHandle(child.hThread);
        child.hThread = nullptr;

        if (options.report_exit_ms > 0) {
            const ULONGLONG at = GetTickCount64();
            const DWORD wait = WaitForSingleObject(
                child.hProcess, static_cast<DWORD>(options.report_exit_ms));
            const unsigned long long elapsed =
                static_cast<unsigned long long>(GetTickCount64() - at);
            if (wait == WAIT_OBJECT_0) {
                DWORD code = 0;
                GetExitCodeProcess(child.hProcess, &code);
                printf("[+] child exited after %llums code=0x%08lx (%lu)\n",
                       elapsed, static_cast<unsigned long>(code),
                       static_cast<unsigned long>(code));
            } else {
                printf("[+] child still running after %llums\n", elapsed);
            }
        }

        if (options.headless || options.inject_only) {
            printf("[+] process resumed; inject-only done\n");
            if (options.headless) {
                printf("[*] boot logs: %s\\appinit.log and app.log\n",
                       WideToUtf8(DirectoryOf(options.dll_path)).c_str());
            }
            CloseHandle(child.hProcess);
            return 0;
        }

        const bool needs_bridge =
            options.bridge_only || options.listen || options.console_mode ||
            !options.commands.empty();
        if (!needs_bridge) {
            printf(
                "[*] QQ is running; attach later with: qqinject.exe --pid %lu "
                "--cmd info\n",
                static_cast<unsigned long>(child.dwProcessId));
            CloseHandle(child.hProcess);
            return 0;
        }

        HANDLE pipe = ConnectToHook(child.dwProcessId, 120000);
        if (pipe == INVALID_HANDLE_VALUE) {
            printf(
                "[error] could not connect to the hook pipe; QQ is still "
                "running\n");
            CloseHandle(child.hProcess);
            return 1;
        }
        if (!WaitForQqMain(pipe, 120000)) {
            printf(
                "[error] QQ's app main did not become ready in 120 s; the "
                "process is still running\n");
            CloseHandle(pipe);
            CloseHandle(child.hProcess);
            return 1;
        }

        int exit_code = 0;
        if (options.bridge_only) {
            exit_code = RunInstallMode(pipe, options);
        } else if (options.console_mode) {
            exit_code = RunConsoleMode(pipe, options);
        } else if (options.listen) {
            exit_code = RunListenMode(pipe, options);
        } else {
            if (options.unload) {
                options.commands.emplace_back("unload");
            }
            for (const std::string& cmd : options.commands) {
                std::string reply;
                if (!SendCommand(pipe, cmd, reply)) {
                    printf("[error] failed to send command: %s\n", cmd.c_str());
                    exit_code = 1;
                    break;
                }
                printf("[%s]\n%s\n", cmd.c_str(), reply.c_str());
            }
        }
        CloseHandle(pipe);
        CloseHandle(child.hProcess);
        return exit_code;
    }

    std::vector<ProcessInfo> candidates;
    if (options.pid == 0) {
        candidates = FindCandidates(options.exe_name);
        if (candidates.empty()) {
            if (options.list_only) {
                printf("no %s processes found\n",
                       WideToUtf8(options.exe_name).c_str());
                return 0;
            }
            printf("no %s process found; start it first or pass --pid\n",
                   WideToUtf8(options.exe_name).c_str());
            return 1;
        }

        const std::vector<CandidateScore> scored = ScoreCandidates(candidates);
        if (options.list_only) {
            printf("%s candidates (higher score = more likely the main process):\n",
                   WideToUtf8(options.exe_name).c_str());
            for (const CandidateScore& candidate : scored) {
                PrintCandidate(candidate);
            }
            return 0;
        }

        if (scored.size() == 1) {
            options.pid = scored.front().info.pid;
            if (scored.front().score > 0) {
                printf("[+] auto-selected pid=%lu (score=%d%s%s%s)\n",
                       static_cast<unsigned long>(options.pid),
                       scored.front().score,
                       scored.front().has_wrapper ? " wrapper.node" : "",
                       scored.front().has_qqnt ? " QQNT.dll" : "",
                       scored.front().has_window ? " window" : "");
            }
        } else {
            std::vector<CandidateScore> ranked = scored;
            std::sort(ranked.begin(), ranked.end(),
                      [](const CandidateScore& a, const CandidateScore& b) {
                          return a.score > b.score;
                      });
            if (ranked.front().score >= 30 &&
                ranked.front().score > ranked[1].score) {
                options.pid = ranked.front().info.pid;
                printf("[+] auto-selected pid=%lu (score=%d%s%s%s)\n",
                       static_cast<unsigned long>(options.pid),
                       ranked.front().score,
                       ranked.front().has_wrapper ? " wrapper.node" : "",
                       ranked.front().has_qqnt ? " QQNT.dll" : "",
                       ranked.front().has_window ? " window" : "");
            } else {
                printf(
                    "multiple %s roots and no unique best match; "
                    "choose one with --pid:\n",
                    WideToUtf8(options.exe_name).c_str());
                for (const CandidateScore& candidate : scored) {
                    PrintCandidate(candidate);
                }
                return 1;
            }
        }
    }

    printf("[*] target pid = %lu\n", static_cast<unsigned long>(options.pid));
    printf("[*] hook dll  = %s\n", WideToUtf8(options.dll_path).c_str());

    const HANDLE process = OpenProcess(
        PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION |
            PROCESS_VM_WRITE | PROCESS_VM_READ,
        FALSE, options.pid);
    if (process == nullptr) {
        const DWORD error = GetLastError();
        printf("[error] OpenProcess failed: %lu", error);
        if (error == ERROR_ACCESS_DENIED) {
            printf(" (QQ may be running elevated; try an elevated terminal)");
        }
        printf("\n");
        return 1;
    }

    BOOL target_is_wow64 = FALSE;
    if (IsWow64Process(process, &target_is_wow64) && target_is_wow64) {
        printf("[error] target is 32-bit; this PoC is x64 only\n");
        CloseHandle(process);
        return 1;
    }

    HANDLE pipe = INVALID_HANDLE_VALUE;
    if (!options.inject_only) {
        pipe = ConnectToHook(options.pid, 0);
        if (pipe != INVALID_HANDLE_VALUE) {
            printf("[*] hook pipe already exists, skipping injection\n");
        }
    }
    if (pipe == INVALID_HANDLE_VALUE) {
        if (!InjectDll(process, options.dll_path)) {
            CloseHandle(process);
            return 1;
        }
        const uintptr_t base = FindModuleBase(options.pid, FileNameOf(options.dll_path));
        if (base == 0) {
            printf(
                "[error] %s is not in the target module list; "
                "the load was blocked or reverted\n",
                WideToUtf8(FileNameOf(options.dll_path)).c_str());
            CloseHandle(process);
            return 1;
        }
        printf("[+] injected, %s base = 0x%llx\n",
               WideToUtf8(FileNameOf(options.dll_path)).c_str(),
               static_cast<unsigned long long>(base));
        if (!options.inject_only) {
            pipe = ConnectToHook(options.pid, 8000);
        }
    }
    CloseHandle(process);

    if (options.inject_only) {
        if (pipe != INVALID_HANDLE_VALUE) {
            CloseHandle(pipe);
        }
        printf("[+] inject-only done\n");
        return 0;
    }
    if (pipe == INVALID_HANDLE_VALUE) {
        printf("[error] could not connect to the hook pipe\n");
        return 1;
    }

    if (options.bridge_only) {
        const int install_code = RunInstallMode(pipe, options);
        CloseHandle(pipe);
        return install_code;
    }

    if (options.listen) {
        // RunListenMode releases the control pipe once the bridge is installed.
        return RunListenMode(pipe, options);
    }

    if (options.console_mode) {
        const int console_code = RunConsoleMode(pipe, options);
        CloseHandle(pipe);
        return console_code;
    }

    if (options.commands.empty()) {
        options.commands.emplace_back("info");
        options.commands.emplace_back("modules wrapper");
    }
    if (options.unload) {
        options.commands.emplace_back("unload");
    }

    int exit_code = 0;
    for (const std::string& command : options.commands) {
        if (!poc::WriteFrame(pipe, command)) {
            printf("[error] failed to send command: %s\n", command.c_str());
            exit_code = 1;
            break;
        }
        std::string reply;
        if (!poc::ReadFrame(pipe, reply)) {
            printf("[error] failed to read reply for: %s\n", command.c_str());
            exit_code = 1;
            break;
        }
        printf("[%s]\n%s\n", command.c_str(), reply.c_str());
        if (command == "unload") {
            break;
        }
    }

    CloseHandle(pipe);
    return exit_code;
}
