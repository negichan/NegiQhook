#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cstdint>
#include <cstdio>
#include <string>

// Minimal length-prefixed framing shared by the injector and the injected DLL.
// Layout: uint32 little-endian payload size, then UTF-8 payload bytes.
namespace poc {

constexpr uint32_t kMaxFrameBytes = 1u << 20;  // 1 MiB

inline std::wstring PipeNameForPid(DWORD pid) {
    wchar_t buf[64] = {};
    swprintf_s(buf, L"\\\\.\\pipe\\qqhookpoc_%lu", static_cast<unsigned long>(pid));
    return std::wstring(buf);
}

inline bool WriteAll(HANDLE pipe, const void* data, DWORD size) {
    const char* cursor = static_cast<const char*>(data);
    while (size > 0) {
        DWORD written = 0;
        if (!WriteFile(pipe, cursor, size, &written, nullptr) || written == 0) {
            return false;
        }
        cursor += written;
        size -= written;
    }
    return true;
}

inline bool ReadAll(HANDLE pipe, void* data, DWORD size) {
    char* cursor = static_cast<char*>(data);
    while (size > 0) {
        DWORD read = 0;
        if (!ReadFile(pipe, cursor, size, &read, nullptr) || read == 0) {
            return false;
        }
        cursor += read;
        size -= read;
    }
    return true;
}

inline bool WriteFrame(HANDLE pipe, const std::string& payload) {
    if (payload.size() > kMaxFrameBytes) {
        return false;
    }
    const uint32_t size = static_cast<uint32_t>(payload.size());
    return WriteAll(pipe, &size, sizeof(size)) &&
           (size == 0 || WriteAll(pipe, payload.data(), size));
}

inline bool ReadFrame(HANDLE pipe, std::string& payload) {
    uint32_t size = 0;
    if (!ReadAll(pipe, &size, sizeof(size)) || size > kMaxFrameBytes) {
        return false;
    }
    payload.resize(size);
    return size == 0 || ReadAll(pipe, payload.data(), size);
}

}  // namespace poc
