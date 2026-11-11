@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "ROOT=%CD%"
set "DLL_NAME=%~1"
if not defined DLL_NAME set "DLL_NAME=qqhook.dll"
set "VCVARS="

rem Prefer vswhere so VS2019/2022, BuildTools or full IDE all work.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
    for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
        if exist "%%i\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%%i\VC\Auxiliary\Build\vcvars64.bat"
    )
)

if not defined VCVARS if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" (
    set "VCVARS=%ProgramFiles(x86)%\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
)

if not defined VCVARS (
    echo [error] vcvars64.bat not found. Install Visual Studio Build Tools with the C++ workload.
    exit /b 1
)

echo [*] using %VCVARS%
call "%VCVARS%" >nul
if errorlevel 1 exit /b 1

if not exist "bin" mkdir "bin"
if not exist "build\hook" mkdir "build\hook"
if not exist "build\injector" mkdir "build\injector"

set CFLAGS=/nologo /std:c++17 /EHsc /O2 /W4 /utf-8 /DUNICODE /D_UNICODE /I"%ROOT%\src\common"

echo [*] building %DLL_NAME%
cl %CFLAGS% /Fo:build\hook\ /Fd:build\hook\qqhook.pdb "src\hook\dllmain.cpp" /LD /Fe:"bin\%DLL_NAME%" /link /SUBSYSTEM:WINDOWS user32.lib
if errorlevel 1 exit /b 1

echo [*] building qqinject.exe
cl %CFLAGS% /Fo:build\injector\ /Fd:build\injector\qqinject.pdb "src\injector\main.cpp" /Fe:"bin\qqinject.exe" /link /SUBSYSTEM:CONSOLE ws2_32.lib user32.lib
if errorlevel 1 exit /b 1

echo.
echo [+] done: %ROOT%\bin
dir /b "bin"
