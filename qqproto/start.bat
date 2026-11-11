@echo off
setlocal
cd /d "%~dp0.."
rem Defaults: no protocol port, debug page on 5150. Open /config to enable.
rem   qqproto\start.bat --protocol both      seed Satori + OneBot on first run
rem   qqproto\start.bat --protocol onebot    seed OneBot only
rem   qqproto\start.bat --ui-port 0          no debug page
node qqproto\index.js %*
