'use strict';

// Headless QQ main (NapCat-style boot, no BrowserWindow).
//
// This file is loaded as Electron's app main by appinit.dll, which redirects
// resources/app/package.json and resources/app/app.main.js in memory. It drives
// the QQNT wrapper directly:
//   engine.initWithDeskTopConfig -> loginService.initConfig/connect -> login
//   -> NodeIQQNTWrapperSession.init/startNT -> proto_bridge.js
//
// There is no UI process. The same QQ data directory, login service, machine
// guid, appid and QUA are used as the normal client; the session is a normal
// QQNT session. The boot DLL restores its import hooks and unloads after this
// file has been read, so no custom native module stays in the module list.

const fs = require('fs');
const os = require('os');
const path = require('path');

// The generated entry beside appinit.dll sets this to its own directory before
// requiring this file; __dirname alone would be this source tree.
const BASE_DIR = globalThis[Symbol.for('qqhook.root')] || __dirname;
const CONFIG_PATH = path.join(BASE_DIR, 'app.config.json');
const LOG_PATH = path.join(BASE_DIR, 'app.log');
const READY_PATH = path.join(BASE_DIR, 'app.ready');
let QR_PATH = path.join(BASE_DIR, 'qrcode.png');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}
const config = readConfig();
if (config.qr_file) QR_PATH = config.qr_file;
const logFile = config.log_file || LOG_PATH;

function safe(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > 2000 ? text.slice(0, 2000) + '...' : text;
  } catch (e) {
    return String(value);
  }
}
function log(...args) {
  const line = new Date().toISOString() + ' ' + args.map(safe).join(' ');
  try {
    fs.appendFileSync(logFile, line + '\n');
  } catch (e) { /* logging must never break the boot */ }
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function fileExists(file) {
  try { return fs.existsSync(file); } catch (e) { return false; }
}
function writeReady(text) {
  try { fs.writeFileSync(READY_PATH, text + '\n'); } catch (e) { /* ignore */ }
}

// Account cache: which QQ account this profile last logged in as. The launcher
// reads it and asks for a quick login, so nobody has to scan on every start;
// quick login that fails still falls back to a QR, and this file is rewritten
// with whatever actually got in. It lives next to the other profile files, so
// each profile remembers its own account.
function saveAccount(self, via) {
  if (!self || !self.uin) return;
  const file = path.join(BASE_DIR, 'account.json');
  try {
    fs.writeFileSync(file, JSON.stringify({
      uin: String(self.uin),
      uid: self.uid || '',
      nick: self.nick || '',
      via: via || 'unknown',
      savedAt: new Date().toISOString()
    }, null, 2) + '\n');
    log('account cached', file, String(self.uin), via || 'unknown');
  } catch (e) {
    log('account cache write failed', e.message);
  }
}

process.on('uncaughtException', (e) => log('uncaughtException', e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e));

let electron = {};
try {
  electron = require('electron');
  if (electron.app) {
    // A dedicated install must not share Electron's profile/cache with another
    // running QQ. setPath has to happen before app ready.
    if (config.user_data_path) {
      const root = config.user_data_path;
      try { fs.mkdirSync(root, { recursive: true }); } catch (e) { /* ignore */ }
      for (const [name, target] of [
        ['userData', root],
        ['sessionData', root],
        ['crashDumps', path.join(root, 'Crashpad')],
        ['logs', path.join(root, 'logs')]
      ]) {
        try { electron.app.setPath(name, target); } catch (e) {
          log('setPath ' + name + ' failed', e.message);
        }
      }
    }
    // Headless: no window ever needs a GPU. This keeps the GPU process out of
    // the process tree and removes a common crash source on unattended hosts.
    try { electron.app.disableHardwareAcceleration(); } catch (e) { /* ignore */ }
    // No windows are ever created; keep Electron from exiting if one closes.
    electron.app.on('window-all-closed', () => {});
  }
} catch (e) {
  log('electron require failed', e.message);
}

function wrapperCandidates() {
  const candidates = [];
  if (config.wrapper_path) candidates.push(config.wrapper_path);
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app', 'wrapper.node'));
  }
  candidates.push(path.join(path.dirname(process.execPath), 'resources', 'app', 'wrapper.node'));
  try {
    const versions = path.join(path.dirname(process.execPath), 'versions');
    for (const name of fs.readdirSync(versions)) {
      candidates.push(path.join(versions, name, 'resources', 'app', 'wrapper.node'));
    }
  } catch (e) { /* non-versioned install */ }
  return candidates;
}

function loadWrapper() {
  const candidates = wrapperCandidates();
  const file = candidates.find(fileExists);
  if (!file) throw new Error('wrapper.node not found in ' + candidates.join('; '));
  const mod = { exports: {} };
  process.dlopen(mod, file);
  return { wrapper: mod.exports, file };
}

function qqVersion() {
  if (config.qq_version) return String(config.qq_version);
  if (process.resourcesPath) {
    const version = path.basename(path.dirname(process.resourcesPath));
    if (version) return version;
  }
  throw new Error('QQ version is not configured');
}

function fallbackAppid(version) {
  const table = {
    '9.9.36-53644': { appid: '537391628', qua: 'V1_WIN_NQ_9.9.36_53644_GW_B' },
    '9.9.36-53489': { appid: '537391475', qua: 'V1_WIN_NQ_9.9.36_53489_GW_B' }
  };
  if (table[version]) return table[version];
  const parts = version.split('-');
  const base = (parts[0] || version).replace(/\./g, '_');
  return {
    appid: '537246092',
    qua: 'V1_WIN_' + base + '_' + (parts[1] || '') + '_GW_B'
  };
}

function formatGuid(value) {
  const hex = String(value || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length >= 32) {
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) +
      '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
  }
  return String(value || '');
}

function quickUin() {
  const argv = process.argv || [];
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '-q' || argv[i] === '--qq') && i + 1 < argv.length) {
      return String(argv[i + 1]);
    }
  }
  return '';
}

class GlobalAdapter {
  onLog(...args) {}
  onGetSrvCalTime(...args) {}
  onShowErrUITips(...args) { log('engine: onShowErrUITips', args[0]); }
  fixPicImgType(...args) {}
  getAppSetting(...args) { return ''; }
  onInstallFinished(...args) {}
  onUpdateGeneralFlag(...args) {}
  onGetOfflineMsg(...args) {}
}

class DependsAdapter {
  onMSFStatusChange(statusType, changeReasonType) {
    log('msf status', statusType, changeReasonType);
  }
  onMSFSsoError(code, desc) {
    log('msf sso error', code, desc);
  }
  getGroupCode(args) { return undefined; }
}

class DispatcherAdapter {
  dispatchRequest(arg) {}
  dispatchCall(arg) {}
  dispatchCallWithJson(arg) {}
}

class SessionListener {
  constructor() {
    this.ready = new Promise((resolve) => { this._resolve = resolve; });
  }
  onNTSessionCreate(...args) { log('session: onNTSessionCreate'); }
  onGProSessionCreate(...args) { log('session: onGProSessionCreate'); }
  onSessionInitComplete(...args) { log('session: onSessionInitComplete'); }
  onOpentelemetryInit(info) {
    log('session: onOpentelemetryInit', info);
    if (info && info.is_init) this._resolve(true);
  }
  onUserOnlineResult(...args) { log('session: onUserOnlineResult'); }
  onGetSelfTinyId(...args) { log('session: onGetSelfTinyId'); }
}

class LoginListener {
  constructor(loginService, history) {
    this.loginService = loginService;
    this.history = history;
    this.qrAttempts = 0;
    this.success = new Promise((resolve) => { this._resolve = resolve; });
    this.connected = new Promise((resolve) => { this._connected = resolve; });
  }
  _historyItem(uin) {
    return (this.history || []).find((item) => String(item.uin) === String(uin)) || null;
  }
  onLoginConnected() {
    log('login: connected');
    this._connected(true);
  }
  onLoginConnecting() { log('login: connecting'); }
  onLoginDisConnected() { log('login: disconnected'); }
  onLoginState(...args) { log('login: state', args[0]); }
  onLoginRecordUpdate(...args) { log('login: record update'); }
  onUserLoggedIn(userid) {
    // The QQ account already has an active login (another client or a stale
    // session); NapCat treats this as an error, not as a successful login.
    log('login: already logged in', userid);
  }
  onQRCodeLoginSucceed(value) {
    log('login: QRCodeLoginSucceed', value && value.uin, value && value.uid);
    this._resolve(value || {});
  }
  onQRCodeGetPicture(value) {
    const data = value && value.pngBase64QrcodeData || '';
    const base64 = String(data).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
    try {
      fs.writeFileSync(QR_PATH, Buffer.from(base64, 'base64'));
    } catch (e) {
      log('qrcode write failed', e.message);
    }
    log('qrcode saved', QR_PATH, value && value.qrcodeUrl, 'scan or use the URL');
  }
  onQRCodeSessionUserScaned() { log('login: qrcode scanned'); }
  onQRCodeLoginPollingStarted() { log('login: polling started'); }
  onQRCodeSessionFailed(errType, errCode) {
    log('login: qrcode failed', errType, errCode);
    if (errType === 1 && errCode === 3 && this.qrAttempts < 5) {
      this.qrAttempts++;
      setTimeout(() => {
        try { this.loginService.getQRCodePicture(); } catch (e) { /* ignore */ }
      }, 1500);
    }
  }
  onLoginFailed(...args) { log('login: failed', args); }
  onPasswordLoginFailed(...args) { log('login: password failed', args[0]); }
  onQRCodeSessionQuickLoginFailed(...args) { log('login: quick failed', args[0]); }
  OnConfirmUnusualDeviceFailed(...args) { log('login: unusual device failed', args[0]); }
  onQQLoginNumLimited(...args) { log('login: number limited', args[0]); }
  onLogoutSucceed() { log('login: logout succeed'); }
  onLogoutFailed(...args) { log('login: logout failed', args[0]); }
}

function sessionConfigFor(ctx) {
  const downloadPath = path.join(BASE_DIR, 'files');
  try { fs.mkdirSync(downloadPath, { recursive: true }); } catch (e) { /* ignore */ }
  const platform = 3; // KWINDOWS
  return {
    selfUin: String(ctx.self.uin),
    selfUid: String(ctx.self.uid || ''),
    desktopPathConfig: { account_path: ctx.dataPath },
    clientVer: ctx.version,
    a2: '',
    d2: '',
    d2Key: '',
    machineId: '',
    platform,
    platVer: os.release(),
    appid: ctx.appid,
    rdeliveryConfig: {
      appKey: '',
      systemId: 0,
      appId: '',
      logicEnvironment: '',
      platform,
      language: '',
      sdkVersion: '',
      userId: '',
      appVersion: '',
      osVersion: '',
      bundleId: '',
      serverUrl: '',
      fixedAfterHitKeys: ['']
    },
    defaultFileDownloadPath: downloadPath,
    deviceInfo: {
      guid: ctx.guid,
      buildVer: ctx.version,
      localId: 2052,
      devName: os.hostname(),
      devType: os.type(),
      vendorName: '',
      osVer: os.release(),
      vendorOsName: os.type(),
      setMute: false,
      vendorType: 0
    },
    deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}'
  };
}

function historyList(result) {
  return result && Array.isArray(result.LocalLoginInfoList)
    ? result.LocalLoginInfoList : [];
}

async function waitForMsf(loginService, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let status;
    try { status = loginService.getMsfStatus(); } catch (e) {
      log('getMsfStatus failed', e.message);
      return;
    }
    // Observed on a healthy logged-in client: 1. NapCat only waits while the
    // value is 3, so follow that instead of assuming the enum in the d.ts.
    if (status !== 3) {
      log('login: network ready', status);
      return;
    }
    await delay(500);
  }
  log('login: network wait timed out');
}

async function grabSession(wrapper) {
  let startupSession = null;
  try {
    if (wrapper.NodeIQQNTStartupSessionWrapper) {
      startupSession = wrapper.NodeIQQNTStartupSessionWrapper.create();
    }
  } catch (e) {
    log('startup session create failed', e.message);
  }
  for (let i = 0; i < 20; i++) {
    let session = null;
    try {
      session = wrapper.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1');
    } catch (e) {
      if (i === 0) log('getNTWrapperSession failed', e.message);
    }
    if (session) return { session, startupSession };
    await delay(250);
  }
  // This QQ build has no NodeIQQNTWrapperSession.create; the singleton is
  // expected to exist once the startup session wrapper was created.
  if (typeof wrapper.NodeIQQNTWrapperSession.create === 'function') {
    return { session: wrapper.NodeIQQNTWrapperSession.create(), startupSession };
  }
  throw new Error('NodeIQQNTWrapperSession nt_1 is not available');
}

async function loginSequence(ctx) {
  const loginService = ctx.loginService;
  // Register the listener and connect first; getLoginList/quickLogin only
  // behave once the login service has connected and MSF has a network.
  const listener = new LoginListener(loginService, []);
  ctx.loginListener = listener;
  loginService.addKernelLoginListener(listener);
  log('login: connect', loginService.connect());

  const connected = await Promise.race([
    listener.connected,
    delay(30000).then(() => null)
  ]);
  if (!connected) log('login: connect event timed out; continuing');
  await waitForMsf(loginService, 60000);

  let history = [];
  try {
    const result = await loginService.getLoginList();
    history = historyList(result);
  } catch (e) {
    log('getLoginList failed', e.message);
  }
  listener.history = history;
  log('login: history', history.map((item) => String(item.uin)).join(','));

  const wanted = quickUin();
  const item = wanted
    ? history.find((entry) => String(entry.uin) === wanted) : null;
  if (wanted && item) {
    log('login: quick uin', wanted);
    let accepted = false;
    try {
      const result = await loginService.quickLoginWithUin(wanted);
      accepted = !!result && String(result.result) === '0' &&
        !(result.loginErrorInfo && result.loginErrorInfo.errMsg);
      log('login: quick result', result && result.result,
        result && result.loginErrorInfo && result.loginErrorInfo.errMsg);
    } catch (e) {
      log('login: quick exception', e.message);
    }
    if (accepted) {
      const event = await Promise.race([
        listener.success,
        delay(60000).then(() => null)
      ]);
      if (event && event.uin) {
        return {
          uin: String(event.uin),
          uid: event.uid || item.uid || '',
          nick: event.nickName || item.nickName || '',
          via: 'quick'
        };
      }
      log('login: quick accepted without event; using history record');
      return { uin: String(item.uin), uid: item.uid || '', nick: item.nickName || '', via: 'quick-history' };
    }
    log('login: quick login failed; falling back to QR');
  } else if (wanted) {
    log('login: quick uin not in history', wanted, '; using QR');
  }

  let requested = false;
  try { requested = loginService.getQRCodePicture(); } catch (e) {
    log('getQRCodePicture failed', e.message);
  }
  log('login: qr requested', requested, 'file', QR_PATH);
  const event = await Promise.race([
    listener.success,
    delay(10 * 60 * 1000).then(() => null)
  ]);
  if (!event || !event.uin) throw new Error('login timeout');
  return {
    uin: String(event.uin),
    uid: event.uid || '',
    nick: event.nickName || '',
    via: 'qr'
  };
}

// Configuration and mutable kernel handles are handed to proto_bridge.js
// through symbol-keyed objects rather than a trail of __qqhook* globals. The
// bridge still accepts the old names as a fallback for the attach path, but the
// production host writes only these two symbols (plus the root symbol, which the
// generated entry needs before this file is loaded).
const BRIDGE_CONFIG_KEY = Symbol.for('qqhook.bridge.config');
const BRIDGE_STATE_KEY = Symbol.for('qqhook.bridge.state');
function bridgeState() {
  let value = globalThis[BRIDGE_STATE_KEY];
  if (!value || typeof value !== 'object') {
    value = {
      generation: 0,
      instance: null,
      wrapper: null,
      wrapperPath: '',
      session: null,
      self: { uin: 0, uid: '', nick: '' },
      msgService: null,
      listeners: { registered: false, msg: '', group: '', buddy: '' },
      window: null,
      tray: null
    };
    Object.defineProperty(globalThis, BRIDGE_STATE_KEY, {
      value, configurable: true, writable: true, enumerable: false
    });
  }
  return value;
}

function installBridge(ctx) {
  if (ctx.bridgeInstalled) return;
  const script = config.bridge_script ||
    path.resolve(BASE_DIR, '..', '..', 'scripts', 'proto_bridge.js');
  if (!fileExists(script)) {
    log('bridge script missing', script);
    return;
  }
  const state = bridgeState();
  state.session = ctx.session;
  state.wrapper = ctx.wrapper;
  state.wrapperPath = ctx.wrapperPath;
  state.self = {
    uin: Number(ctx.self.uin) || 0,
    uid: ctx.self.uid || '',
    nick: ctx.self.nick || ''
  };
  const bridgeConfig = {
    port: Number(config.bridge_port || 47840) || 47840,
    log_file: config.bridge_log || path.join(BASE_DIR, 'core.log'),
    log_enabled: config.bridge_log_enabled !== false,
    // Local bridge authentication: the launcher writes this token to
    // app.config.json and passes the same value to qqproto. The bridge never
    // prints it; qqproto only enforces it when --bridge-token was supplied.
    bridge_token: String(config.bridge_token || ''),
    bridge_version: Number(config.bridge_version || 2) || 2,
    qq_version: String(config.qq_version || ''),
    appid: String(config.appid || ''),
    qua: String(config.qua || ''),
    headless: true,
    write_budget: config.write_budget || null
  };
  Object.defineProperty(globalThis, BRIDGE_CONFIG_KEY, {
    value: bridgeConfig, configurable: true, writable: true, enumerable: false
  });
  log('bridge auth', bridgeConfig.bridge_token ? 'token' : 'off',
      'bridge_version=' + bridgeConfig.bridge_version);
  try {
    const source = fs.readFileSync(script, 'utf8');
    const result = (0, eval)(source);
    ctx.bridgeInstalled = true;
    log('bridge installed', result);
    writeReady('ready pid=' + process.pid + ' uin=' + ctx.self.uin);
  } catch (e) {
    log('bridge install failed', e);
    setTimeout(() => installBridge(ctx), 2000);
  }
}

async function main() {
  log('headless main start pid=' + process.pid + ' exec=' + process.execPath);
  const version = qqVersion();
  const appidInfo = {
    appid: config.appid || fallbackAppid(version).appid,
    qua: config.qua || fallbackAppid(version).qua
  };
  const { wrapper, file: wrapperPath } = loadWrapper();
  log('wrapper', wrapperPath);
  const state = bridgeState();
  state.wrapper = wrapper;
  state.wrapperPath = wrapperPath;

  const engine = wrapper.NodeIQQNTWrapperEngine.get();
  const loginService = wrapper.NodeIKernelLoginService.get();
  const grabbed = await grabSession(wrapper);
  const startupSession = grabbed.startupSession;
  const session = grabbed.session;
  log('session object ready', !!session, 'startup', !!startupSession);

  let dataPath = config.data_path;
  if (!dataPath) {
    try {
      dataPath = wrapper.NodeQQNTWrapperUtil.getNTUserDataInfoConfig();
    } catch (e) {
      log('getNTUserDataInfoConfig failed', e.message);
    }
  }
  if (!dataPath) {
    // Same default QQ uses on Windows; the wrapper util normally answers.
    dataPath = path.join(os.homedir(), 'Documents', 'Tencent Files');
  }
  const globalPath = path.join(dataPath, 'nt_qq', 'global');
  log('data path', dataPath, 'global', globalPath);

  const ctx = {
    wrapper,
    wrapperPath,
    engine,
    loginService,
    session,
    version,
    appid: appidInfo.appid,
    dataPath,
    self: null,
    guid: '',
    bridgeInstalled: false
  };

  engine.initWithDeskTopConfig({
    base_path_prefix: '',
    platform_type: 3,
    app_type: 4,
    app_version: version,
    os_version: os.release(),
    use_xlog: false,
    qua: appidInfo.qua,
    global_path_config: { desktopGlobalPath: globalPath },
    thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 }
  }, new GlobalAdapter());
  log('engine initialized', version, appidInfo.appid);

  loginService.initConfig({
    machineId: '',
    appid: appidInfo.appid,
    platVer: os.release(),
    commonPath: globalPath,
    clientVer: version,
    hostName: os.hostname(),
    externalVersion: false
  });
  log('login service initialized');

  ctx.self = await loginSequence(ctx);
  log('login ok', ctx.self.uin, ctx.self.uid, ctx.self.via);
  saveAccount(ctx.self, ctx.self.via);
  if (!ctx.self.uid) {
    log('warning: login has no uid; session init may fail');
  }

  let guidRaw = '';
  try { guidRaw = loginService.getMachineGuid(); } catch (e) {
    log('getMachineGuid failed', e.message);
  }
  ctx.guid = formatGuid(guidRaw);
  log('machine guid', ctx.guid);

  const sessionListener = new SessionListener();
  const sessionConfig = sessionConfigFor(ctx);
  try {
    session.init(sessionConfig, new DependsAdapter(),
      new DispatcherAdapter(), sessionListener);
    log('session.init called');
  } catch (e) {
    log('session.init failed', e);
    throw e;
  }
  try {
    if (startupSession) {
      startupSession.start();
      log('startupSession.start called');
    } else {
      try {
        session.startNT(0);
      } catch (e) {
        log('startNT(0) failed', e.message);
        session.startNT();
      }
    }
  } catch (e) {
    log('session start failed', e);
  }

  const ready = await Promise.race([
    sessionListener.ready,
    delay(30000).then(() => false)
  ]);
  log('session ready', ready);

  installBridge(ctx);
  log('headless main alive; bridge retries if the kernel is still warming up');
}

main().catch((e) => {
  log('fatal', e);
  try { fs.writeFileSync(path.join(BASE_DIR, 'app.fatal'), String(e && e.stack || e)); } catch (err) { /* ignore */ }
  setTimeout(() => process.exit(1), 3000);
});

// Keep the main process alive even while login/QR is waiting or the endpoint is
// down. The bridge adds its own socket and timers.
setInterval(() => {}, 60000);
