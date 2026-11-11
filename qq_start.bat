@echo off
setlocal EnableExtensions
cd /d "%~dp0"
rem A server window has a name in the title bar and on the taskbar, so three open
rem cmd windows are still tellable apart. ASCII only, as everything printed here.
title qq-hook-poc instance console [qqclient]

rem One command, NapCat style: start the headless QQ (the private copy under
rem qqclient\) and print its login QR right here. When the session is ready, this
rem same command starts the protocol endpoint and its debug/chat pages.
rem
rem This window then STAYS as the front of the instance, like a game server
rem console: both logs stream above the prompt, Tab completes, Up/Down is history,
rem and typing `stop` (or Ctrl+C twice) takes the whole thing down. `help` lists
rem everything - status, health, stats, log, friends, groups, say, recall, emit,
rem writes, qr, restart endpoint, config, stop. (--headed = visible QQ window)
rem
rem qqclient\ holding no client is not a stop condition any more: the launcher
rem fetches the official installer, slices the 7z payload out of it and unpacks
rem the tree into qqclient\ before starting (about 1.4 GB, and nothing is written
rem outside this repo). scripts\qq_fetch_client.js does the same on its own.
rem
rem   qq_start.bat --no-download      never go online; fail if the client is gone
rem   qq_start.bat --qq-file X.exe    unpack a client out of an installer you saved
rem   qq_start.bat --allow-mirror     the official CDN refuses some non-browser
rem                                 clients; this permits the community mirror of
rem                                 the same file, verified against its sha256
rem   qq_start.bat --proxy http://host:port   also read from HTTPS_PROXY
rem
rem   qq_start.bat                  uses the cached account (no scan after the
rem                                 first successful login) - QR only if that fails
rem   qq_start.bat --uin 10000002 log in as a specific account from history
rem   qq_start.bat --qr             ignore the cache and show a QR this time
rem   qq_start.bat --forget         drop the cached account
rem   No protocol port is opened by default: turn on Satori or add an OneBot
rem   network on the config page (http://127.0.0.1:5151/config), save, and it
rem   is live - the choice is stored in qqclient\headless\network.json.
rem   qq_start.bat --protocol both  seed Satori + OneBot on first run only
rem   qq_start.bat --protocol onebot  seed OneBot only, no Satori port
rem   qq_start.bat --allow-untested   allow writes on a QQ build outside the tested list
rem   qq_start.bat --no-restart       stop everything if the endpoint dies or hangs
rem   qq_start.bat --read-only        the console's write commands start disabled
rem   qq_start.bat --write-per-minute 10  tighten the bridge write budget
rem   qq_start.bat --detach         leave it all in the background and return now
rem   qq_start.bat --keep-on-exit   do not stop anything when this window ends
rem   qq_start.bat --trace          only when debugging the boot
rem
rem Everything below is fixed so that this copy coexists with your normal client:
rem own data dir, own Electron dir, own bridge port 47841, own endpoint ports.
rem Arguments you type are appended, and a repeated flag uses yours (last wins).

rem Everything printed below stays ASCII on purpose: cmd.exe decodes a batch
rem file with the system ANSI codepage, so UTF-8 Chinese lines turn into stray
rem command fragments that get executed. The launcher prints its own Chinese
rem hints once the session is ready, and those go through Node, not cmd.

echo.
echo  This window is the front of the instance, like a server console: the logs
echo  stream above the prompt, Tab completes, Up/Down walks history, and a command
echo  is one word away.  Type help for the list.  stop or Ctrl+C twice takes the
echo  headless QQ and the protocol endpoint down with it (same as qq_stop.bat).
echo  If QQ dies on its own the window stays open so you can read why.
echo  No client in qqclient\ is fine - it downloads and unpacks one (~1.4 GB,
echo  written inside this repo only); add --no-download to forbid that.
echo  Debug page http://127.0.0.1:5151/   chat page http://127.0.0.1:5151/chat
echo  Config page http://127.0.0.1:5151/config  (WS forward/reverse, HTTP, Satori)
echo  No protocol port is opened until you enable one there and save.
echo  Default token testtoken123; the config page can change every port and token.
echo.

node scripts\headless_launch.js ^
  --exe "%~dp0qqclient\QQ.exe" ^
  --profile "%~dp0qqclient\headless" ^
  --data "%~dp0qqclient\data" ^
  --user-data "%~dp0qqclient\electron" ^
  --port 47841 ^
  --start-endpoint ^
  --ep-port 5141 --protocol none --ui-port 5151 ^
  --ob-port 3100 --ob-ws-port 3101 ^
  --token testtoken123 ^
  --wait 300 %*

echo.
echo  This console is gone, which means the stop output above already ran and
echo  took the QQ instance and the endpoint with it. If the window was killed
echo  instead of left, or --keep-on-exit was used, run qq_stop.bat to finish it.
echo.
