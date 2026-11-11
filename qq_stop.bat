@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem Stops what qq_start.bat started: the headless QQ and its protocol endpoint.
rem Both are matched by the pid files under qqclient\headless and by their image
rem name, so a stale pid can never hit another program - and your normal QQ is
rem never touched.

node scripts\headless_stop.js --profile "%~dp0qqclient\headless" %*
echo.
