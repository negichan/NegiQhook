'use strict';

// Launch QQ with the protocol bridge already inside it. Two modes:
//
//   headless (default)  QQ runs without its Electron UI (NapCat-style custom app
//                       main), started through the boot DLL.
//   --headed            the normal QQ window and tray. bin\qqhook.dll is injected
//                       before Electron starts and scripts/proto_bridge.js is
//                       installed into it; login and the QR happen in QQ's own
//                       window, so this mode has no qrcode.png to print.
//
//   node scripts/headless_launch.js [--uin <uin>] [--port 47840] [--headed]
//        [--exe <QQ.exe>] [--dll <hook dll>] [--profile <dir>]
//        [--data <dir>] [--user-data <dir>] [--force]
//        [--start-endpoint [--allow-untested] [--no-restart]
//         [--write-per-minute n --write-per-hour n --write-interval ms]]
//        [--wait 60] [--dry-run] [--no-log] [--no-qr] [--ascii] [--trace]
//
// The launcher, headless:
//   1. builds <profile>/app.package.json from QQ's current package.json
//   2. writes <profile>/app.main.js, a generated entry that points at
//      src/headless/app.main.js through Symbol.for('qqhook.root') (so the real
//      directory is known even though Electron sees the logical path under
//      QQ's resources/app)
//   3. copies the protocol bridge into <profile>
//   4. writes <profile>/app.config.json (version/appid/QUA/ports/logs/data and
//      the optional bridge write_budget)
//   5. starts QQ suspended through qqinject --headless, which injects
//      <profile>/appinit.dll and resumes it
//
// The launcher, headed:
//   1. starts QQ suspended through qqinject, injects bin\qqhook.dll, resumes it
//      and has qqinject install scripts/proto_bridge.js into the running app
//   2. starts the endpoint right after (the bridge is a TCP client and retries),
//      then waits for the endpoint log to say the bridge has a logged-in account
//   No app.package.json/app.main.js/app.config.json is written: QQ runs its own
//   main, reads its own files from disk and shows its own login window.
//
// --profile defaults to bin/headless. A second install (e.g. qqclient/QQ.exe)
// should get its own --profile, --data and --user-data so it shares no state
// with the primary client.
//
// appinit.dll redirects resources/app/package.json and app.main.js in memory,
// so no QQ file is modified. app.main.js drives the QQNT wrapper/session
// directly and then loads proto_bridge.js; there are no BrowserWindow/renderer
// processes. The boot DLL restores its hooks and unloads after the boot main is
// read.
//
// When login needs a scan (headless), the qrcode.png the kernel hands back is
// decoded and printed in this console as text (qr_console.js), the way NapCat
// does it, plus the raw qrcode URL. The script keeps tailing after printing, so
// one run covers "scan it" through "session is up". In --headed mode QQ shows
// that code in its own window and this console prints nothing of its own.
//
// QQ must be closed first. QQ is not started as a child of this script (it is
// launched suspended, injected and resumed by qqinject.exe), so this console
// stays the owner of the instance by watching the pid files: it keeps tailing
// the logs and takes commands, and leaving it - Ctrl+C twice, or `stop` - runs
// scripts/headless_stop.js on exactly those two pids. The endpoint is detached
// on purpose: it is the one that survives a window close and takes QQ with it
// (its --watch argument), where this console could not.
//
// The console is a server console, not a banner: `help` lists the commands, the
// log stream never eats the line you are typing, Tab completes, and if QQ dies on
// its own the window stays open with `log`/`health` still working, because a
// console that disappears with the failure takes the evidence with it.
//
// While this console owns the instance it also supervises the endpoint: the
// endpoint rewrites <profile>/endpoint.health.json every 5 seconds, and a dead
// pid or a heartbeat older than 35 seconds restarts it with a capped exponential
// backoff (scripts/lib/restart_policy.js). Five restarts inside five minutes give
// up and stop the instance; --no-restart asks for the old "one crash ends it".
// QQ itself is never auto-restarted: a second login attempt is a risk-control
// decision, not a process-management one.

const { execFileSync, spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HEADLESS = path.join(ROOT, 'bin', 'headless');
const INJECTOR = path.join(ROOT, 'bin', 'qqinject.exe');
const DEFAULT_QQ = 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe';
// The fetcher owns what "there is a client here" means; ask it instead of
// keeping a second, slightly different definition of the same thing.
const { inspectInstall } = require('./qq_fetch_client.js');
const { createRestartPolicy } = require('./lib/restart_policy.js');
const { createServerConsole } = require('./lib/server_console.js');
const { createInstanceConsole } = require('./lib/instance_console.js');
const { readHealth } = require('../qqproto/lib/health.js');

const args = process.argv.slice(2);
// Last occurrence wins: qq_start.bat bakes the defaults, so a flag you type by
// hand has to be able to replace the one that came before it.
function valueOf(name) {
  const at = args.lastIndexOf(name);
  const value = at !== -1 ? args[at + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}
function has(name) { return args.includes(name); }
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
// Every line this script prints goes through one sink. Before the console exists
// that is plain stdout; once it exists the sink is the console's interleaved
// writer, which is what lets a [qq]/[ep] log line land without scrambling the
// half-typed command above it.
let sink = (text) => { process.stdout.write(text + '\n'); };
function log(text) { sink(String(text)); }

if (has('-h') || has('--help')) {
  console.log('usage: node scripts/headless_launch.js [--port 47840] [--headed] [--exe <QQ.exe>] [--dll <hook dll>] [--profile <dir>] [--data <dir>] [--user-data <dir>] [--uin <uin>] [--qr|--forget] [--force] [--wait 60] [--start-endpoint [--token <t>] [--ep-port 5141] [--protocol satori|onebot|both] [--ui-port 5151] [--allow-untested] [--no-restart] [--read-only] [--write-per-minute <n> --write-per-hour <n> --write-interval <ms>] [--ob-port 3100 --ob-ws-port 3101 (only with --protocol onebot|both)]] [--detach] [--keep-on-exit] [--no-qr] [--ascii] [--trace] [--dry-run] [--no-log] [--no-download] [--qq-file <installer.exe>] [--allow-mirror] [--allow-installer] [--proxy <url>]');
  console.log('  --headed: QQ 正常窗口与托盘都留着，bin\\qqhook.dll 注入后装协议桥；登录/扫码在 QQ 自己的窗口里（调试/兼容路径，生产请用默认无头）');
  console.log('  不加 --headed 就是无头：没有窗口/renderer/托盘，二维码打在这个控制台里（默认）');
  console.log('  the endpoint serves one protocol: Satori by default; --protocol both keeps the OneBot ports as well');
  console.log('  the debug page (状态/日志/事件/调用) is http://127.0.0.1:<ep-port + 10>/ ; --ui-port 0 turns it off');
  console.log('  --allow-untested 未验证的 QQ 版本也允许写操作（默认只读；读永远开）');
  console.log('  --write-per-minute <n> / --write-per-hour <n> / --write-interval <ms> 写操作预算（默认 30/分钟、600/小时、间隔 300ms）');
  console.log('  --no-restart 协议端退出/心跳停住时不再自动重启，直接停掉整套（默认最多重试 5 次）');
  console.log('  默认不退出：ready 之后这个控制台持续转发 QQ 与协议端的输出，Ctrl+C 两次或 stop 把两者一起停掉');
  console.log('  控制台就是实例的前台（像服务端窗口）：help 看全部命令，Tab 补全，↑/↓ 历史');
  console.log('  常用：status · health · stats · log qq|ep · friends · groups · members <群> · history <号|g:群>');
  console.log('        say <号|g:群> <文字> · recall <号|g:群> <id> · emit <号|群> <文字> · writes on|off · qr · restart endpoint · stop');
  console.log('  --read-only 这个控制台的写命令（say/recall/emit）一进来就是关的');
  console.log('  --detach 是旧的脚本行为（打完状态就退出，QQ 与协议端留在后台）；--keep-on-exit 退出时什么都不停');
  console.log('  no --uin needed: <profile>\\account.json remembers the last account and quick login is used');
  console.log('  --qr forces a fresh scan, --forget drops the cached account');
  console.log('  no client in --exe 目录? 它自己下载安装包并解出 QQ（--no-download 禁止联网；--qq-file 用你存好的安装包；');
  console.log('  官方 CDN 拒绝本机客户端时 --allow-mirror 用同一个包的社区镜像并核对 sha256；--allow-installer 才跑腾讯自己的安装器）');
  console.log('most people want qq_start.bat in the repo root instead - it is this command with the paths filled in');
  process.exit(0);
}

const uinArg = valueOf('--uin') || '';
const port = Number(valueOf('--port') || 47840);
const exe = path.resolve(valueOf('--exe') || DEFAULT_QQ);
const profile = path.resolve(valueOf('--profile') || HEADLESS);
const dataDir = valueOf('--data') ? path.resolve(valueOf('--data')) : '';
const userDataDir = valueOf('--user-data') ? path.resolve(valueOf('--user-data')) : '';
const waitSeconds = Number(valueOf('--wait') || 60);
const dryRun = has('--dry-run');
// --headed: the normal QQ window/tray instead of the boot-DLL headless start.
const headed = has('--headed');
const noLog = has('--no-log');
const noQr = has('--no-qr');
const asciiQr = has('--ascii');
const traceBoot = has('--trace');
// NapCat-style one-command start: bring the protocol endpoint up as soon as the
// headless session is ready, so the user never has to run a second command.
const withEndpoint = has('--start-endpoint');
const epPort = Number(valueOf('--ep-port') || 5141);
const obPort = Number(valueOf('--ob-port') || 3100);
const obWsPort = Number(valueOf('--ob-ws-port') || 3101);
const epToken = valueOf('--token') || '';
// No protocol port is exposed until it is configured: the endpoint comes up with
// the bridge and the config page only, and the page (or --protocol explicitly)
// starts Satori / OneBot. The debug page lives on its own port so it never gets
// in a client's way.
const epProtocol = (valueOf('--protocol') || 'none').toLowerCase();
// An unverified QQ build keeps reads open but refuses writes unless this is set;
// the flag is handed to qqproto, which owns the policy.
const allowUntested = has('--allow-untested');
// Optional write-budget overrides; 0 means "use the bridge default". They end up
// in app.config.json, which app.main.js hands to proto_bridge.js.
const writePerMinute = Math.max(0, Number(valueOf('--write-per-minute') || 0) || 0);
const writePerHour = Math.max(0, Number(valueOf('--write-per-hour') || 0) || 0);
const writeInterval = Math.max(0, Number(valueOf('--write-interval') || 0) || 0);
// --no-restart: the endpoint is supervised only in the "die -> stop everything"
// sense. The default restarts it with backoff and a health-file watchdog.
const noRestart = has('--no-restart');
const healthFile = path.join(profile, 'endpoint.health.json');
const uiPortArg = valueOf('--ui-port');
// 0 is a real value here: it turns the page off.
const uiPort = uiPortArg === undefined ? epPort + 10 : Number(uiPortArg);
// --detach: the scripted behaviour - print what happened and hand cmd back.
const detachEndpoint = has('--detach');
// --keep-on-exit: leave QQ and the endpoint running when this console ends.
const keepOnExit = has('--keep-on-exit');
let endpointPid = 0;
let endpointStartedAt = 0;
let endpointRestartAt = 0;
let endpointAttempted = false;
let endpointHealthyAt = 0;
// Console state, declared up here because a Ctrl+C during the boot wait reaches
// stopEverything() long before the console section is reached in source order.
let console_ = null;
let attached = false;
let instanceDead = false;
let deadReason = '';
let tailOn = true;
// The console owns colour, but it is built after some callers already exist, so
// every coloured line goes through this indirection.
let painter = (text) => String(text);
const restartPolicy = createRestartPolicy({
  max: 5, baseMs: 1500, maxMs: 20000, windowMs: 300000
});
// where endpoint.log had reached when this run's endpoint started: the file is
// append-only across runs, so the console only replays the current one
let epStart = 0;
const endpointLog = path.join(profile, 'endpoint.log');
// offsets/residue per tailed file; declared up here because headed mode reads
// endpoint.log during the boot wait, before the helpers below are reached
const tails = new Map();
if (!['none', 'satori', 'onebot', 'both'].includes(epProtocol)) {
  console.error('--protocol must be none, satori, onebot or both');
  process.exit(2);
}

// One launcher owns one profile. Without this, two consoles can race the same
// profile: both write app.config.json, both start an endpoint, and the second QQ
// boot sees the first one's pid/port files. The lock is advisory (a killed
// launcher leaves a stale file), so a stale pid is checked against node.exe and
// removed; an unverifiable lock is refused rather than stolen.
const LOCK_FILE = path.join(profile, 'launcher.lock');
const BRIDGE_TOKEN_FILE = path.join(profile, 'bridge.token');
let launchLockHeld = false;
function readLaunchLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch (e) { return null; }
}
function releaseLaunchLock() {
  if (!launchLockHeld) return;
  launchLockHeld = false;
  try { fs.rmSync(LOCK_FILE, { force: true }); } catch (e) { /* ignore */ }
}
function acquireLaunchLock() {
  if (dryRun) return true;
  try { fs.mkdirSync(profile, { recursive: true }); } catch (e) {
    console.error('could not create profile ' + profile + ': ' + e.message);
    return false;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString()
      }) + '\n');
      fs.closeSync(fd);
      launchLockHeld = true;
      process.on('exit', releaseLaunchLock);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        console.error('could not create ' + LOCK_FILE + ': ' + e.message);
        return false;
      }
      const held = readLaunchLock();
      const pid = held && Number(held.pid) || 0;
      const alive = pid ? imageRunning(pid, 'node.exe') : false;
      if (alive === true) {
        console.error('another launcher is running for ' + profile + ' (pid ' + pid + ')');
        return false;
      }
      if (alive === null) {
        console.error('cannot verify the launcher lock held by pid ' + (pid || '?') +
          '; close any old launcher for this profile and retry');
        return false;
      }
      try { fs.rmSync(LOCK_FILE, { force: true }); } catch (e2) { /* ignore */ }
    }
  }
  console.error('could not acquire the launcher lock for ' + profile);
  return false;
}

// The bridge token is a local shared secret between app.main.js and qqproto. It
// is stable per profile so an endpoint that survives --keep-on-exit can accept
// the next bridge, and it is never printed or sent over the network.
function ensureBridgeToken() {
  try {
    const token = fs.readFileSync(BRIDGE_TOKEN_FILE, 'utf8').trim();
    if (/^[0-9a-f]{32,128}$/i.test(token)) return token;
  } catch (e) { /* first run */ }
  try { fs.mkdirSync(profile, { recursive: true }); } catch (e) { /* reported by the caller below */ }
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(BRIDGE_TOKEN_FILE, token + '\n', { mode: 0o600 });
  return token;
}

if (!acquireLaunchLock()) process.exit(1);
let bridgeToken = '';
if (!headed) {
  try {
    bridgeToken = ensureBridgeToken();
  } catch (e) {
    console.error('could not create the bridge token in ' + profile + ': ' + e.message);
    releaseLaunchLock();
    process.exit(1);
  }
}

// Before anything is fetched, copied or logged: is *this* QQ.exe already running?
// The launcher's scope is exactly the --exe path it was given. It does not list,
// report or manage installs outside that path; asking for the matching image path
// only prevents this same copy from being started twice.
if (!dryRun) {
  const mine = runningInstancesAt(exe);
  if (mine && mine.length && !has('--force')) {
    console.error('this copy of QQ is already running (pid ' + mine[0].pid + '): ' + exe);
    console.error('close it first, or pass --force to start another instance');
    process.exit(1);
  }
}

// Account cache: this profile logs in as the account that last got in, so nobody
// scans a QR on every start. --uin wins; --qr (or --fresh) forces a scan by
// ignoring the cache. A quick login that the kernel refuses still falls back to a
// QR inside app.main.js, and the cache is then rewritten with what worked.
//
// Headed mode keeps its own file: it runs QQ's normal profile, whose remembered
// account is whatever that client last used, while the headless main has its own
// data/user-data dirs. Sharing one file would make each mode request the other
// mode's account on the next start (observed: the two clients were logged into
// two different accounts at the same time).
const ACCOUNT_FILE = path.join(profile, headed ? 'account-headed.json' : 'account.json');
function remembered() {
  try {
    const cached = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
    const uin = String(cached.uin || '');
    return /^\d{5,}$/.test(uin) ? cached : null;
  } catch (e) {
    return null;
  }
}
const forcedQr = has('--qr') || has('--fresh');
if (has('--forget')) {
  try { fs.rmSync(ACCOUNT_FILE, { force: true }); log('login     forgot the cached account'); } catch (e) { /* ignore */ }
}
const cached = forcedQr || has('--forget') ? null : remembered();
const uin = uinArg || (cached ? String(cached.uin) : '');
if (!uinArg && cached) {
  log('login     quick as remembered ' + cached.uin +
      (cached.nick ? ' (' + cached.nick + ')' : '') +
      '  [via ' + (cached.via || '?') + ', ' + String(cached.savedAt || '').slice(0, 19) + ']');
} else if (!uin) {
  log('login     QR scan' + (forcedQr ? ' (--qr asked for a fresh scan)' : ' (no cached account yet)'));
}
if (!Number.isFinite(port) || port <= 0 || port > 65535) {
  console.error('--port must be between 1 and 65535');
  process.exit(2);
}

if (!fs.existsSync(INJECTOR)) {
  console.error('missing ' + INJECTOR + '; run build.bat first');
  process.exit(1);
}
// A machine that never had QQ installed should still be able to run
// qq_start.bat: fetch a client into the directory --exe points at. The heavy
// lifting lives in scripts/qq_fetch_client.js and runs as a child process, so
// curl's own progress bar lands in this console and this script stays the
// synchronous thing it has always been. --no-download turns the whole idea off.
function fetchClient() {
  if (has('--no-download')) {
    console.error('client    no client to boot and --no-download forbids fetching one;' +
      ' run scripts\\qq_fetch_client.js yourself (or pass --qq-file <installer.exe>)');
    return false;
  }
  const script = path.join(ROOT, 'scripts', 'qq_fetch_client.js');
  const pull = [script, '--into', path.dirname(exe), '--json'];
  for (const flag of ['--arch', '--proxy', '--qq-file', '--tool', '--cache', '--expect-sha256']) {
    const value = valueOf(flag);
    if (value) pull.push(flag, value);
  }
  for (const flag of ['--allow-mirror', '--allow-installer', '--allow-any-dir']) {
    if (has(flag)) pull.push(flag);
  }
  log('client    no QQ at ' + exe + '; fetching one (scripts\\qq_fetch_client.js)');
  const res = spawnSync(process.execPath, pull, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['inherit', 'pipe', 'inherit'],
    timeout: 3600000
  });
  if (res.error) {
    console.error('client    the fetch process failed: ' + res.error.message);
    return false;
  }
  let report = null;
  try {
    report = JSON.parse(res.stdout);
  } catch (e) {
    console.error('client    the fetch ended without a report (exit ' + res.status + ')');
    return false;
  }
  if (report.action !== 'present' && report.action !== 'installed') {
    console.error('client    ' + report.action + ' (' + (report.reason || '?') + '): ' +
      (report.detail || 'nothing done'));
    return false;
  }
  log('client    ' + report.action + ' QQ ' + report.version + ' at ' + report.into +
    (report.package ? ' from ' + report.package + (report.via ? ' via ' + report.via : '') : ''));
  return true;
}

// The bar is not "QQ.exe is there" but the same check the fetcher uses: the
// version directory, package.json, wrapper.node and QQNT.dll are what the headless
// boot actually reads, so a half-copied client gets fetched over as well.
const missing = inspectInstall(path.dirname(exe));
if (!missing.present && !fetchClient()) {
  console.error('no launchable QQ client at ' + path.dirname(exe) + ' (' + missing.detail +
    '; pass --exe to point at another one, or --qq-file <installer.exe> to unpack it from a file' +
    ' you saved yourself; scripts\\qq_fetch_client.js runs the same thing on its own)');
  process.exit(1);
}
// The DLL differs per mode. Headless injects the boot DLL, which redirects
// resources/app in memory. Headed injects the ordinary runtime hook before
// Electron starts; QQ then runs its own main and reads its own files, so a
// second profile does not need a private copy of anything.
fs.mkdirSync(profile, { recursive: true });
let dll = '';
if (headed) {
  dll = path.resolve(valueOf('--dll') || path.join(ROOT, 'bin', 'qqhook.dll'));
  if (!fs.existsSync(dll)) {
    console.error('missing ' + dll + '; run build.bat first');
    process.exit(1);
  }
} else {
  // A second profile gets its own copy of the boot DLL, because appinit.dll looks
  // for app.package.json/app.main.js next to itself.
  const builtDll = path.join(HEADLESS, 'appinit.dll');
  const profileDll = path.join(profile, 'appinit.dll');
  if (path.resolve(profile) !== path.resolve(HEADLESS)) {
    let copy = true;
    try { copy = fs.statSync(builtDll).mtimeMs > fs.statSync(profileDll).mtimeMs; } catch (e) { /* missing */ }
    if (copy) {
      if (!fs.existsSync(builtDll)) {
        console.error('missing ' + builtDll + '; run build_boot.bat first');
        process.exit(1);
      }
      fs.copyFileSync(builtDll, profileDll);
    }
  }
  dll = path.resolve(valueOf('--dll') || path.join(profile, 'appinit.dll'));
  if (!fs.existsSync(dll)) {
    console.error('missing ' + dll + '; run build_boot.bat first');
    process.exit(1);
  }
}

// null means "could not tell" (tasklist failed or timed out); the tail loop must
// not treat that as "QQ died", which is how a successful run used to come back
// as exit code 1.
function runningQQ() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return out.split(/\r?\n/).some((line) => /^"QQ\.exe"/i.test(line.trim()));
  } catch (e) {
    return null;
  }
}
function pidAlive(pid) {
  if (!pid) return runningQQ();
  try {
    const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return out.split(/\r?\n/).some((line) => /^"QQ\.exe"/i.test(line.trim()));
  } catch (e) {
    return null;
  }
}

// Only the exact --exe copy is returned. Windows has no process lookup by image
// path, so QQ.exe processes are compared locally, but their paths are never
// collected or reported when they are outside this launcher's scope. A process
// whose path cannot be read is not ours; refusing on it would bring back the old
// false positive from the user's separate client.
function runningInstancesAt(targetExe) {
  const expected = path.resolve(targetExe).replace(/[\\/]+/g, '\\').toLowerCase();
  const literal = JSON.stringify(expected);
  const script =
    '$expected = ' + literal + '; ' +
    'Get-CimInstance Win32_Process -Filter "Name=\'QQ.exe\'" | ' +
    'ForEach-Object { ' +
    '$actual = [string]$_.ExecutablePath -replace \'[\\\\/]+\', \'\\\'; ' +
    'if ($actual -and ($actual.ToLower() -ceq $expected)) { ' +
    '[string]$_.ProcessId + \'|\' + $actual } }';
  try {
    const out = execFileSync('powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 25000, windowsHide: true });
    return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const at = line.indexOf('|');
      return {
        pid: Number(at === -1 ? line : line.slice(0, at)) || 0,
        path: at === -1 ? '' : line.slice(at + 1).trim()
      };
    });
  } catch (e) {
    return null;
  }
}

// The "is this copy already running" check happened right after argument
// parsing, before any download or file work; see the comment there.

const exeDir = path.dirname(exe);
const versionsDir = path.join(exeDir, 'versions');
let version = '';
try {
  const versionConfig = JSON.parse(fs.readFileSync(path.join(versionsDir, 'config.json'), 'utf8'));
  version = String(versionConfig.curVersion || '');
} catch (e) { /* fall through */ }
if (!version) {
  try {
    const candidates = fs.readdirSync(versionsDir)
      .filter((name) => /^\d+\.\d+\.\d+-\d+$/.test(name))
      .map((name) => ({
        name,
        mtime: fs.statSync(path.join(versionsDir, name)).mtimeMs
      }))
      .sort((a, b) => b.mtime - a.mtime);
    version = candidates.length ? candidates[0].name : '';
  } catch (e) { /* ignore */ }
}
if (!version) {
  console.error('could not determine QQ version under ' + versionsDir);
  process.exit(1);
}

const packagePath = path.join(versionsDir, version, 'resources', 'app', 'package.json');
let pkg = null;
// Headed mode runs QQ's own main from disk, so it neither reads nor rewrites
// package.json; only headless needs the parsed copy.
if (!headed) {
  try {
    pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch (e) {
    console.error('could not read ' + packagePath + ': ' + e.message);
    process.exit(1);
  }
}

const APPID_TABLE = {
  '9.9.36-53644': { appid: '537391628', qua: 'V1_WIN_NQ_9.9.36_53644_GW_B' },
  '9.9.36-53489': { appid: '537391475', qua: 'V1_WIN_NQ_9.9.36_53489_GW_B' }
};
function readAppidFromMajor() {
  const candidates = [
    path.join(versionsDir, version, 'major.node'),
    path.join(versionsDir, version, 'resources', 'app', 'major.node'),
    path.join(exeDir, 'major.node')
  ];
  for (const file of candidates) {
    try {
      const data = fs.readFileSync(file);
      const marker = Buffer.from('QQAppId/', 'utf8');
      let at = 0;
      while (true) {
        const index = data.indexOf(marker, at);
        if (index === -1) break;
        const start = index + marker.length;
        const end = data.indexOf(0, start);
        if (end === -1) break;
        const value = data.subarray(start, end).toString('utf8');
        if (/^\d+$/.test(value)) return value;
        at = end + 1;
      }
    } catch (e) { /* try next */ }
  }
  return '';
}
let appidInfo = null;
if (!headed) {
  const build = (version.split('-')[1] || '');
  appidInfo = APPID_TABLE[version] || {
    appid: '537246092',
    qua: 'V1_WIN_' + (version.split('-')[0] || version).replace(/\./g, '_') + '_' + build + '_GW_B'
  };
  const majorAppid = readAppidFromMajor();
  if (majorAppid) appidInfo.appid = majorAppid;
}

fs.mkdirSync(profile, { recursive: true });
const appPackage = path.join(profile, 'app.package.json');
const appMain = path.join(profile, 'app.main.js');
const coreJs = path.join(profile, 'core.js');
const configPath = path.join(profile, 'app.config.json');
const appLog = path.join(profile, 'app.log');
const coreLog = path.join(profile, 'core.log');

if (!headed) {
  const packageCopy = Object.assign({}, pkg, { main: './app.main.js' });
  fs.writeFileSync(appPackage, JSON.stringify(packageCopy, null, 2) + '\n');
  // The entry is what Electron loads as resources/app/app.main.js. It hands the
  // real directory to the source before Node resolves anything relative to it.
  const mainSource = path.join(ROOT, 'src', 'headless', 'app.main.js');
  fs.writeFileSync(appMain,
    "'use strict';\n" +
    '// Generated by headless_launch.js; edits belong in src/headless/app.main.js.\n' +
    'globalThis[Symbol.for(\'qqhook.root\')] = ' + JSON.stringify(profile) + ';\n' +
    'require(' + JSON.stringify(mainSource) + ');\n');
  fs.copyFileSync(path.join(ROOT, 'scripts', 'proto_bridge.js'), coreJs);

  const wrapperPath = path.join(versionsDir, version, 'resources', 'app', 'wrapper.node');
  const config = {
    qq_version: version,
    wrapper_path: fs.existsSync(wrapperPath) ? wrapperPath : '',
    appid: String(appidInfo.appid),
    qua: appidInfo.qua,
    bridge_port: port,
    bridge_token: bridgeToken,
    bridge_version: 2,
    bridge_script: coreJs,
    bridge_log: coreLog,
    bridge_log_enabled: !noLog,
    log_file: appLog,
    qr_file: path.join(profile, 'qrcode.png'),
    data_path: dataDir,
    user_data_path: userDataDir,
    write_budget: (writePerMinute || writePerHour || writeInterval)
      ? {
        per_minute: writePerMinute || undefined,
        per_hour: writePerHour || undefined,
        min_interval_ms: writeInterval || undefined
      }
      : null
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

const traceSentinel = path.join(profile, 'appinit.trace');
for (const file of [appLog, coreLog, path.join(profile, 'appinit.log'), path.join(profile, 'app.ready'), path.join(profile, 'app.fatal'), path.join(profile, 'qrcode.png'), path.join(profile, 'qq.pid'), traceSentinel]) {
  try { fs.rmSync(file, { force: true }); } catch (e) { /* ignore */ }
}
if (traceBoot) {
  if (headed) {
    log('trace    只有无头模式用 appinit.trace；有头模式没有这层，忽略 --trace');
  } else {
    // appinit.dll turns on per-call hook logging when this file exists next to it.
    fs.writeFileSync(traceSentinel, '');
    log('trace    on (remove with a re-run without --trace)');
  }
}
if (!headed) {
  try { fs.mkdirSync(path.join(profile, 'files'), { recursive: true }); } catch (e) { /* ignore */ }
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { /* ignore */ }
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (e) { /* ignore */ }
}

log('QQ         ' + exe);
if (headed) {
  log('version    ' + version);
  log('mode       headed: QQ 自己的窗口和托盘都在；登录/扫码在 QQ 窗口里完成（调试/兼容路径）');
  log('hook       ' + dll);
  log('profile    ' + profile);
  if (dataDir || userDataDir) {
    log('note       --data/--user-data 只属于无头模式；有头模式用 QQ 自己的目录，这两项忽略');
  }
  log('bridge     ' + '127.0.0.1:' + port);
  log('auth       off (headed debug path; headless uses a local bridge token)');
  log('logs       ' + path.join(profile, 'endpoint.log'));
} else {
  log('version    ' + version + '  appid=' + appidInfo.appid + '  qua=' + appidInfo.qua);
  log('package    ' + appPackage);
  log('main       ' + appMain);
  log('profile    ' + profile);
  if (dataDir) log('data       ' + dataDir);
  if (userDataDir) log('userData   ' + userDataDir);
  log('config     ' + configPath);
  log('logs       ' + appLog + ' , ' + coreLog);
  log('bridge     ' + '127.0.0.1:' + port + (noLog ? ' (bridge log off)' : ''));
  log('auth       local bridge token ' + (bridgeToken ? 'on' : 'off') +
    ' (profile\\bridge.token; qqproto --bridge-token)');
}
if (dryRun) {
  log(headed ? 'dry-run: launcher and hook are there; QQ not started' : 'dry-run: files generated; QQ not started');
  process.exit(0);
}

const injectArgs = ['--launch', exe, '--dll', dll];
if (headed) {
  // --bridge-only waits for QQ's app main, installs scripts/proto_bridge.js into
  // it and exits. --keep-tray leaves QQ's tray icon alone (this is a normal QQ).
  injectArgs.push('--bridge-only', '--port', String(port), '--keep-tray');
} else {
  injectArgs.push('--headless');
}
if (uin) injectArgs.push('--uin', uin);
if (has('--force')) injectArgs.push('--force');
if (headed) log('QQ 正在启动：有头模式会正常出现 QQ 窗口，登录就在那个窗口里完成');
log('launching: ' + INJECTOR + ' ' + injectArgs.map((x) => /\s/.test(x) ? '"' + x + '"' : x).join(' '));
const launched = spawnSync(INJECTOR, injectArgs, {
  encoding: 'utf8',
  timeout: headed ? 240000 : 120000,
  windowsHide: true
});
if (launched.stdout) process.stdout.write(launched.stdout);
if (launched.stderr) process.stderr.write(launched.stderr);
if (launched.error) {
  console.error('launch failed: ' + launched.error.message);
  process.exit(1);
}
if (launched.status !== 0) {
  process.exit(launched.status || 1);
}
const pidMatch = /launched pid=(\d+)/.exec(launched.stdout || '');
const launchedPid = pidMatch ? Number(pidMatch[1]) : 0;
// The console's uptime clock starts here, at the moment QQ was really handed to
// the OS - not when the script began (that includes the client fetch).
const launchedAt = Date.now();
if (pidMatch) {
  fs.writeFileSync(path.join(profile, 'qq.pid'), pidMatch[1] + '\n');
}
// From here on this console owns the instance: a Ctrl+C during the login scan has
// to clean up too, not only one after the session is up.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => stopEverything(signal + ' 收到了'));
}

// ------------------------------------------------------------ headed start
// Headed mode has no app.ready/app.log: the endpoint log is the only stream we
// can read, and its "QQ bridge ready" line is the one that means "logged in".
// The bridge is a TCP client inside QQ that retries every two seconds, so the
// endpoint may be started after the injection without losing anything.
const headedState = { bridge: 'waiting', uin: '', uid: '', nick: '' };
let headedReady = false;

function rememberHeadedLogin(uinValue, nick, uid) {
  if (!/^\d{5,}$/.test(String(uinValue || ''))) return;
  const cachedNow = remembered();
  const same = cachedNow && String(cachedNow.uin) === String(uinValue);
  const nextUid = uid || (same ? cachedNow.uid || '' : '');
  const nextNick = nick || (same ? cachedNow.nick || '' : '');
  if (same && String(cachedNow.uid || '') === String(nextUid) &&
      String(cachedNow.nick || '') === String(nextNick)) {
    return;
  }
  try {
    fs.writeFileSync(ACCOUNT_FILE, JSON.stringify({
      uin: String(uinValue),
      uid: String(nextUid),
      nick: nextNick,
      via: 'headed',
      savedAt: new Date().toISOString()
    }, null, 2) + '\n');
    log('login     cached ' + uinValue + (nextNick ? ' (' + nextNick + ')' : '') + '  [via headed]');
  } catch (e) { /* the cache is a convenience, never a stop condition */ }
}

// The endpoint's own log is the state machine for headed mode (and also feeds
// /status after the boot wait).
function noteEndpointLine(line) {
  const resolved = /self resolved:\s*(\{.*\})\s*$/.exec(line);
  if (resolved) {
    try {
      const self = JSON.parse(resolved[1]);
      if (self && self.uin) {
        headedState.uid = String(self.uid || '');
        if (headed) {
          rememberHeadedLogin(self.uin, self.nick || headedState.nick, headedState.uid);
        }
      }
    } catch (e) { /* not our line */ }
    return;
  }
  const ready = /QQ bridge ready:\s*(\d+)\s*(.*)$/.exec(line);
  if (ready) {
    headedState.bridge = 'ready';
    headedState.uin = ready[1];
    headedState.nick = (ready[2] || '').trim();
    headedReady = true;
    if (headed) rememberHeadedLogin(headedState.uin, headedState.nick, headedState.uid);
    return;
  }
  if (/QQ bridge connected/.test(line)) {
    headedState.bridge = 'connected';
    return;
  }
  if (/QQ bridge disconnected/.test(line)) {
    headedState.bridge = 'disconnected';
    headedReady = false;
    return;
  }
  if (/bridge RPC listening/.test(line)) {
    if (headedState.bridge === 'waiting') headedState.bridge = 'listening';
  }
}

if (headed && withEndpoint) {
  endpointPid = launchEndpoint();
  // The endpoint log is append-only; start this run's reader where this run's
  // endpoint began, so boot lines from older runs are not replayed.
  seedTail(endpointLog, epStart);
  log('waiting   等 QQ 登录：登录/扫码都在 QQ 自己的窗口里；登进去后协议端会打 [ep] QQ bridge ready');
}


const started = Date.now();
let deadline = started + waitSeconds * 1000;
let tick = 0;
let qrCount = 0;
let qrShown = false;
const qrPng = path.join(profile, 'qrcode.png');
const loginWaitSeconds = Math.max(waitSeconds, 240);

// The boot DLL is the first thing that runs, so its log is the evidence when QQ
// dies before any JS of ours exists. Print its tail on every failure path.
function dumpBootLog(reason) {
  log(reason);
  // Headed mode has no boot DLL and no appinit.log; the endpoint log is the
  // evidence there and it is already being forwarded.
  if (headed) return;
  for (const file of [path.join(profile, 'appinit.log'), path.join(profile, 'app.fatal')]) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) {
      log('  ' + file + ' (empty)');
      continue;
    }
    log('  ' + file + ':');
    for (const line of lines.slice(-12)) log('    ' + line);
  }
}

function printQr(lines) {
  // The kernel gives both a png and its URL. NapCat prints the code as text in
  // the console; qr_console.js decodes the png without any image dependency.
  qrCount++;
  log('');
  log('=== login QR #' + qrCount + ' ==========================================');
  for (const extra of lines) log('[qq] ' + extra);
  if (noQr) {
    log('(open ' + qrPng + ' yourself; --no-qr skipped the text render)');
  } else {
    let rendered = false;
    try {
      const { render } = require(path.join(ROOT, 'scripts', 'qr_console.js'));
      const out = render(fs.readFileSync(qrPng), { ascii: asciiQr });
      log(out.text);
      rendered = true;
      log('modules=' + out.modules + '  png=' + out.size.width + 'x' + out.size.height +
          (asciiQr ? '  (--ascii)' : '  (dark theme prints best; add --ascii if it looks inverted)'));
      log('png file: ' + qrPng + '  (the URL is on the [qq] qrcode saved line above)');
    } catch (e) {
      log('QR text render failed: ' + e.message);
    }
    if (!rendered) log('png: ' + qrPng);
  }
  log('scan it with the phone QQ of the account you want; the endpoint and its debug page come up on their own');
  log('this console keeps watching for ' + loginWaitSeconds + 's more');
  log('==============================================================');
  log('');
  deadline = Math.max(deadline, Date.now() + loginWaitSeconds * 1000);
  qrShown = true;
}

// The endpoint process is started detached with its own log and pid file, so
// that closing the console window (which Windows answers by killing every
// process attached to it) cannot leave QQ running without a protocol end: the
// endpoint outlives the window and its watchdog takes the whole instance down.
// Everything else is supervised from this console - see attach().
//
// Ports and the OneBot state file are chosen per profile (qqclient\headless ->
// 5141/3100/3101), otherwise two endpoints fight over one table.
function launchEndpoint() {
  // bin\headless and qqclient\headless both end in "headless", so the state file
  // is named from the path relative to the repo: onebot-msg-qqclient-headless.json
  const rel = path.relative(ROOT, profile) || path.basename(profile);
  const name = rel.split(path.sep).join('-').replace(/[^A-Za-z0-9_.-]/g, '-');
  const stateFile = path.join('qqproto', 'data', 'onebot-msg-' + name + '.json');
  const epArgs = ['qqproto' + path.sep + 'index.js', '--port', String(epPort),
    '--bridge-port', String(port), '--ob-port', String(obPort),
    '--ob-ws-port', String(obWsPort), '--ob-state', stateFile,
    '--protocol', epProtocol, '--ui-port', String(uiPort),
    '--config-file', path.join(profile, 'network.json'),
    '--health-file', healthFile];
  if (allowUntested) epArgs.push('--allow-untested');
  if (epToken) epArgs.push('--token', epToken);
  if (bridgeToken) epArgs.push('--bridge-token', bridgeToken);
  if (!detachEndpoint) {
    // watch this console: if it dies with the window, the instance must not stay up
    epArgs.push('--watch', String(process.pid), '--owned-qq', String(launchedPid),
      '--instance', profile);
  }
  const epLog = path.join(profile, 'endpoint.log');
  // measured the same way readNewLines() counts: decoded string length, not the
  // byte size - with Chinese in these logs the two differ, and a byte size looks
  // like "the file got shorter", which replays the whole history
  try { epStart = fs.readFileSync(epLog, 'utf8').length; } catch (e) { /* new file */ }
  const out = fs.openSync(epLog, 'a');
  endpointAttempted = true;
  endpointHealthyAt = 0;
  let child = null;
  try {
    child = spawn(process.execPath, epArgs, {
      cwd: ROOT, detached: true, stdio: ['ignore', out, out]
    });
  } catch (e) {
    log('endpoint start failed: ' + e.message);
    endpointStartedAt = Date.now();
    return 0;
  }
  child.unref();
  endpointStartedAt = Date.now();
  try { fs.writeFileSync(path.join(profile, 'endpoint.pid'), child.pid + '\n'); } catch (e) { /* ignore */ }
  log('endpoint pid=' + child.pid + '  protocol=' + epProtocol +
    (epProtocol === 'satori' || epProtocol === 'both'
      ? '  satori http://127.0.0.1:' + epPort + ' ws://127.0.0.1:' + epPort + '/v1/events' : '') +
    (epProtocol === 'onebot' || epProtocol === 'both'
      ? '  onebot http://127.0.0.1:' + obPort + ' ws://127.0.0.1:' + obWsPort : '') +
    (epProtocol === 'none' ? '  （协议端口未预启，以配置页/network.json 为准）' : ''));
  if (uiPort) {
    log('debug page http://127.0.0.1:' + uiPort + '/  (status, logs, events and calls)');
    log('chat page  http://127.0.0.1:' + uiPort + '/chat  (QQ 式聊天界面，收发消息都在这里)');
    log('config page http://127.0.0.1:' + uiPort + '/config  (WS 正反向 / HTTP / Satori，保存即热应用)');
  }
  log('endpoint log ' + path.join(profile, 'endpoint.log'));
  log('endpoint state ' + stateFile);
  return child.pid;
}

let stopping = false;
// One console owns one instance: leaving it (Ctrl+C, /stop, or the window) takes
// the headless QQ and the protocol endpoint with it. headless_stop.js is the same
// command qq_stop.bat runs, and it refuses any pid whose image is not QQ.exe /
// node.exe, so a stale pid file can never hit another program.
function stopEverything(reason, code) {
  if (stopping) return;
  stopping = true;
  // Give the terminal back before the process goes: raw mode and a shown cursor
  // are not something the next command in this window should inherit.
  if (console_) {
    try { console_.stop(); } catch (e) { /* already gone */ }
  }
  log('stopping: ' + reason);
  if (keepOnExit) {
    log('--keep-on-exit: 什么都没停。要收掉就跑 qq_stop.bat');
    releaseLaunchLock();
    process.exit(code || 0);
    return;
  }
  const stopArgs = [path.join(ROOT, 'scripts', 'headless_stop.js'), '--profile', profile];
  if (!withEndpoint) stopArgs.push('--keep-endpoint');
  try {
    const done = spawnSync(process.execPath, stopArgs, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    if (done.stdout) process.stdout.write(done.stdout);
    if (done.stderr) process.stderr.write(done.stderr);
  } catch (e) {
    console.error('stop failed: ' + e.message + '  - use qq_stop.bat');
  }
  releaseLaunchLock();
  process.exit(code || 0);
}

function imageRunning(pid, image) {
  if (!pid) return null;
  try {
    const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const line = out.split(/\r?\n/).find((row) => row.trim().startsWith('"'));
    if (!line) return false;
    return line.split('","')[0].replace(/^"/, '').toLowerCase() === image;
  } catch (e) {
    return null;
  }
}

function isEndpointProcess(pid) {
  if (!pid) return false;
  const script = 'Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(pid) + '" | ' +
    'Select-Object -ExpandProperty CommandLine';
  try {
    const out = execFileSync('powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 25000, windowsHide: true });
    return /qqproto[\\/]+index\.js/i.test(out);
  } catch (e) {
    // PowerShell unavailable or the pid is gone: never kill on an assumption.
    return false;
  }
}

function endpointHealth() {
  let health = null;
  let mtime = 0;
  try {
    mtime = fs.statSync(healthFile).mtimeMs;
    health = readHealth(healthFile);
  } catch (e) { /* not written yet */ }
  return { health, mtime, ageMs: mtime ? Date.now() - mtime : Infinity };
}

// The endpoint is detached and owns the bridge listener, so a dead endpoint is
// recoverable: restart it with backoff, and only give up (stopping QQ too) when
// it keeps dying. A stale health file catches the other failure mode - node.exe
// alive but its event loop wedged - that a pid check alone would miss.
function requestEndpointRestart(reason) {
  if (stopping || !withEndpoint) return;
  if (noRestart) {
    stopEverything('协议端' + reason + '（--no-restart）', 1);
    return;
  }
  const decision = restartPolicy.fail(Date.now());
  if (!decision.allowed) {
    stopEverything('协议端连续异常 ' + restartPolicy.max + ' 次（' + reason + '）；看 ' + endpointLog, 1);
    return;
  }
  log('[ep] ' + reason + '；' + Math.round(decision.delayMs / 1000) + 's 后重启（第 ' +
    decision.attempt + '/' + restartPolicy.max + ' 次）');
  if (endpointPid && imageRunning(endpointPid, 'node.exe') === true &&
      isEndpointProcess(endpointPid)) {
    try { process.kill(endpointPid); } catch (e) { /* already gone */ }
  }
  endpointPid = 0;
  endpointRestartAt = Date.now() + decision.delayMs;
}

function superviseEndpoint() {
  if (!withEndpoint || stopping || !endpointAttempted) return;
  if (endpointRestartAt) {
    if (Date.now() < endpointRestartAt) return;
    endpointRestartAt = 0;
    endpointPid = launchEndpoint();
    if (headed) {
      headedState.bridge = 'waiting';
      headedState.uin = '';
      headedState.nick = '';
      headedReady = false;
    }
    return;
  }
  if (!endpointPid) {
    requestEndpointRestart('没能启动');
    return;
  }
  const alive = imageRunning(endpointPid, 'node.exe');
  if (alive === false) {
    requestEndpointRestart('进程退出（pid ' + endpointPid + '）');
    return;
  }
  if (alive === null) return;
  const beat = endpointHealth();
  if (Date.now() - endpointStartedAt > 20000 && beat.ageMs > 35000) {
    requestEndpointRestart('健康文件 ' + Math.round(beat.ageMs / 1000) + 's 没更新');
    return;
  }
  // Fifteen continuous seconds of a healthy account means the retry budget can
  // reset; a process that dies twice in a minute must not get a fresh five.
  if (beat.mtime && Date.now() - beat.mtime < 15000 && beat.health && beat.health.ok) {
    if (!endpointHealthyAt) endpointHealthyAt = Date.now();
    if (Date.now() - endpointHealthyAt > 15000) restartPolicy.ok();
  } else {
    endpointHealthyAt = 0;
  }
}

// Keep this console as the front of the instance: the logs are forwarded here,
// the login QR keeps printing when it refreshes (headless), and a line of input
// is a command.
//
// The target feel is a game-server window: the log stream runs above a prompt
// that never jumps, every state of the instance is one typed word away, and when
// the instance dies the window stays open so you can read why instead of
// watching it vanish.
//
// (colour goes through the `painter` indirection declared with the other console
// state, because the console object that owns it is built further down)

function portLine() {
  if (!withEndpoint) return '协议端没起（这套实例没带 --start-endpoint）；只有桥端口 127.0.0.1:' + port;
  const parts = [];
  if (epProtocol === 'none') {
    parts.push('协议端口未预启（打开配置页启用 Satori / OneBot）');
  } else {
    if (epProtocol !== 'onebot') parts.push('Satori http://127.0.0.1:' + epPort + '  ws://127.0.0.1:' + epPort + '/v1/events');
    if (epProtocol !== 'satori') parts.push('OneBot http 127.0.0.1:' + obPort + '  ws 127.0.0.1:' + obWsPort);
  }
  if (uiPort) parts.push('调试页 http://127.0.0.1:' + uiPort + '　配置页 /config');
  parts.push('桥 127.0.0.1:' + port);
  return parts.join('　·　');
}

// QQ is gone, so the endpoint has nothing to serve. Stop just that, quietly, and
// keep this window: the failure is only useful if you can still read it.
function stopEndpointOnly(reason) {
  const stopArgs = [path.join(ROOT, 'scripts', 'headless_stop.js'), '--profile', profile, '--endpoint-only'];
  log('stopping endpoint: ' + reason);
  try {
    const done = spawnSync(process.execPath, stopArgs, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    if (done.stdout) process.stdout.write(done.stdout);
    if (done.stderr) process.stderr.write(done.stderr);
  } catch (e) {
    log('协议端没停下来（' + e.message + '）：跑 qq_stop.bat 或 ' + stopArgs.join(' '));
  }
}

// The one path that used to end the process. With a console attached there is no
// reason to: the instance is stopped, but the window is where the evidence lives.
function instanceStopped(reason) {
  if (instanceDead) return;
  if (detachEndpoint) {
    dumpBootLog(reason);
    stopEverything(reason, 1);
    return;
  }
  instanceDead = true;
  deadReason = reason;
  dumpBootLog(reason);
  log(painter('[!] 实例已停止：' + reason, 'red'));
  if (withEndpoint && !keepOnExit) stopEndpointOnly('QQ 已经不在了');
  attach('实例已经停了。log qq / log ep 还能翻现场，stop 关掉这个窗口。');
  // The prompt itself says so: a dead instance with a live-looking prompt is how
  // people end up typing `say` at nothing.
  if (console_) console_.setPrompt('qq[停]> ');
}

// A log line is painted by source, with the few words that mean "look at me"
// pulled forward. Everything else stays plain: a console that colours all text
// colours none of it.
function frontLine(source, line) {
  const prefix = source === 'ep' ? painter('[ep] ', 'magenta') : painter('[qq] ', 'cyan');
  let style = '';
  if (/\[error\]|fatal|失败|熔断|被拒|refus/i.test(line)) style = 'red';
  else if (/\[warn\]|offline|断开|ECONNRESET|result=121|没有|超时/i.test(line)) style = 'yellow';
  else if (/\[info\]|ready|已连接|connected|ok/i.test(line)) style = 'green';
  sink(prefix + (style ? painter(line, style) : line));
}

function attach(readyText) {
  if (attached) return;
  attached = true;
  const epLog = endpointLog;
  // only this run's lines are replayed; endpoint.log is append-only across runs,
  // /log is what shows the older history. Headed already seeded it before the
  // boot wait and must not replay what it printed there.
  if (!tails.has(epLog)) seedTail(epLog, epStart);

  const instance = createInstanceConsole({
    uiPort,
    protocol: epProtocol,
    token: epToken,
    bridgePort: port,
    headed,
    profile,
    healthFile,
    appLog,
    endpointLog: epLog,
    qrPng,
    bootAt: launchedAt,
    writesAllowed: !has('--read-only'),
    launchedPid: () => launchedPid,
    endpointPid: () => endpointPid,
    pidAlive,
    imageRunning,
    dead: () => instanceDead,
    deadReason: () => deadReason,
    portLine,
    paint: (text, style) => painter(text, style),
    log: (text) => sink(String(text)),
    printQr: () => {
      if (headed) {
        sink('有头模式没有二维码文件：二维码就画在 QQ 自己的登录窗口里，用手机 QQ 扫它');
        return;
      }
      if (fs.existsSync(qrPng)) printQr(['(reprint) qrcode saved ' + qrPng + ' 现在缓存的二维码']);
      else sink('没有 ' + qrPng + '：这个账号不需要扫码');
    },
    requestEndpointRestart: (reason) => {
      if (instanceDead) { sink('实例已经停了，重启协议端没有意义（要重来就 stop 后重新跑 qq_start.bat）'); return; }
      requestEndpointRestart(reason);
    },
    stopEverything: (reason) => stopEverything(reason),
    setTail: (value) => { tailOn = value; }
  });

  console_ = createServerConsole({
    prompt: instanceDead ? 'qq[停]> ' : 'qq> ',
    history: [],
    banner: [
      '=== 这个窗口就是这套实例的前台 =====================================',
      (headed ? '有头 QQ' : '无头 QQ') + ' pid=' + launchedPid +
        '　协议端 pid=' + (endpointPid || '-') + '　协议=' + epProtocol,
      portLine(),
      'help 看命令　·　Tab 补全　·　↑/↓ 历史　·　stop 或 Ctrl+C 两次收掉整套',
      '====================================================================' +
        (readyText ? '\n现在：' + readyText : '')
    ],
    commands: instance.commands,
    status: instance.statusLine,
    onInterrupt: () => stopEverything('Ctrl+C'),
    // stdin can be taken away (a task runner, a pipe that ends) without the
    // instance going anywhere: say so and keep tailing, do not exit.
    onEof: () => {
      sink(painter('(输入关了；日志还在流，Ctrl+C 或另开窗口跑 qq_stop.bat 仍然收掉整套)', 'grey'));
    }
  });
  painter = console_.paint;
  sink = (text) => console_.raw(text);
  console_.start();

  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    if (!headed) readNewLines(appLog, logLine);
    readNewLines(epLog, (line) => {
      noteEndpointLine(line);
      if (tailOn) frontLine('ep', line);
    });
    if (!headed && fs.existsSync(path.join(profile, 'app.fatal'))) {
      instanceStopped('app.fatal 出现了（启动失败）');
      return;
    }
    if (ticks % 12 === 0) {
      if (pidAlive(launchedPid) === false) {
        instanceStopped('QQ.exe is no longer running');
        return;
      }
      if (!instanceDead) superviseEndpoint();
    }
  }, 500);
  // referenced on purpose: this interval is what keeps the console alive as the
  // owner of the instance, even after stdin is closed - so it must stay ref'd.
  void timer;

  process.on('SIGHUP', () => stopEverything('SIGHUP'));
  // stay alive: the interval keeps the loop going, this never returns on its own
}

function logLine(line) {
  const qr = /^\S+\s+qrcode saved\s+(\S+)\s+(\S+)/.exec(line);
  if (qr) {
    printQr([line]);
    return;
  }
  if (tailOn) frontLine('qq', line);
}

// Read only what a log file gained since the last call, and only whole lines:
// these files are appended by another process, so an offset can easily land in
// the middle of a line (that is how a bare "...\qqclient\headless" once showed up
// in the console). The unfinished tail waits for the next read.
function readNewLines(file, onLine) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  const state = tails.get(file) || { offset: 0, residue: '' };
  if (text.length < state.offset) {
    state.offset = 0;
    state.residue = '';
  }
  if (text.length === state.offset && !state.residue) return;
  const chunk = text.slice(state.offset);
  state.offset = text.length;
  const parts = (state.residue + chunk).split(/\r?\n/);
  state.residue = parts.pop();
  for (const line of parts) {
    if (line.trim()) onLine(line);
  }
  tails.set(file, state);
}

function seedTail(file, offset) {
  tails.set(file, { offset, residue: '' });
}

// ---------------------------------------------------------------- phase 1
let outcome = 'deadline';
while (Date.now() < deadline) {
  sleepSync(500);
  tick++;
  if (headed) {
    if (withEndpoint) {
      readNewLines(endpointLog, (line) => {
        frontLine('ep', line);
        noteEndpointLine(line);
      });
    }
  } else {
    readNewLines(appLog, logLine);
  }
  if (headed && headedReady) {
    log('QQ is logged in; the protocol bridge is talking to the endpoint');
    outcome = 'ready';
    break;
  }
  if (!headed && fs.existsSync(path.join(profile, 'app.ready'))) {
    let ready = '';
    try { ready = fs.readFileSync(path.join(profile, 'app.ready'), 'utf8').trim(); } catch (e) { /* ignore */ }
    if (ready) log('[qq] ' + ready);
    if (withEndpoint) endpointPid = launchEndpoint();
    log('headless session is up' + (withEndpoint ? '' : '; start qqproto\\start.bat if the endpoint is not running'));
    outcome = 'ready';
    break;
  }
  if (!headed && fs.existsSync(path.join(profile, 'app.fatal'))) {
    instanceStopped('app.fatal 出现了（启动失败）');
    break;
  }
  if (tick % 10 === 0 && pidAlive(launchedPid) === false) {
    instanceStopped('QQ.exe is no longer running');
    break;
  }
  if (headed && endpointPid && tick % 10 === 0) {
    superviseEndpoint();
  }
}

if (outcome === 'deadline') {
  if (headed) {
    log('还在等 QQ 登录（' + waitSeconds + 's）：登录/扫码都在 QQ 自己的窗口里，登进去后这里会打 [ep] 行');
    log('QQ 与协议端都还活着；要收掉就 Ctrl+C 两次或 stop');
  } else if (qrShown) {
    log('no login within ' + loginWaitSeconds + 's of the QR; the QQ process is still alive, log qq 看现场');
  } else {
    log('still starting after ' + waitSeconds + 's; log qq 看现场，status 看进程');
    log('If it is waiting for a QR scan, qr 会把二维码重新画在这里');
  }
}
if (detachEndpoint) {
  // the old scripted behaviour: print what happened and hand the console back
  log('--detach: QQ 与协议端继续在后台跑，这个控制台交还给 cmd');
  process.exit(0);
}
attach(outcome === 'ready'
  ? (headed ? '已登录，协议端在线' : '已经 ready，会话在线')
  : (headed ? 'QQ 在启动/等登录（窗口里完成），登录后这里会提示' : '还在启动/等扫码，二维码会自己打在这里'));

