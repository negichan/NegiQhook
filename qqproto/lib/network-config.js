'use strict';

// Persistent network configuration for the protocol endpoint - the file the
// /config page edits and the endpoint hot-applies. NapCat keeps one
// onebot11_<uin>.json per account; we keep one network.json per instance
// profile (one instance is one account), passed in with --config-file.
//
//   {
//     version: 1,
//     satori: { enable, host, port, token },
//     onebot: {
//       enable, token, messagePostFormat, reportSelfMessage, heartbeatInterval,
//       networks: [
//         { name, type: 'httpServer'|'wsServer'|'httpClient'|'wsClient', enable,
//           ...type fields, token, messagePostFormat, heartbeatInterval,
//           reportSelfMessage }
//       ]
//     }
//   }
//
// Empty token / messagePostFormat and heartbeatInterval 0 mean "inherit the
// OneBot global value". CLI flags only seed the file on first start; once the
// file exists it wins, so the page is the single place ports and tokens live.

const fs = require('fs');
const path = require('path');

const LOOPBACK = new Set(['127.0.0.1', '::1', '0:0:0:0:0:0:0:1', 'localhost']);
const MAX_NETWORKS = 32;
const MAX_TOKEN = 200;

const NETWORK_TYPES = {
  httpServer: {
    label: 'HTTP 服务器',
    brief: '框架调用这个端口发动作；可选同端口 WebSocket 收事件',
    direction: 'listen'
  },
  wsServer: {
    label: 'WebSocket 服务器（正向）',
    brief: '框架连进来：事件推给它，动作从同一条连接回来',
    direction: 'listen'
  },
  httpClient: {
    label: 'HTTP 客户端（上报）',
    brief: '每条事件 POST 到框架的 webhook；动作仍走 HTTP 服务器',
    direction: 'dial'
  },
  wsClient: {
    label: 'WebSocket 客户端（反向）',
    brief: '主动连框架的 WS 服务端（NoneBot / Koishi / AstrBot 常用）',
    direction: 'dial'
  }
};

function isLoopback(host) {
  return LOOPBACK.has(String(host || '').toLowerCase());
}

// localhost and 127.0.0.1 share a port space for our purposes; ::1 is its own
// family but a conservative check treats every loopback form as one bucket.
function bindKey(host, port) {
  const h = String(host || '').toLowerCase();
  const family = (h === '::1' || h === '0:0:0:0:0:0:0:1') ? '6' : '4';
  return family + ':' + Number(port);
}

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === 1 || value === '1';
}

function int(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function fail(message) {
  throw new Error(message);
}

function checkHost(host, allowPublic, where) {
  const h = str(host).trim() || '127.0.0.1';
  if (!isLoopback(h) && !allowPublic) {
    fail(`${where} 的监听地址 ${h} 不是回环地址：这个端点能读写该 QQ 账号，` +
      '只允许 127.0.0.1 / ::1 / localhost（确需对外时整个端点加 --allow-public）');
  }
  return h;
}

function checkPort(value, where) {
  const port = int(value, 0);
  if (port < 1 || port > 65535) fail(`${where} 的端口要填 1-65535（收到 ${JSON.stringify(value)}）`);
  return port;
}

function checkToken(value, where) {
  const token = str(value);
  if (token.length > MAX_TOKEN) fail(`${where} 的 token 太长（上限 ${MAX_TOKEN} 字符）`);
  return token;
}

function checkUrl(value, schemes, where) {
  const url = str(value).trim();
  if (!url) fail(`${where} 需要一个 URL`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    fail(`${where} 的 URL 不合法：${url}`);
  }
  if (!schemes.includes(parsed.protocol.replace(':', ''))) {
    fail(`${where} 的 URL 要以 ${schemes.map((s) => s + '://').join(' 或 ')} 开头（收到 ${url}）`);
  }
  return url;
}

function checkFormat(value, where, allowInherit) {
  const format = str(value);
  if (format === '' && allowInherit) return '';
  if (format !== 'array' && format !== 'string') {
    fail(`${where} 的消息格式只能是 array 或 string${allowInherit ? '（留空 = 跟随全局）' : ''}`);
  }
  return format;
}

function checkHeartbeat(value, where) {
  const ms = int(value, 0);
  if (ms !== 0 && (ms < 1000 || ms > 3600000)) {
    fail(`${where} 的心跳间隔填 0（默认 30s）或 1000-3600000 毫秒`);
  }
  return ms;
}

function normalizeNetwork(raw, index, allowPublic) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`第 ${index + 1} 个网络配置不是对象`);
  }
  const type = str(raw.type);
  const meta = NETWORK_TYPES[type];
  if (!meta) fail(`第 ${index + 1} 个网络的类型不认识：${type || '(空)'}（可选 ${Object.keys(NETWORK_TYPES).join(' / ')}）`);
  const name = str(raw.name).trim();
  if (!name) fail(`第 ${index + 1} 个网络（${meta.label}）要有名称`);
  if (name.length > 40) fail(`网络名称「${name.slice(0, 12)}…」太长（上限 40 字符）`);
  if (/[\u0000-\u001f]/.test(name)) fail(`网络名称「${name}」里有控制字符`);
  const where = `网络「${name}」`;
  const out = {
    name,
    type,
    enable: bool(raw.enable, true),
    token: checkToken(raw.token, where),
    messagePostFormat: checkFormat(raw.messagePostFormat, where, true),
    heartbeatInterval: checkHeartbeat(raw.heartbeatInterval, where),
    reportSelfMessage: bool(raw.reportSelfMessage, false)
  };
  if (type === 'httpServer' || type === 'wsServer') {
    out.host = checkHost(raw.host === undefined || raw.host === '' ? '127.0.0.1' : raw.host, allowPublic, where);
    out.port = checkPort(raw.port, where);
    if (type === 'httpServer') {
      out.enableWebSocket = bool(raw.enableWebSocket, false);
    } else {
      const role = str(raw.role || 'universal').toLowerCase();
      if (!['universal', 'api', 'event'].includes(role)) fail(`${where} 的 role 只能是 universal / api / event`);
      out.role = role;
    }
  } else {
    out.url = checkUrl(raw.url, type === 'httpClient' ? ['http', 'https'] : ['ws', 'wss'], where);
    if (type === 'httpClient') {
      out.secret = checkToken(raw.secret, where + ' 的签名密钥');
      out.timeout = Math.max(500, int(raw.timeout, 10000));
    } else {
      out.reconnectInterval = Math.max(1000, int(raw.reconnectInterval, 5000));
      const role = str(raw.role || 'universal').toLowerCase();
      if (!['universal', 'api', 'event'].includes(role)) fail(`${where} 的 role 只能是 universal / api / event`);
      out.role = role;
    }
  }
  return out;
}

// Validate + canonicalise a raw config (from disk or from the page). Throws a
// readable Chinese error on the first problem; never mutates the input.
function normalizeConfig(raw, { allowPublic = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('配置要是一个 JSON 对象');
  const satoriRaw = raw.satori && typeof raw.satori === 'object' ? raw.satori : {};
  const onebotRaw = raw.onebot && typeof raw.onebot === 'object' ? raw.onebot : {};
  const satori = {
    enable: bool(satoriRaw.enable, true),
    host: checkHost(satoriRaw.host === undefined || satoriRaw.host === '' ? '127.0.0.1' : satoriRaw.host, allowPublic, 'Satori'),
    port: checkPort(satoriRaw.port === undefined ? 5140 : satoriRaw.port, 'Satori'),
    token: checkToken(satoriRaw.token, 'Satori')
  };
  const format = str(onebotRaw.messagePostFormat || 'array');
  if (format !== 'array' && format !== 'string') fail('OneBot 全局消息格式只能是 array 或 string');
  const networksRaw = Array.isArray(onebotRaw.networks) ? onebotRaw.networks : [];
  if (networksRaw.length > MAX_NETWORKS) fail(`网络数量超过上限 ${MAX_NETWORKS}`);
  const networks = networksRaw.map((entry, index) => normalizeNetwork(entry, index, allowPublic));
  const names = new Set();
  for (const network of networks) {
    if (names.has(network.name)) fail(`网络名称重复：「${network.name}」（名称是热重载时认人的键，必须唯一）`);
    names.add(network.name);
  }
  const onebot = {
    enable: bool(onebotRaw.enable, false),
    token: checkToken(onebotRaw.token, 'OneBot 全局'),
    messagePostFormat: format,
    reportSelfMessage: bool(onebotRaw.reportSelfMessage, false),
    heartbeatInterval: checkHeartbeat(onebotRaw.heartbeatInterval, 'OneBot 全局'),
    networks
  };
  // Two enabled listeners on one address:port cannot both bind; catch it here
  // so the page gets a sentence instead of a silent adapter failure.
  const binds = new Map();
  const addBind = (host, port, label) => {
    const key = bindKey(host, port);
    if (binds.has(key)) fail(`端口冲突：${binds.get(key)} 和 ${label} 都要监听 ${host}:${port}`);
    binds.set(key, label);
  };
  if (satori.enable) addBind(satori.host, satori.port, 'Satori');
  if (onebot.enable) {
    for (const network of networks) {
      if (network.enable && (network.type === 'httpServer' || network.type === 'wsServer')) {
        addBind(network.host, network.port, `网络「${network.name}」`);
      }
    }
  }
  return { version: 1, satori, onebot };
}

// First start: turn the CLI flags into the file the page will edit afterwards.
function defaultNetworkConfig(options) {
  const ob = options.onebot || {};
  const networks = [];
  const host = ob.host || options.host || '127.0.0.1';
  if (ob.http !== false && ob.port) {
    networks.push({
      name: 'http', type: 'httpServer', enable: !!ob.enable,
      host, port: Number(ob.port), token: ob.token || '',
      enableWebSocket: !!ob.httpWebSocket,
      messagePostFormat: '', heartbeatInterval: 0, reportSelfMessage: false
    });
  }
  if (ob.wsServer !== false && ob.wsPort) {
    networks.push({
      name: 'ws', type: 'wsServer', enable: !!ob.enable,
      host, port: Number(ob.wsPort), token: ob.token || '', role: 'universal',
      messagePostFormat: '', heartbeatInterval: 0, reportSelfMessage: false
    });
  }
  (ob.reports || []).forEach((url, index) => {
    networks.push({
      name: 'report' + (index + 1), type: 'httpClient', enable: !!ob.enable,
      url, token: ob.token || '', secret: ob.reportSecret || '', timeout: 10000,
      messagePostFormat: '', heartbeatInterval: 0, reportSelfMessage: false
    });
  });
  (ob.reverseWs || []).forEach((url, index) => {
    networks.push({
      name: 'reverse' + (index + 1), type: 'wsClient', enable: !!ob.enable,
      url, token: ob.token || '', reconnectInterval: ob.reconnectInterval || 5000, role: 'universal',
      messagePostFormat: '', heartbeatInterval: 0, reportSelfMessage: false
    });
  });
  return {
    version: 1,
    satori: {
      enable: options.satori !== false,
      host: options.host || '127.0.0.1',
      port: Number(options.port) || 5140,
      token: ''
    },
    onebot: {
      enable: !!ob.enable,
      token: ob.token || '',
      messagePostFormat: ob.format === 'string' ? 'string' : 'array',
      reportSelfMessage: !!ob.reportSelfMessage,
      heartbeatInterval: Number(ob.heartbeatInterval) || 0,
      networks
    }
  };
}

function loadConfigFile(file) {
  if (!fs.existsSync(file)) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`读不了配置文件 ${file}: ${error.message}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`配置文件 ${file} 不是合法 JSON: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`配置文件 ${file} 的内容要是一个 JSON 对象`);
  }
  return value;
}

// Atomic write: a half-written file must never become the next boot's config.
function saveConfigFile(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// The shape OneBotProtocol consumes. Global fallbacks are resolved here so the
// protocol only ever sees concrete values.
function toOneBotConfig(config, fallbackToken) {
  return {
    token: config.onebot.token || fallbackToken || '',
    messagePostFormat: config.onebot.messagePostFormat || 'array',
    reportSelfMessage: !!config.onebot.reportSelfMessage,
    heartbeatInterval: config.onebot.heartbeatInterval || 0,
    networks: config.onebot.networks.map((network) => ({ ...network }))
  };
}

function protocolLabel(config) {
  if (config.satori.enable && config.onebot.enable) return 'both';
  if (config.satori.enable) return 'satori';
  if (config.onebot.enable) return 'onebot';
  return 'none';
}

module.exports = {
  LOOPBACK,
  NETWORK_TYPES,
  MAX_NETWORKS,
  isLoopback,
  normalizeConfig,
  defaultNetworkConfig,
  loadConfigFile,
  saveConfigFile,
  toOneBotConfig,
  protocolLabel
};