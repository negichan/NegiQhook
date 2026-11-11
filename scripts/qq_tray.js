// Change the QQ tray icon without restarting anything.
//
//   node scripts/qq_tray.js status
//   node scripts/qq_tray.js set C:\path\icon.png [--tooltip "bot"]
//   node scripts/qq_tray.js reset
//
// Electron keeps Tray instances in native code and the bridge is injected after
// QQ created its tray, so the instance is captured the first time QQ updates the
// icon/tooltip after injection (an incoming message or a status change does it).
// Until then `set` explains that and does nothing.
const { execFileSync } = require('child_process');
const path = require('path');

const EXE = path.join(__dirname, '..', 'bin', 'qqinject.exe');
const mode = (process.argv[2] || 'status').toLowerCase();
if (!['status', 'set', 'reset'].includes(mode)) {
  console.error('usage: node scripts/qq_tray.js status|set <png>|reset [--tooltip text]');
  process.exit(2);
}

const send = (cmd) => execFileSync(EXE, ['--cmd', cmd], { encoding: 'utf8', timeout: 60000 });
const stamp = Date.now();
const params = { mode };
if (mode === 'set') {
  const file = process.argv[3];
  if (!file) {
    console.error('set needs an image path: node scripts/qq_tray.js set C:\\path\\icon.png');
    process.exit(2);
  }
  params.file = path.resolve(file);
  const at = process.argv.indexOf('--tooltip');
  if (at !== -1 && process.argv[at + 1]) params.tooltip = process.argv[at + 1];
}

const code = `(() => {
  const st = globalThis.__qqTrayResult = { stamp: ${stamp}, done: false };
  Promise.resolve(globalThis.__qqhookProtoBridge.dispatch('tray_icon', ${JSON.stringify(params)}))
    .then((v) => { st.done = true; st.value = v; },
          (e) => { st.done = true; st.error = String(e && e.message || e); });
  return 'started';
})()`;

send('jseval ' + Buffer.from(code, 'utf8').toString('base64'));

for (let i = 0; i < 20; i++) {
  execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 250'],
    { stdio: 'ignore' });
  const line = send('js JSON.stringify(globalThis.__qqTrayResult)')
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
console.error('timed out waiting for tray_icon');
process.exit(1);
