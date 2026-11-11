@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "ROOT=%CD%"
set "VCVARS="

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
    echo [error] vcvars64.bat not found.
    exit /b 1
)

call "%VCVARS%" >nul
if errorlevel 1 exit /b 1

if not exist "bin\headless" mkdir "bin\headless"
if not exist "build\boot" mkdir "build\boot"

rem /MT: the boot DLL must carry its own runtime. QQ ships msvcp140.dll,
rem ucrtbase.dll and vcruntime140.dll in its install root, and a /MD build binds
rem to whichever copy the loader finds first (the application directory comes
rem before the system directory). That is an ABI we do not control, so appinit.dll
rem is static-linked and depends on nothing but kernel32.
set CFLAGS=/nologo /std:c++17 /EHsc /O2 /W4 /utf-8 /MT /DUNICODE /D_UNICODE

echo [*] building appinit.dll
cl %CFLAGS% /Fo:build\boot\ /Fd:build\boot\appinit.pdb "src\boot\dllmain.cpp" /LD /Fe:"bin\headless\appinit.dll" /link /SUBSYSTEM:WINDOWS
if errorlevel 1 exit /b 1

echo [+] done
