'use strict';

// Stop the QQ instance started by headless_launch.js (headless or --headed),
// and the protocol endpoint it started with --start-endpoint.
//
//   node scripts\headless_stop.js [--profile <dir>] [--pid <qq pid>]
//        [--keep-endpoint] [--endpoint-only]
//
// It refuses to kill a process whose executable is not QQ.exe (resp. node.exe),
// so a stale pid file cannot hit another program. This is an explicit user
// action; the launcher only starts processes.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
function flag(name) { return args.includes(name); }
function valueOf(name) {
  const at = args.indexOf(name);
  const value = at !== -1 ? args[at + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}
const profile = valueOf('--profile')
  ? path.resolve(valueOf('--profile'))
  : path.join(ROOT, 'bin', 'headless');

function imageOf(pid) {
  const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const line = out.split(/\r?\n/).find((row) => row.trim().startsWith('"'));
  return line ? line.split('","')[0].replace(/^"/, '') : '';
}

function readPid(file) {
  try { return String(fs.readFileSync(file, 'utf8').trim()); } catch (e) { return ''; }
}

// Returns true when something was actually killed.
function stopOne(label, file, expectImage, tree) {
  let pid = readPid(file);
  if (label === 'QQ') pid = valueOf('--pid') || pid;
  if (!/^\d+$/.test(pid)) {
    console.log(label + ': no pid in ' + file + ', nothing to do');
    return false;
  }
  let image = '';
  try { image = imageOf(pid); } catch (e) { image = ''; }
  if (image.toLowerCase() !== expectImage) {
    console.error(label + ': ' + pid + ' is ' + (image || 'not running') +
      ', not ' + expectImage + '; not touching it');
    try { fs.rmSync(file, { force: true }); } catch (e) { /* ignore */ }
    return false;
  }
  const killArgs = tree ? ['/PID', pid, '/T', '/F'] : ['/PID', pid, '/F'];
  try {
    process.stdout.write(execFileSync('taskkill', killArgs,
      { encoding: 'utf8', timeout: 30000, windowsHide: true }));
  } catch (e) {
    console.error(label + ': taskkill ' + pid + ' failed: ' + e.message);
    return false;
  }
  try { fs.rmSync(file, { force: true }); } catch (e) { /* ignore */ }
  return true;
}

let stopped = 0;
if (!flag('--endpoint-only')) {
  if (stopOne('QQ', path.join(profile, 'qq.pid'), 'qq.exe', true)) stopped++;
}
if (!flag('--keep-endpoint') && !flag('--pid')) {
  if (stopOne('endpoint', path.join(profile, 'endpoint.pid'), 'node.exe', false)) stopped++;
  // The endpoint normally removes its heartbeat on a clean exit; a taskkill does
  // not run that handler, so the supervisor would otherwise read a stale file.
  try { fs.rmSync(path.join(profile, 'endpoint.health.json'), { force: true }); } catch (e) { /* ignore */ }
}
if (!stopped) console.log('nothing was stopped');
