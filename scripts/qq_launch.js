'use strict';

// Launch QQ ourselves, with the hook in place before Electron starts.
//
//   node scripts/qq_launch.js [--uin <uin>] [--exe <QQ.exe>] [--dll <dll>]
//                             [--keep-tray] [--no-bridge] [--no-quiet] [--port <n>]
//
// qqinject starts QQ with CREATE_SUSPENDED, injects qqhook.dll, and resumes it.
// The DLL sees QQHOOK_TRAY=0 and patches QQNT.dll's shell32!Shell_NotifyIconW
// import before QQ creates its Tray, so Windows never gets a tray icon to show.
// The protocol bridge is installed after QQ's app main exists; quiet mode then
// hides the BrowserWindows. `--keep-tray` leaves the normal tray icon alone.
//
// The endpoint does not need to be running while this launches: the bridge is a
// TCP client and keeps reconnecting to 127.0.0.1:47840.

const { spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
function valueOf(name) {
  const at = args.indexOf(name);
  const value = at !== -1 ? args[at + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

if (args.includes('-h') || args.includes('--help')) {
  console.log('usage: node scripts/qq_launch.js [--uin <uin>] [--exe <QQ.exe>] [--dll <dll>] [--keep-tray] [--force] [--no-bridge] [--no-quiet] [--port <n>]');
  console.log('  debug path: launches the normal QQ UI with qqhook.dll/V8 eval. Production is qq_start.bat (boot + own app main).');
  process.exit(0);
}

console.log('[debug] qq_launch.js is the attach/V8 path; production uses qq_start.bat (headless boot main).');

const qqinject = path.join(__dirname, '..', 'bin', 'qqinject.exe');
const injectArgs = ['--launch'];
const exe = valueOf('--exe');
if (exe) injectArgs.push(path.resolve(exe));
const dll = valueOf('--dll');
if (dll) injectArgs.push('--dll', path.resolve(dll));
const uin = valueOf('--uin');
if (uin) injectArgs.push('--uin', uin);
if (args.includes('--force')) injectArgs.push('--force');
if (args.includes('--keep-tray')) injectArgs.push('--keep-tray');
const bridge = !args.includes('--no-bridge');
if (bridge) injectArgs.push('--bridge-only', '--port', valueOf('--port') || '47840');

const launched = spawnSync(qqinject, injectArgs, { stdio: 'inherit', timeout: 240000 });
if (launched.error) {
  console.error('launch failed: ' + launched.error.message);
  process.exit(1);
}
if (launched.status !== 0) {
  process.exit(launched.status == null ? 1 : launched.status);
}

if (bridge && !args.includes('--no-quiet')) {
  const quiet = spawnSync(process.execPath, [path.join(__dirname, 'qq_window.js'), 'quiet'], {
    encoding: 'utf8',
    timeout: 90000
  });
  if (quiet.error || quiet.status !== 0) {
    const detail = (quiet.stderr || quiet.stdout || (quiet.error && quiet.error.message) || '').trim();
    console.error('quiet mode failed: ' + detail);
    process.exit(quiet.status || 1);
  }
  const out = (quiet.stdout || '').trim();
  if (out) console.log(out);
}
