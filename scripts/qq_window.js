// Put the QQ window away without touching the kernel, or bring it back.
//
//   node scripts/qq_window.js status           list QQ's Electron windows
//   node scripts/qq_window.js hide             hide the main panel once
//   node scripts/qq_window.js show             leave quiet mode, show main panel
//   node scripts/qq_window.js quiet            hide everything, keep the Tray,
//                                              and suppress popups/flashes/sounds
//   node scripts/qq_window.js quiet --no-mute  same, but leave audio alone
//
// `quiet` is the "only a tray icon" mode: every BrowserWindow is hidden, new
// windows (chat/notification popups) are hidden as they are created, taskbar
// flashes and tray balloons are stopped, main-process Notification toasts are
// dropped, web Notifications in each page are stubbed, and the renderers are
// muted. Login/QR windows are never hidden. `show` restores the main panel and
// unmutes whatever quiet mode muted.
const { execFileSync } = require('child_process');
const path = require('path');

const EXE = path.join(__dirname, '..', 'bin', 'qqinject.exe');
const mode = (process.argv[2] || 'status').toLowerCase();
if (!['status', 'hide', 'show', 'quiet'].includes(mode)) {
  console.error('usage: node scripts/qq_window.js status|hide|show|quiet [--no-mute]');
  process.exit(2);
}

const send = (cmd) => execFileSync(EXE, ['--cmd', cmd], { encoding: 'utf8', timeout: 60000 });
const stamp = Date.now();
const params = { mode, mute: !process.argv.includes('--no-mute') };
const code = `(() => {
  const st = globalThis.__qqWindowResult = { stamp: ${stamp}, done: false };
  Promise.resolve(globalThis.__qqhookProtoBridge.dispatch('qq_window', ${JSON.stringify(params)}))
    .then((v) => { st.done = true; st.value = v; },
          (e) => { st.done = true; st.error = String(e && e.message || e); });
  return 'started';
})()`;

send('jseval ' + Buffer.from(code, 'utf8').toString('base64'));

for (let i = 0; i < 20; i++) {
  execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 250'],
    { stdio: 'ignore' });
  const line = send('js JSON.stringify(globalThis.__qqWindowResult)')
    .split('\n').map((s) => s.trim()).find((s) => s.startsWith('{'));
  if (!line) continue;
  const state = JSON.parse(line);
  if (state.stamp !== stamp || !state.done) continue;
  if (state.error) {
    console.error(state.error);
    process.exit(1);
  }
  console.log(JSON.stringify(state.value, null, 2));
  process.exit(0);
}
console.error('timed out waiting for qq_window');
process.exit(1);
