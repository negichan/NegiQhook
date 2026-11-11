'use strict';

// Get a private QQ NT client into a directory, so qq_start.bat works on a
// machine that has never had one installed.
//
//   node scripts\\qq_fetch_client.js [--into <dir>] [--check] [--force] [--json]
//        [--qq-file <installer.exe>] [--no-download] [--allow-mirror]
//        [--allow-installer] [--proxy <url>] [--arch x64|x86|arm64]
//        [--tool <7z.exe>] [--expect-sha256 <hex>] [--timeout <sec>]
//        [--dry-run] [--quiet]
//
// The order of work: look first, go online only when the client really is
// missing.
//   1. inspectInstall() - QQ.exe plus versions/<v>/resources/app/{package.json,
//      wrapper.node} and versions/<v>/QQNT.dll. That is exactly what the
//      headless boot reads, so "present" means "launchable", not "something is
//      there".
//   2. resolve - pcConfig.json is the file the official download page itself
//      reads (qq-web.cdn-go.cn, with the im.qq.com proxy as its fallback) and it
//      gives version/updateDate plus the installer URL per architecture.
//   3. download - curl.exe from System32 with --retry and resume into a .part;
//      --qq-file skips the network entirely.
//   4. verify - sha256 of the package against --expect-sha256, or against the
//      digest the mirror publishes for its own asset. Nothing is unpacked over a
//      mismatch.
//   5. extract - a 7-Zip binary if one can be found, which is how NapCat's own
//      release workflow unpacks this exact package (7z x -y -o<dir> QQ_*.exe);
//      otherwise, and only with --allow-installer, the package's own silent
//      switches. Every attempt is judged by the tree it leaves behind, never by
//      its exit code.
//   6. assemble - move that tree into --into and prune what this repo has no
//      business running (LiteLoaderQQNT*, beacon_report.log).
//
// Why the fallbacks exist: on 2026-10-27 the official CDN refused every
// non-browser client this machine tried - qqdl.gtimg.cn answers 403 for
// /qqfile/QQNTV2/... to curl (Schannel), to Node https, to WinHTTP and even
// through the local proxy, while the same host happily serves its older
// /qqfile/qq/PCQQ/ path. So --qq-file (save it in a browser yourself) and
// --allow-mirror (Rodert/qq-versions, a community mirror of the identical
// official installer, which is what NapCat's CI pulls and which publishes a
// sha256 per asset we verify before use) are first-class, not hacks.
//
// Nothing here touches "C:\\Program Files\\Tencent\\QQNT" unless --into points at
// it, and no running QQ is killed.

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// The config the official page reads, then the same path through its proxy.
const CONFIG_URLS = [
  'https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json',
  'https://im.qq.com/proxy/domain/qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json'
];
const ARCH_FIELDS = { x64: 'ntDownloadX64Url', x86: 'ntDownloadUrl', arm64: 'ntDownloadARMUrl' };

// Community mirror of the official packages. GitHub's API publishes a sha256
// digest for every asset here.
const MIRROR_API = 'https://api.github.com/repos/Rodert/qq-versions/releases?per_page=20';

// 7-Zip binaries, best first: a full 7z.exe loads 7z.dll and so knows every
// format handler, while the standalone 7za/7zr builds only read
// 7z/zip/cab/xz/lzma and may not know this container at all.
const TOOL_NAMES = ['7z.exe', '7z', '7za.exe', '7za'];
const TOOL_DIRS = [
  'C:\\Program Files\\7-Zip',
  'C:\\Program Files (x86)\\7-Zip',
  path.join(ROOT, 'bin', '7zip')
];

// Silent switch sets for the package's own installer. The container is not
// NSIS: it ends in an XML task graph from Tencent's installer engine
// (SetupConfigure, ShowInstallDialog, KillTencentProcess), which a 2024 write-up
// of the classic QQ package documents as `/ai /gm2 /InstallPath=<dir>`, while
// the generic silent-install lists say `/S`. Neither is verified for 9.9.36 yet,
// so each set is tried and judged by the tree it leaves in the target.
const SILENT_PLANS = [
  (dir) => ['/S', '/D=' + dir],
  (dir) => ['/ai', '/gm2', '/InstallPath=' + dir],
  () => ['/S'],
  (dir) => ['/silent', '/Dir=' + dir]
];

// What this repo must never leave inside a client tree it fetched itself.
const PRUNES = [/^LiteLoaderQQNT/i, /^beacon_report\.log$/i];

// ---------------------------------------------------------------- plumbing

// Run and wait. stdio is inherited only when asked (curl's own progress bar),
// otherwise both streams are captured so a failure can be reported in one line.
function run(file, args, opts = {}) {
  const res = spawnSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    cwd: opts.cwd,
    timeout: opts.timeoutMs || 120000,
    stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']
  });
  if (res.error) {
    return { code: -1, out: '', err: String(res.error.message), killed: res.error.code === 'ETIMEDOUT' };
  }
  return { code: res.status, out: res.stdout || '', err: res.stderr || '', killed: res.signal != null };
}

function lastLine(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  return lines.length ? lines[lines.length - 1] : '';
}

function curlExe() {
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
  return fs.existsSync(system) ? system : 'curl';
}

// GET a small body as text. Returns { text } or { error }.
function fetchText(url, opts = {}) {
  const fetch = (opts.proxy ? ['-x', opts.proxy] : []);
  const args = fetch.concat([
    '-fsSL', '--max-time', String(opts.timeoutSec || 30),
    '-A', UA,
    '--header', 'Accept: ' + (opts.accept || 'application/json, text/plain, */*')
  ]);
  args.push(url);
  const sec = opts.timeoutSec || 30;
  const res = (opts.run || run)(curlExe(), args, { timeoutMs: sec * 1000 + 5000 });
  if (res.code !== 0) {
    return { error: 'exit ' + res.code + (res.killed ? ' (timed out)' : '') + ' ' + lastLine(res.err) };
  }
  if (res.out.length > 8 * 1024 * 1024) return { error: 'body over 8 MB from ' + url };
  return { text: res.out };
}

// Download into a .part and rename when the whole body is there, resuming the
// .part a previous run left behind.
function downloadFile(url, dest, opts = {}) {
  const part = dest + '.part';
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
  } catch (e) {
    return { error: 'cannot create ' + path.dirname(dest) + ': ' + e.message };
  }
  let have = 0;
  try {
    have = fs.statSync(part).size;
  } catch (e) { /* nothing cached */ }
  if (have && opts.resume === false) {
    try {
      fs.rmSync(part, { force: true });
    } catch (e) { /* ignore */ }
    have = 0;
  }
  const sec = opts.timeoutSec || 1800;
  const args = [
    '-fSL', '--retry', '3', '--retry-delay', '3', '--retry-all-errors',
    '--connect-timeout', '15', '--max-time', String(sec),
    '-A', UA, '-o', part
  ];
  if (opts.proxy) args.splice(0, 0, '-x', opts.proxy);
  if (have) args.push('-C', String(have));
  args.push(url);
  const runner = opts.run || run;
  const res = runner(curlExe(), args, { inherit: !opts.quiet, timeoutMs: sec * 1000 + 30000 });
  if (res.code !== 0) {
    return { error: 'curl exit ' + res.code + (res.killed ? ' (timed out)' : '') + ' ' + lastLine(res.err) };
  }
  try {
    fs.renameSync(part, dest);
  } catch (e) {
    return { error: 'cannot move the finished download onto ' + dest + ': ' + e.message };
  }
  let size = 0;
  try {
    size = fs.statSync(dest).size;
  } catch (e) {
    return { error: 'the download vanished before it could be checked' };
  }
  return { file: dest, size, resumed: have };
}

// Streaming sha256 of a file, as lowercase hex.
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// ---------------------------------------------------------------- inspect

// What the headless boot needs to find in a client directory: "present" means
// launchable, not merely non-empty.
function inspectInstall(dir) {
  const root = path.resolve(dir || path.join(ROOT, 'qqclient'));
  const exe = path.join(root, 'QQ.exe');
  const versions = path.join(root, 'versions');
  const missing = [];
  if (!fs.existsSync(exe)) missing.push('QQ.exe');
  let version = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(versions, 'config.json'), 'utf8'));
    version = String(cfg.curVersion || '');
  } catch (e) { /* no config.json: fall back to the directory names */ }
  if (!version) {
    try {
      const names = fs.readdirSync(versions)
        .filter((name) => /^\d+\.\d+\.\d+-\d+$/.test(name))
        .map((name) => {
          let mtime = 0;
          try {
            mtime = fs.statSync(path.join(versions, name)).mtimeMs;
          } catch (e) { /* ignore */ }
          return { name, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
      if (names.length) version = names[0].name;
    } catch (e) { /* no versions directory at all */ }
  }
  if (!version) {
    missing.push('versions/<version>');
  } else {
    const app = path.join(versions, version, 'resources', 'app');
    const need = [
      [path.join(app, 'package.json'), version + '/resources/app/package.json'],
      [path.join(app, 'wrapper.node'), version + '/resources/app/wrapper.node'],
      [path.join(versions, version, 'QQNT.dll'), version + '/QQNT.dll']
    ];
    for (const [file, label] of need) {
      if (!fs.existsSync(file)) missing.push(label);
    }
  }
  return {
    present: missing.length === 0,
    root,
    exe,
    version,
    missing,
    detail: missing.length ? 'missing ' + missing.join(', ') : 'QQ ' + version + ' at ' + root
  };
}

// The shallowest directory under dir that holds a QQ.exe: 7-Zip may unpack the
// tree into a folder of its own, and the silent installer never tells us which
// one it picked.
function findInstallRoot(dir, depth) {
  const level = depth || 0;
  if (level > 4) return '';
  if (fs.existsSync(path.join(dir, 'QQ.exe'))) return dir;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return '';
  }
  for (const name of names) {
    let isDir = false;
    try {
      isDir = fs.statSync(path.join(dir, name)).isDirectory();
    } catch (e) {
      continue;
    }
    if (!isDir) continue;
    const found = findInstallRoot(path.join(dir, name), level + 1);
    if (found) return found;
  }
  return '';
}

// ----------------------------------------------------------------- sources

// The official page's own config: version, update date, and the installer URL
// for the architecture asked for.
function officialPackage(opts) {
  const fetch = opts.fetch || fetchText;
  let last = 'nothing tried';
  for (const url of CONFIG_URLS) {
    const got = fetch(url, opts);
    if (got.error) {
      last = url + ': ' + got.error;
      continue;
    }
    let cfg = null;
    try {
      cfg = JSON.parse(got.text);
    } catch (e) {
      last = url + ': not JSON (' + e.message + ')';
      continue;
    }
    const win = cfg && cfg.Windows;
    const field = ARCH_FIELDS[opts.arch] || ARCH_FIELDS.x64;
    if (!win || !win.version || !win[field]) {
      last = url + ': no Windows.' + field;
      continue;
    }
    let name = String(win[field]).split('/').pop();
    try {
      name = decodeURIComponent(new URL(win[field]).pathname.split('/').pop());
    } catch (e) { /* keep the rough name */ }
    return {
      kind: 'official',
      version: String(win.version),
      updateDate: String(win.updateDate || ''),
      url: win[field],
      name,
      sha256: ''
    };
  }
  return { error: 'no official download config (' + last + ')' };
}

// 9.9.36 is newer than 9.9.9, so compare numbers, not strings.
function compareVersions(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

// The community mirror: newest Windows build it carries, with the sha256 the
// GitHub API publishes for that very asset. When the official version is known
// but the mirror has not caught up, the newest one is offered with a note.
function mirrorPackage(opts) {
  const fetch = opts.fetch || fetchText;
  const got = fetch(MIRROR_API, Object.assign({}, opts, { accept: 'application/vnd.github+json' }));
  if (got.error) return { error: 'mirror API (' + got.error + ')' };
  let releases = null;
  try {
    releases = JSON.parse(got.text);
  } catch (e) {
    return { error: 'mirror API is not JSON' };
  }
  if (!Array.isArray(releases)) return { error: 'mirror API is not a list' };
  const arch = opts.arch || 'x64';
  const pattern = new RegExp('^QQ_[\\d.]+_\\d+_' + arch + '_01\\.exe$');
  const picks = [];
  for (const release of releases) {
    for (const asset of (release && release.assets) || []) {
      const name = String(asset.name || '');
      if (!pattern.test(name)) continue;
      const digest = String(asset.digest || '');
      if (!/^sha256:[0-9a-f]{64}$/i.test(digest)) continue;
      picks.push({
        kind: 'mirror',
        version: (name.match(/^QQ_([\d.]+)_/) || [])[1] || '',
        updateDate: String(release.published_at || '').slice(0, 10),
        url: asset.browser_download_url,
        name,
        size: asset.size || 0,
        sha256: digest.slice(7).toLowerCase()
      });
    }
  }
  if (!picks.length) return { error: 'mirror carries no Windows ' + arch + ' package' };
  picks.sort((a, b) => compareVersions(b.version, a.version));
  if (opts.version && picks[0].version !== opts.version) {
    const same = picks.find((p) => p.version === opts.version);
    if (!same) {
      return Object.assign({}, picks[0], {
        note: 'mirror carries no ' + opts.version + ', so ' + picks[0].version + ' is used instead'
      });
    }
    return same;
  }
  return picks[0];
}

// ------------------------------------------------------------- the payload

// A HummerSetup package is a PE stub with more than one 7z archive appended to
// it: a small one that carries the licence text, and then the client itself.
// 7-Zip opens the first signature it finds, so handing it the .exe unpacks the
// licence and nothing else - the client has to be sliced out of the package
// before any archive tool can read it. Verified on QQ_9.9.33_260813_x64_01.exe
// on 2026-10-27: signatures at 132120 (28 KB, the licence rtf), 160568
// (311776517 bytes, Files/QQ.exe plus Files/versions/9.9.33-52230, 1868 files,
// 1.15 GB unpacked) and 311937088 (the payload's own end header).
const SEVENZ_SIG = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const SEVENZ_START_SIZE = 32;
// Anything smaller than this is a licence, not a client.
const SEVENZ_MIN_PAYLOAD = 8 * 1024 * 1024;

// Every signature-shaped run in the file. Four in 300 MB, so scanning is cheap;
// the false hits compressed noise produces are dropped by sevenZAt.
function sevenZSignatures(file) {
  const found = [];
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const chunk = Buffer.allocUnsafe(8 * 1024 * 1024);
    let carry = Buffer.alloc(0);
    let pos = 0;
    while (pos < size && found.length <= 64) {
      const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
      if (read <= 0) break;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      let at = 0;
      while (true) {
        at = data.indexOf(SEVENZ_SIG, at);
        if (at === -1) break;
        found.push(pos - carry.length + at);
        at += 1;
      }
      carry = Buffer.from(data.subarray(Math.max(0, data.length - SEVENZ_SIG.length + 1)));
      pos += read;
    }
  } catch (e) {
    return found;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (e) { /* already closed */ }
    }
  }
  return found;
}

// A 7z StartHeader carries a CRC32 of its own last 20 bytes and says where the
// archive ends, so an offset that passes both is not a guess: 32 + NextHeaderOffset
// + NextHeaderSize bytes, which must still fit inside the file.
function sevenZAt(file, offset, fileSize) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.allocUnsafe(SEVENZ_START_SIZE);
    if (fs.readSync(fd, head, 0, SEVENZ_START_SIZE, offset) < SEVENZ_START_SIZE) return null;
    if (!head.subarray(0, SEVENZ_SIG.length).equals(SEVENZ_SIG)) return null;
    if (typeof zlib.crc32 === 'function') {
      const stored = head.readUInt32LE(8) >>> 0;
      if ((zlib.crc32(head.subarray(12, SEVENZ_START_SIZE)) >>> 0) !== stored) return null;
    }
    const nextOffset = Number(head.readBigUInt64LE(12));
    const nextSize = Number(head.readBigUInt64LE(20));
    if (!Number.isFinite(nextOffset) || !Number.isFinite(nextSize)) return null;
    const size = SEVENZ_START_SIZE + nextOffset + nextSize;
    if (size <= 0 || size > fileSize - offset) return null;
    return { offset, size };
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (e) { /* already closed */ }
    }
  }
}

// The biggest archive in the package is the client.
function findSevenZPayload(file) {
  let fileSize = 0;
  try {
    fileSize = fs.statSync(file).size;
  } catch (e) {
    return null;
  }
  let best = null;
  for (const offset of sevenZSignatures(file)) {
    const at = sevenZAt(file, offset, fileSize);
    if (!at) continue;
    if (!best || at.size > best.size) best = at;
  }
  if (!best || best.size < SEVENZ_MIN_PAYLOAD) return null;
  return { file, offset: best.offset, size: best.size, fileSize };
}

// Copy that range out so an archive tool can open it as the archive it is.
function sliceSevenZ(file, payload, dest) {
  return new Promise((resolve) => {
    const from = fs.createReadStream(file, {
      start: payload.offset,
      end: payload.offset + payload.size - 1
    });
    const to = fs.createWriteStream(dest);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    from.on('error', (e) => finish({ error: 'cannot read the payload of ' + file + ': ' + e.message }));
    to.on('error', (e) => {
      from.destroy();
      finish({ error: 'cannot write ' + dest + ': ' + e.message });
    });
    to.on('close', () => finish({ file: dest, size: payload.size }));
    from.pipe(to);
  });
}

// ---------------------------------------------------------------- extract

// Every 7-Zip binary this machine already has, best first, deduped.
function findSevenZip(extra) {
  const found = [];
  const seen = new Set();
  const push = (file) => {
    if (!file) return;
    let full = '';
    try {
      full = path.resolve(file);
      if (!fs.statSync(full).isFile()) return;
    } catch (e) {
      return;
    }
    const key = full.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(full);
  };
  push(extra);
  const dirs = [];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) dirs.push(dir);
  }
  for (const dir of TOOL_DIRS) dirs.push(dir);
  for (const dir of dirs) {
    for (const name of TOOL_NAMES) push(path.join(dir, name));
  }
  return found;
}

// One extraction attempt: run it, then judge the tree it left behind. An exit
// code of 0 with no client under the work dir is still a failure, and the note
// says so.
function attempt(label, perform, work, opts) {
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch (e) { /* the work dir may not exist yet */ }
  try {
    fs.mkdirSync(work, { recursive: true });
  } catch (e) {
    return { label, root: '', note: 'cannot create ' + work + ': ' + e.message };
  }
  const res = perform(work);
  const root = findInstallRoot(work);
  const state = root ? inspectInstall(root) : null;
  if (root && state.present) return { label, root, via: label, note: '' };
  const tail = lastLine(res.err || res.out);
  return {
    label,
    root: '',
    note: (root ? 'incomplete tree (' + state.detail + ')' : 'no QQ.exe under ' + work) +
      ' [' + label + ': ' + (res.killed ? 'timed out' : 'exit ' + res.code) + (tail ? '; ' + tail : '') + ']'
  };
}

// The npm registry answer for the 7-Zip binaries electron-builder ships, so the
// extractor itself can be fetched and pinned instead of asking the user to
// install one. 7zip-bin carries 7za (the standalone build): it reads 7z, which
// is exactly the payload format inside the package. The tarball's own sha512
// from the registry is verified before anything in it is run, and only the
// Windows x64 binary is copied out.
const EXTRACTOR_PKG = '7zip-bin';
const NPM_META = 'https://registry.npmjs.org/' + EXTRACTOR_PKG;
const EXTRACTOR_BIN = 'package/win/x64/7za.exe';

function tarExe() {
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(system) ? system : 'tar';
}

// npm's integrity is "sha512-<base64 of the raw digest>", so hash the bytes and
// compare the base64 of the digest, not its hex.
function matchesIntegrity(bytes, integrity, shasum) {
  if (/^sha512-/.test(integrity || '')) {
    const want = integrity.slice(7);
    const got = crypto.createHash('sha512').update(bytes).digest('base64');
    return want === got;
  }
  if (/^sha1-/.test(integrity || '')) {
    return integrity.slice(5) === crypto.createHash('sha1').update(bytes).digest('base64');
  }
  if (shasum) return String(shasum).toLowerCase() === crypto.createHash('sha1').update(bytes).digest('hex');
  return false;
}

// Put a 7za under this repo's bin/7zip and say where it came from. Returns
// { tool } or { error }; never silent about what it fetched.
async function bootstrapSevenZip(opts) {
  const log = opts.log || (() => {});
  const home = path.resolve(opts.dir || path.join(ROOT, 'bin', '7zip'));
  const tool = path.join(home, '7za.exe');
  if (fs.existsSync(tool)) {
    return { tool, note: 'using the cached ' + path.basename(tool) };
  }
  const fetch = opts.fetch || fetchText;
  const meta = fetch(NPM_META, { proxy: opts.proxy, accept: 'application/json' });
  if (meta.error) return { error: NPM_META + ': ' + meta.error };
  let doc = null;
  try {
    doc = JSON.parse(meta.text);
  } catch (e) {
    return { error: 'npm metadata is not JSON' };
  }
  const version = (doc['dist-tags'] || {}).latest || '';
  const dist = ((doc.versions || {})[version] || {}).dist || {};
  if (!dist.tarball || (!dist.integrity && !dist.shasum)) {
    return { error: 'npm metadata for ' + EXTRACTOR_PKG + '@' + (version || '?') + ' has no pinned tarball' };
  }
  const tgz = path.join(home, EXTRACTOR_PKG + '-' + version + '.tgz');
  try {
    fs.mkdirSync(home, { recursive: true });
  } catch (e) {
    return { error: 'cannot create ' + home + ': ' + e.message };
  }
  let bytes = null;
  if (fs.existsSync(tgz)) {
    try {
      bytes = fs.readFileSync(tgz);
    } catch (e) { /* re-download it */ }
    if (bytes && !matchesIntegrity(bytes, dist.integrity, dist.shasum)) bytes = null;
  }
  if (!bytes) {
    log('extractor none on this machine; fetching ' + EXTRACTOR_PKG + '@' + version + ' from ' + dist.tarball);
    const got = (opts.download || downloadFile)(dist.tarball, tgz, {
      proxy: opts.proxy,
      timeoutSec: opts.timeoutSec || 300,
      quiet: opts.quiet,
      run: opts.run
    });
    if (got.error) return { error: 'cannot fetch the extractor: ' + got.error };
    try {
      bytes = fs.readFileSync(got.file || tgz);
    } catch (e) {
      return { error: 'the fetched extractor vanished: ' + e.message };
    }
  } else {
    log('extractor using the verified ' + path.basename(tgz) + ' already in ' + home);
  }
  if (!matchesIntegrity(bytes, dist.integrity, dist.shasum)) {
    return {
      error: 'the fetched ' + EXTRACTOR_PKG + ' tarball does not match the sha512 the registry publishes ' +
        'for ' + version + ', so nothing from it was run'
    };
  }
  const work = path.join(home, 'unpack-' + process.pid);
  try {
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
  } catch (e) {
    return { error: 'cannot create ' + work + ': ' + e.message };
  }
  // the tarball is a .tar.gz: System32's bsdtar reads it, no third-party binary
  // is needed to open the door to the one we do run
  const untar = (opts.run || run)(tarExe(), ['-xzf', tgz, '-C', work], { timeoutMs: 120000 });
  const inside = path.join(work, EXTRACTOR_BIN);
  if (untar.code !== 0 || !fs.existsSync(inside)) {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (e) { /* best effort */ }
    return {
      error: 'cannot unpack ' + path.basename(tgz) + ' with ' + path.basename(tarExe()) +
        ' (exit ' + untar.code + (lastLine(untar.err) ? '; ' + lastLine(untar.err) : '') + ')'
    };
  }
  try {
    fs.copyFileSync(inside, tool);
    fs.chmodSync(tool, 0o755);
    fs.writeFileSync(path.join(home, 'installed.json'), JSON.stringify({
      package: EXTRACTOR_PKG,
      version,
      tarball: dist.tarball,
      integrity: dist.integrity || ('sha1-' + dist.shasum),
      binary: EXTRACTOR_BIN,
      fetchedAt: new Date().toISOString()
    }, null, 2) + '\n');
  } catch (e) {
    return { error: 'cannot install ' + tool + ': ' + e.message };
  }
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch (e) { /* best effort */ }
  log('extractor ' + tool + ' (from ' + EXTRACTOR_PKG + '@' + version + ', sha512 verified)');
  return { tool };
}

// 7-Zip first, against the payload sliced out of the package: handing a tool the
// .exe only unpacks the licence archive the stub carries. The installer's own
// silent switches are tried only when --allow-installer says yes, because those
// run Tencent's installer - which its manifest asks to elevate for, and which
// writes registry entries and can start QQ - instead of unpacking around it.
async function extractPackage(pkg, work, opts) {
  const notes = [];
  const runner = opts.run || run;
  let tools = (opts.tools || findSevenZip(opts.tool)).slice(0, 3);
  if (!tools.length && !opts.noBootstrap) {
    const got = await bootstrapSevenZip(Object.assign({}, opts, { run: runner }));
    if (got.error) notes.push('extractor: ' + got.error);
    else tools = [got.tool];
  }
  let archive = pkg;
  let slice = '';
  if (tools.length) {
    const payload = findSevenZPayload(pkg);
    if (!payload) {
      notes.push('no 7z payload over ' + (SEVENZ_MIN_PAYLOAD / 1048576) + ' MB inside ' + path.basename(pkg));
    } else {
      opts.log('payload  ' + (payload.size / 1048576).toFixed(0) + ' MB 7z at offset ' + payload.offset +
        ' in ' + path.basename(pkg));
      const dest = path.join(path.dirname(pkg), path.basename(pkg, path.extname(pkg)) + '.client.7z');
      const got = await sliceSevenZ(pkg, payload, dest);
      if (got.error) {
        notes.push(got.error);
      } else {
        slice = got.file;
        archive = got.file;
      }
    }
  } else if (!opts.allowInstaller) {
    notes.push('no 7-Zip unpacked a client' + (notes.length ? '' : ' and none could be fetched') +
      ': pass --tool, --allow-installer, or let the bootstrap run');
  }
  for (const tool of tools) {
    const label = '7z ' + path.basename(tool);
    const done = attempt(label, (dir) => runner(tool, [
      'x', '-y', '-bso0', '-bsp0', '-o' + dir + path.sep, archive
    ], { timeoutMs: opts.timeoutMs, inherit: !opts.quiet }), work, opts);
    if (done.root) return finishExtract(done, slice);
    notes.push(done.note);
    opts.log('  ' + done.note);
  }
  if (!opts.allowInstaller) return finishExtract({ root: '', notes }, slice);
  for (const plan of SILENT_PLANS) {
    const args = plan(work);
    const label = 'installer ' + args.join(' ');
    const done = attempt(label, () => runner(pkg, args, { timeoutMs: opts.timeoutMs, inherit: !opts.quiet }), work, opts);
    if (done.root) return finishExtract(done, slice);
    notes.push(done.note);
    opts.log('  ' + done.note);
  }
  return finishExtract({ root: '', notes }, slice);
}

// The slice is a copy of bytes the package already holds, so 300 MB of it is
// never left lying around whether the unpack worked or not.
function finishExtract(result, slice) {
  if (!slice) return result;
  try {
    fs.rmSync(slice, { force: true });
  } catch (e) { /* the next run overwrites it */ }
  return result;
}

// ---------------------------------------------------------------- assemble

// Rename when the tree already lives on the volume it belongs to, copy when it
// does not (a 1.3 GB tree is worth the fast path).
function moveInto(src, into) {
  try {
    fs.rmSync(into, { recursive: true, force: true });
  } catch (e) { /* the target may not exist yet */ }
  try {
    fs.mkdirSync(path.dirname(into), { recursive: true });
  } catch (e) { /* its parent is usually already there */ }
  try {
    fs.renameSync(src, into);
    return 'moved';
  } catch (e) {
    try {
      fs.cpSync(src, into, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
      return 'copied (rename said ' + e.code + ')';
    } catch (f) {
      return 'failed: ' + f.message;
    }
  }
}

// Drop what this repo must not carry inside a client it fetched itself.
function pruneInstall(dir) {
  const removed = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return removed;
  }
  for (const name of names) {
    if (!PRUNES.some((re) => re.test(name))) continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      removed.push(name);
    } catch (e) { /* a locked file is not worth failing over */ }
  }
  return removed;
}

// ---------------------------------------------------------------------- work

// The bytes for one candidate, hashed once: a local file is already here, a
// cached package is trusted only when its digest matches what the source
// publishes, and a fresh download is resumed by curl itself. Returns
// { file, digest } or { error } - the caller decides what a mismatch means.
async function packageBytes(candidate, o) {
  const file = candidate.file;
  if (candidate.kind === 'file') {
    return { file, digest: await o.sha256(file) };
  }
  if (fs.existsSync(file)) {
    const digest = await o.sha256(file);
    if (!candidate.sha256 || digest === candidate.sha256) {
      o.log('cached ' + file);
      return { file, digest };
    }
    o.log('the cached ' + candidate.name + ' is not what the source publishes (' + digest +
      '), downloading it again');
  }
  // the cache directory belongs to this file, not to whoever downloads it
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) { /* the download reports what it could not create */ }
  o.log('downloading ' + candidate.url);
  const got = o.download(candidate.url, file, {
    proxy: o.proxy,
    timeoutSec: o.timeoutSec,
    quiet: o.quiet,
    run: o.run
  });
  if (got.error) return { error: got.error };
  const arrived = got.file || file;
  o.log('downloaded ' + (Number(got.size) / 1048576).toFixed(1) + ' MB into ' + arrived +
    (got.resumed ? ' (resumed ' + (Number(got.resumed) / 1048576).toFixed(1) + ' MB)' : ''));
  return { file: arrived, digest: await o.sha256(arrived) };
}

// The point of this file: make `into` hold a client, going online only when it
// really does not. Returns { action, ... } rather than throwing, because the
// launcher has to print one honest line and then decide what to say next.
async function ensureInstall(input = {}) {
  const options = Object.assign({
    into: path.join(ROOT, 'qqclient'),
    arch: 'x64',
    check: false,
    force: false,
    download: true,
    allowMirror: false,
    allowInstaller: false,
    allowAnyDir: false,
    noBootstrap: false,
    proxy: process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || '',
    timeout: 1800,
    dryRun: false,
    quiet: false,
    tool: '',
    qqFile: '',
    expectSha256: '',
    cache: '',
    log: () => {}
  }, input);
  const deps = Object.assign({
    fetch: fetchText,
    download: downloadFile,
    sha256: sha256File,
    run: run,
    tools: findSevenZip(options.tool)
  }, input.deps);
  const into = path.resolve(options.into);
  const timeoutMs = Math.max(60, Number(options.timeout) || 1800) * 1000;
  const steps = [];
  const log = (line) => {
    steps.push(line);
    options.log(line);
  };

  let state = inspectInstall(into);
  if (state.present && !options.force) {
    return { action: 'present', into, version: state.version, detail: state.detail, steps };
  }
  if (state.present) log('found ' + state.detail + '; --force replaces it');
  else log('not installed: ' + into + ' (' + state.detail + ')');
  if (options.check) {
    return { action: 'missing', into, missing: state.missing, steps, reason: 'not-installed' };
  }
  if (options.dryRun) {
    return {
      action: 'would-install', into, missing: state.missing, steps, reason: 'dry-run',
      detail: 'would resolve the official installer, download it into ' +
        path.resolve(options.cache || path.join(ROOT, 'build', 'downloads')) +
        ', unpack it and move the tree into ' + into
    };
  }
  // Looking anywhere is fine; unpacking is not. The default target is this repo's
  // own private copy, and a system QQNT directory belongs to somebody else's
  // install, which is not what "fetch one" means.
  const repoRoot = ROOT.toLowerCase();
  const insideRepo = into.toLowerCase() === repoRoot ||
    into.toLowerCase().startsWith(repoRoot + path.sep.toLowerCase());
  if (!insideRepo && !options.allowAnyDir) {
    return {
      action: 'blocked', into, reason: 'outside-repo', missing: state.missing, steps,
      detail: into + ' is outside this repo; --allow-any-dir says yes to unpacking there'
    };
  }
  if (!options.download) {
    return {
      action: 'blocked', into, reason: 'no-download', steps,
      detail: 'QQ is missing and --no-download was passed; save the installer yourself and re-run with --qq-file'
    };
  }

  // 1. where the package comes from: a local --qq-file needs no network at all,
  // then the official config the download page itself reads, then the community
  // mirror (only when --allow-mirror says that copy is acceptable). Both network
  // candidates are collected up front, because the failure this machine actually
  // hits is the CDN refusing the download, not the config read.
  const cache = path.resolve(options.cache || path.join(ROOT, 'build', 'downloads'));
  const candidates = [];
  let official = null;
  if (options.qqFile) {
    const file = path.resolve(options.qqFile);
    if (!fs.existsSync(file)) {
      return { action: 'failed', into, reason: 'no-file', steps, detail: file + ' does not exist' };
    }
    candidates.push({
      kind: 'file', url: '', file, name: path.basename(file), version: '',
      sha256: String(options.expectSha256 || '').toLowerCase()
    });
    log('package ' + path.basename(file) + ' (local file)');
  } else {
    official = officialPackage({ arch: options.arch, proxy: options.proxy, timeoutSec: 30, fetch: deps.fetch });
    if (official.error) {
      log(official.error);
      official = null;
    } else {
      log('official ' + official.version + ' (' + official.updateDate + ') ' + official.name);
      candidates.push(Object.assign({}, official, { file: path.join(cache, official.name) }));
    }
    if (options.allowMirror) {
      const mirror = mirrorPackage({
        arch: options.arch,
        version: official ? official.version : '',
        proxy: options.proxy,
        timeoutSec: 30,
        fetch: deps.fetch
      });
      if (mirror.error) {
        log('mirror: ' + mirror.error);
      } else {
        if (mirror.note) log('mirror: ' + mirror.note);
        log('package ' + mirror.name + ' (community mirror of the official file, sha256 ' +
          mirror.sha256.slice(0, 12) + '...)');
        candidates.push(Object.assign({}, mirror, { file: path.join(cache, mirror.name) }));
      }
    }
  }
  if (!candidates.length) {
    return {
      action: 'failed', into, reason: 'no-source', steps,
      detail: 'no package to work from: save ' +
        ((official || {}).url || 'the official installer') + ' yourself and re-run with --qq-file' +
        (options.allowMirror ? '' : ', or pass --allow-mirror to use the community mirror')
    };
  }

  // 2. the bytes, 3. the checksum: the first candidate that survives both wins and
  // every failure is named, because "it failed" is never enough to act on.
  const failures = [];
  let source = null;
  for (const candidate of candidates) {
    const got = await packageBytes(candidate, {
      proxy: options.proxy,
      timeoutSec: Math.round(timeoutMs / 1000),
      quiet: options.quiet,
      download: deps.download,
      sha256: deps.sha256,
      run: deps.run,
      log
    });
    if (got.error) {
      failures.push(candidate.kind + ': ' + got.error);
      continue;
    }
    const expected = String(options.expectSha256 || candidate.sha256 || '').toLowerCase();
    if (expected && expected !== got.digest) {
      failures.push(candidate.kind + ': sha256 mismatch (' + got.digest + ' != ' + expected + ')');
      log('sha256 mismatch for ' + candidate.name + ', ' + got.file + ' was left in place to check');
      continue;
    }
    log('sha256 ' + got.digest + (expected ? ' (as expected)' : ' (nothing published to compare, unchecked)'));
    source = Object.assign({}, candidate, { file: got.file, digest: got.digest });
    break;
  }
  if (!source) {
    const bad = failures.join('; ');
    return {
      action: 'failed', into,
      reason: /sha256 mismatch/.test(bad) ? 'sha256' : 'download',
      steps,
      detail: 'no usable package: ' + bad + '; the official CDN refuses some non-browser clients, so save ' +
        ((official || {}).url || 'the installer') + ' in a browser and re-run with --qq-file' +
        (options.allowMirror ? '' : ', or pass --allow-mirror to use the community mirror')
    };
  }

  // 4. extract, judging the tree every single time
  const work = path.join(path.dirname(source.file), 'extract-' + process.pid);
  const done = await extractPackage(source.file, work, {
    tool: options.tool,
    tools: deps.tools,
    run: deps.run,
    fetch: deps.fetch,
    download: deps.download,
    noBootstrap: options.noBootstrap,
    proxy: options.proxy,
    allowInstaller: options.allowInstaller,
    timeoutMs,
    quiet: options.quiet,
    log
  });
  if (!done.root) {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (e) { /* the next run cleans it anyway */ }
    return {
      action: 'failed', into, reason: 'extract', steps,
      detail: 'nothing unpacked a client out of ' + source.name +
        (done.notes.length ? ': ' + done.notes.join('; ') : '') +
        '; --tool a full 7z.exe, --allow-installer to run the package itself, or install the client yourself' +
        ' and point the launcher at it with --exe'
    };
  }

  // 5. move it in, then drop what this repo must not carry
  const how = moveInto(done.root, into);
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch (e) { /* best effort */ }
  const removed = pruneInstall(into);
  state = inspectInstall(into);
  if (!state.present) {
    return {
      action: 'failed', into, reason: 'verify', steps,
      detail: how + ' into ' + into + ' but it is still ' + state.detail
    };
  }
  log(how + ' via ' + done.via + (removed.length ? ' (pruned ' + removed.join(', ') + ')' : ''));
  return {
    action: 'installed', into, version: state.version, via: done.via,
    package: source.name, kind: source.kind, sha256: source.digest, steps
  };
}

// ----------------------------------------------------------------------- cli

const FLAGS = {
  '--into': 'into',
  '--arch': 'arch',
  '--proxy': 'proxy',
  '--qq-file': 'qqFile',
  '--cache': 'cache',
  '--tool': 'tool',
  '--expect-sha256': 'expectSha256',
  '--timeout': 'timeout'
};
const SWITCHES = {
  '--check': 'check',
  '--json': 'json',
  '--force': 'force',
  '--dry-run': 'dryRun',
  '--quiet': 'quiet',
  '--allow-mirror': 'allowMirror',
  '--allow-installer': 'allowInstaller',
  '--no-bootstrap': 'noBootstrap',
  '--allow-any-dir': 'allowAnyDir',
  '--no-download': 'download'
};
const USAGE = [
  'usage: node scripts\\qq_fetch_client.js [--into <dir>] [--check] [--force] [--json]',
  '         [--qq-file <installer.exe>] [--no-download] [--allow-mirror]',
  '         [--allow-installer] [--allow-any-dir] [--proxy <url>]',
  '         [--arch x64|x86|arm64] [--tool <7z.exe>] [--expect-sha256 <hex>]',
  '         [--timeout <sec>] [--quiet]',
  '',
  '  --into defaults to this repo\\qqclient; --check only looks (exit 0 present, 3 missing)',
  '  nothing is unpacked outside this repo unless --allow-any-dir says so',
  '  the official installer is tried first; --allow-mirror permits the community',
  '  mirror of the same file (with its published sha256) when the CDN refuses us',
  "  --allow-installer runs Tencent's own installer as the last extract strategy",
  '  no 7-Zip found? the extractor is fetched from the npm registry (7zip-bin),',
  '  its published sha512 verified, and 7za kept under bin\\7zip; --no-bootstrap refuses',
  '  --qq-file skips the network: point it at an installer you saved yourself',
  '  --proxy also accepts HTTPS_PROXY/https_proxy from the environment'
].join('\n');

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (Object.prototype.hasOwnProperty.call(FLAGS, arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        out.argError = arg + ' needs a value';
        continue;
      }
      out[FLAGS[arg]] = value;
      i++;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(SWITCHES, arg)) {
      out[SWITCHES[arg]] = arg !== '--no-download';
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      out.help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      out.unknown = (out.unknown || []).concat(arg);
      // an unknown flag swallows its value too: --nope somedir must never be
      // read as "install into somedir"
      if (argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--')) {
        out.unknown.push(argv[i + 1]);
        i++;
      }
      continue;
    }
    out.positional.push(arg);
  }
  if (out.positional.length === 1 && !out.into) out.into = out.positional[0];
  else if (out.positional.length) out.unknown = (out.unknown || []).concat(out.positional);
  return out;
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  if (parsed.argError || parsed.unknown) {
    console.error((parsed.argError || 'unknown argument(s): ' + parsed.unknown.join(' ')) + '\n');
    console.error(USAGE);
    return 2;
  }
  const quiet = !!parsed.quiet;
  const asJson = !!parsed.json;
  const result = await ensureInstall(Object.assign({}, parsed, {
    timeout: Number(parsed.timeout) || 1800,
    log: quiet || asJson ? () => {} : (line) => console.log(line)
  }));
  if (asJson) {
    console.log(JSON.stringify({
      action: result.action,
      into: result.into,
      version: result.version || '',
      via: result.via || '',
      package: result.package || '',
      kind: result.kind || '',
      sha256: result.sha256 || '',
      missing: result.missing || [],
      reason: result.reason || '',
      detail: result.detail || '',
      steps: result.steps || []
    }, null, 2));
  } else if (result.action === 'present' || result.action === 'installed') {
    console.log('QQ ' + result.version + ' ' +
      (result.action === 'present' ? 'already at ' : 'ready at ') + result.into);
  } else {
    console.log(result.action + ' (' + (result.reason || '?') + '): ' + (result.detail || 'nothing done'));
  }
  if (result.reason === 'not-installed') return 3;
  return ['present', 'installed', 'would-install'].indexOf(result.action) !== -1 ? 0 : 1;
}

module.exports = {
  ARCH_FIELDS,
  CONFIG_URLS,
  EXTRACTOR_PKG,
  MIRROR_API,
  NPM_META,
  PRUNES,
  SEVENZ_MIN_PAYLOAD,
  SEVENZ_SIG,
  SEVENZ_START_SIZE,
  SILENT_PLANS,
  TOOL_DIRS,
  TOOL_NAMES,
  USAGE,
  bootstrapSevenZip,
  compareVersions,
  curlExe,
  downloadFile,
  ensureInstall,
  extractPackage,
  fetchText,
  findInstallRoot,
  findSevenZPayload,
  findSevenZip,
  inspectInstall,
  main,
  matchesIntegrity,
  mirrorPackage,
  moveInto,
  officialPackage,
  packageBytes,
  parseArgs,
  pruneInstall,
  run,
  sevenZAt,
  sevenZSignatures,
  sha256File,
  sliceSevenZ,
  tarExe
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error('qq_fetch_client failed: ' + ((e && e.stack) || e));
      process.exit(1);
    }
  );
}
