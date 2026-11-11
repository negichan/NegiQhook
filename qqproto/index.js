'use strict';

// qqproto — standalone protocol endpoint.
//
//   QQ.exe (qqhook.dll + proto_bridge.js)
//          │  events up / actions down over TCP
//          ▼
//   this process (core + protocol adapters)
//          ├─ Satori: ws /v1/events, http /v1/{method}
//          └─ OneBot: later, on the same core
//
// The injected side never speaks Satori. The endpoint never touches QQ
// internals: it only uses the documented bridge RPC.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const { createLogger, addTap } = require('./lib/log');
const { BridgeRpc } = require('./lib/rpc');
const { Store, Core } = require('./core');
const { MessageUnique } = require('./core/message-unique');
const { SatoriProtocol, WS_PATH } = require('./protocols/satori');
const { OneBotProtocol, UNIMPLEMENTED, REFUSED } = require('./protocols/onebot11');
const { createDebugUi, httpJson } = require('./ui');
const { startHealthWriter } = require('./lib/health');
const {
  isLoopback, normalizeConfig, defaultNetworkConfig, loadConfigFile,
  saveConfigFile, toOneBotConfig, protocolLabel
} = require('./lib/network-config');

// Starting points for the debug page's parameter box. They are templates, not
// defaults that send anything on their own: ids stay empty so nobody fires a
// write at a target they did not type.
const T = (value) => JSON.stringify(value, null, 2);
const TEMPLATES = {
  'user.get': T({ user_id: '' }),
  'guild.get': T({ guild_id: '' }),
  'guild.member.list': T({ guild_id: '' }),
  'guild.member.get': T({ guild_id: '', user_id: '' }),
  'channel.get': T({ channel_id: '' }),
  'channel.list': T({ guild_id: '' }),
  'user.channel.create': T({ user_id: '' }),
  'message.create': T({ channel_id: '', content: '测试消息', referrer: '' }),
  'message.get': T({ channel_id: '', message_id: '' }),
  'message.list': T({ channel_id: '', limit: 20, next: '' }),
  'message.delete': T({ channel_id: '', message_id: '' }),
  'friend.delete': T({ user_id: '' }),
  'friend.approve': T({ message_id: '', approve: true, comment: '' }),
  'guild.approve': T({ message_id: '', approve: true, comment: '' }),
  'guild.member.approve': T({ message_id: '', approve: true, comment: '' }),
  'guild.member.kick': T({ guild_id: '', user_id: '', permanent: false }),
  'guild.member.mute': T({ guild_id: '', user_id: '', duration: 60 }),
  'guild.member.role.set': T({ guild_id: '', user_id: '', role_id: 'admin' }),
  'guild.member.role.unset': T({ guild_id: '', user_id: '', role_id: 'admin' }),
  'guild.member.role.list': T({ guild_id: '', user_id: '' }),
  'guild.role.list': T({ guild_id: '' }),
  'channel.update': T({ channel_id: '', data: { name: '' } }),
  'channel.mute': T({ channel_id: '', enable: true }),
  'reaction.create': T({ message_id: '', emoji_id: '' }),
  'reaction.delete': T({ message_id: '', emoji_id: '' }),
  'reaction.clear': T({ message_id: '', emoji_id: '' }),
  get_group_member_list: T({ group_id: 0 }),
  get_group_member_info: T({ group_id: 0, user_id: 0 }),
  get_group_msg: T({ group_id: 0, count: 20 }),
  get_group_history_msg: T({ group_id: 0, count: 20 }),
  get_friend_msg_history: T({ user_id: 0, count: 20 }),
  get_group_info: T({ group_id: 0 }),
  get_group_notice: T({ group_id: 0 }),
  list_group_notices: T({ group_id: 0 }),
  get_group_files: T({ group_id: 0 }),
  get_group_shut_list: T({ group_id: 0 }),
  get_friend_requests: T({}),
  get_group_requests: T({ group_id: 0 }),
  send_group_msg: T({ group_id: 0, message: '测试消息' }),
  send_private_msg: T({ user_id: 0, message: '测试消息' }),
  send_group_notice: T({ group_id: 0, text: '测试公告' }),
  set_group_card: T({ group_id: 0, user_id: 0, card: '' }),
  set_group_name: T({ group_id: 0, name: '' }),
  set_friend_remark: T({ user_id: 0, remark: '' }),
  set_group_ban: T({ group_id: 0, user_id: 0, duration: 60 }),
  set_msg_reaction: T({ message_id: 0, reaction: '' })
};

function parseArgs(argv) {
  const options = {
    host: '127.0.0.1',
    port: 5140,
    bridgeHost: '127.0.0.1',
    bridgePort: 47840,
    bridgeToken: process.env.QQPROTO_BRIDGE_TOKEN || '',
    token: process.env.QQPROTO_TOKEN || '',
    logLevel: process.env.QQPROTO_LOG_LEVEL || 'info',
    allowUntested: /^(1|true|yes)$/i.test(process.env.QQPROTO_ALLOW_UNTESTED || ''),
    healthFile: process.env.QQPROTO_HEALTH_FILE || '',
    install: false,
    allowPublic: false,
    injector: '',
    bridgeScript: '',
    qqPid: 0,
    watch: 0,
    ownedQQ: 0,
    instance: '',
    protocol: 'none',
    configFile: '',
    uiPort: null,
    uiDirs: [],
    satori: true,
    onebot: {
      enable: true,
      host: '',
      port: 3000,
      wsPort: 3001,
      token: '',
      format: 'array',
      reports: [],
      reportSecret: '',
      reverseWs: [],
      reportSelfMessage: false,
      http: true,
      httpWebSocket: false,
      wsServer: true,
      heartbeatInterval: 0,
      reconnectInterval: 0,
      uniqueFile: ''
    }
  };
  const ob = options.onebot;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case '--host': options.host = next(); break;
      case '--port': options.port = Number(next()) || options.port; break;
      case '--bridge-host': options.bridgeHost = next(); break;
      case '--bridge-port': options.bridgePort = Number(next()) || options.bridgePort; break;
      case '--bridge-token': options.bridgeToken = next(); break;
      case '--allow-untested': options.allowUntested = true; break;
      case '--health-file': options.healthFile = path.resolve(next()); break;
      case '--token': options.token = next(); break;
      case '--log-level': options.logLevel = next(); break;
      case '--install': options.install = true; break;
      case '--allow-public': options.allowPublic = true; break;
      case '--injector': options.injector = next(); break;
      case '--bridge-script': options.bridgeScript = next(); break;
      case '--pid': options.qqPid = Number(next()) || 0; break;
      case '--watch': options.watch = Number(next()) || 0; break;
      case '--owned-qq': options.ownedQQ = Number(next()) || 0; break;
      case '--instance': options.instance = path.resolve(next()); break;
      case '--no-satori': options.satori = false; break;
      case '--no-onebot': ob.enable = false; break;
      case '--protocol': options.protocol = String(next()).toLowerCase(); break;
      case '--config-file': options.configFile = path.resolve(next()); break;
      case '--ui-port': options.uiPort = Number(next()); break;
      case '--ui-allow-dir': options.uiDirs.push(path.resolve(next())); break;
      case '--no-ui': options.uiPort = 0; break;
      case '--ob-host': ob.host = next(); break;
      case '--ob-port': ob.port = Number(next()) || 0; break;
      case '--ob-ws-port': ob.wsPort = Number(next()) || 0; break;
      case '--ob-token': ob.token = next(); break;
      case '--ob-format': ob.format = next(); break;
      case '--ob-report': ob.reports.push(next()); break;
      case '--ob-report-secret': ob.reportSecret = next(); break;
      case '--ob-reverse-ws': ob.reverseWs.push(next()); break;
      case '--ob-report-self': ob.reportSelfMessage = true; break;
      case '--ob-no-http': ob.http = false; break;
      case '--ob-no-ws': ob.wsServer = false; break;
      case '--ob-http-ws': ob.httpWebSocket = true; break;
      case '--ob-heartbeat': ob.heartbeatInterval = Number(next()) || 0; break;
      case '--ob-reconnect': ob.reconnectInterval = Number(next()) || 0; break;
      case '--ob-state': ob.uniqueFile = next(); break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!['none', 'satori', 'onebot', 'both'].includes(options.protocol)) {
    throw new Error(`--protocol must be none, satori, onebot or both (got ${options.protocol})`);
  }
  // Default is "none": the endpoint comes up with only the bridge and the config
  // page, and no protocol port is exposed until the operator enables one there
  // (or passes --protocol explicitly). The config file, once it exists, wins
  // over these flags entirely - they only seed it on first start.
  if (options.protocol === 'none') { options.satori = false; ob.enable = false; }
  if (options.protocol === 'satori') ob.enable = false;
  if (options.protocol === 'onebot') options.satori = false;
  if (options.uiPort === null || Number.isNaN(options.uiPort)) {
    // 5140 -> 5150, 5141 -> 5151; the debug page never shares a port with a
    // protocol surface so it cannot disturb a client's routing.
    options.uiPort = (options.protocol === 'onebot' ? ob.port : options.port) + 10;
  }
  if (ob.host !== '' && ob.host !== options.host && !options.allowPublic) {
    const loopback = new Set(['127.0.0.1', '0:0:0:0:0:0:0:1', '::1', 'localhost']);
    if (!loopback.has(ob.host)) {
      throw new Error(`--ob-host ${ob.host} is not loopback; pass --allow-public as well`);
    }
  }
  if (ob.host === '') ob.host = options.host;
  return options;
}

function printUsage() {
  console.log(
    'usage: node qqproto/index.js [options]\n' +
    '  --host <ip>           endpoint bind address, default 127.0.0.1\n' +
    '  --port <n>            Satori HTTP/WS port, default 5140\n' +
    '  --bridge-port <n>     TCP port the injected bridge connects to, default 47840\n' +
    '  --bridge-token <s>    require this local bridge token (headless launcher sets it)\n' +
    '  --allow-untested      allow writes when the QQ build is not in the tested list\n' +
    '                        (reads stay open either way; QQPROTO_ALLOW_UNTESTED=1 works too)\n' +
    '  --health-file <path>  rewrite this JSON file every 5s (launcher supervision)\n' +
    '  --token <s>           access token; default random, QQPROTO_TOKEN also works\n' +
    '  --allow-public        required when --host is not a loopback address\n' +
    '  --install             run qqinject --bridge-only after starting\n' +
    '  --injector <path>     qqinject.exe path, default bin/qqinject.exe\n' +
    '  --bridge-script <p>   override scripts/proto_bridge.js\n' +
    '  --pid <n>             pass a QQ pid to the injector\n' +
    '  --watch <pid>         stop this instance when that launcher console is gone\n' +
    '  --owned-qq <pid>      the QQ pid the watchdog may stop (with --watch)\n' +
    '  --instance <dir>      profile dir of the instance, for the watchdog stop\n' +
    '  --log-level <level>   error|warn|info|debug, default info\n' +
    '  --protocol <p>        none | satori | onebot | both, default none: which' +
    '\n                      surfaces to seed on first start. The config file wins' +
    '\n                      once it exists; enable surfaces on the /config page.' +
    '\n  --config-file <p>   persistent network config (default qqproto/data/network.json;' +
    '\n                      the launcher passes <profile>/network.json). First start' +
    '\n                      seeds it from these flags; afterwards the file is the truth.' +
    '\n  --ui-port <n>       debug page port, default <endpoint port>+10 (0 disables)' +
    '\n  --ui-allow-dir <d>  also let the chat page preview files under this directory' +
    '\n                      (repo root and your home dir are allowed already)' +
    '\n  --no-ui             same as --ui-port 0' +
    '\nSatori:' +
    '\n  --no-satori           do not serve the Satori protocol\n' +
    'OneBot v11 (only served with --protocol onebot|both):\n' +
    '  --no-onebot           disable every OneBot transport\n' +
    '  --ob-port <n>         HTTP action server port, default 3000 (0 disables)\n' +
    '  --ob-ws-port <n>      WebSocket server port, default 3001 (0 disables)\n' +
    '  --ob-host <ip>        OneBot bind address, default --host\n' +
    '  --ob-token <s>        OneBot access token, default --token\n' +
    '  --ob-format <f>       array|string (CQ code), default array\n' +
    '  --ob-report <url>     push events to an HTTP endpoint, repeatable\n' +
    '  --ob-report-secret <s> sign those pushes with an X-Signature HMAC-SHA1\n' +
    '  --ob-reverse-ws <url> connect out to a WebSocket server, repeatable\n' +
    '  --ob-report-self      also report this account\'s own sent messages\n' +
    '  --ob-no-http          no HTTP action server\n' +
    '  --ob-no-ws            no standalone WebSocket server\n' +
    '  --ob-http-ws          also accept WebSocket on the HTTP action port\n' +
    '  --ob-heartbeat <ms>   heartbeat interval, default 30000\n' +
    '  --ob-reconnect <ms>   reverse WebSocket retry interval, default 5000\n' +
    '  --ob-state <file>     message id table path, default qqproto/data/onebot-msg.json'
  );
}

function makeToken() {
  return crypto.randomBytes(16).toString('hex');
}

function resolveRepoPath(...parts) {
  return path.resolve(__dirname, '..', ...parts);
}

// The launcher console owns the instance: when that console is gone (its window
// closed, so Windows killed it without running any of its own handlers) the
// headless QQ must not stay up without anyone to stop it. Two consecutive misses
// because a tasklist hiccup must not tear a working instance down.
function watchConsole({ watch, ownedQQ, instance }, logger, stopScript) {
  if (!watch || !instance) return null;
  let misses = 0;
  const timer = setInterval(() => {
    let running = null;
    try {
      const out = execFileSync('tasklist', ['/FI', 'PID eq ' + watch, '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', timeout: 10000, windowsHide: true });
      running = out.split(/\r?\n/).some((row) => row.trim().startsWith('"'));
    } catch (e) {
      return;
    }
    if (running) {
      misses = 0;
      return;
    }
    if (++misses < 2) return;
    clearInterval(timer);
    logger.warn('launcher console pid=' + watch + ' is gone; stopping the instance it owned');
    // our own pid file would otherwise be left behind for the next stop to explain
    try {
      const mine = path.join(options.instance, 'endpoint.pid');
      if (String(fs.readFileSync(mine, 'utf8')).trim() === String(process.pid)) fs.rmSync(mine);
    } catch (e) { /* nothing to clean */ }
    const args = [stopScript, '--profile', instance];
    if (ownedQQ) args.push('--pid', String(ownedQQ));
    try {
      const done = spawnSync(process.execPath, args, {
        cwd: resolveRepoPath(), encoding: 'utf8', timeout: 60000
      });
      if (done.stdout) process.stdout.write(done.stdout);
      if (done.stderr) process.stderr.write(done.stderr);
    } catch (error) {
      logger.error('could not stop the instance:', error.message);
    }
    process.exit(0);
  }, 3000);
  return () => clearInterval(timer);
}

function installBridge(options, logger) {
  const injector = options.injector
    ? path.resolve(options.injector)
    : resolveRepoPath('bin', 'qqinject.exe');
  const args = ['--bridge-only', '--port', String(options.bridgePort)];
  if (options.qqPid) args.push('--pid', String(options.qqPid));
  if (options.bridgeScript) args.push('--js-file', path.resolve(options.bridgeScript));

  logger.info('installing protocol bridge:', injector, args.join(' '));
  let child;
  try {
    child = spawn(injector, args, {
      cwd: resolveRepoPath(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    logger.error('failed to start injector:', error.message);
    return;
  }
  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) logger.info('[injector]', line.trim());
    }
  });
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) logger.warn('[injector]', line.trim());
    }
  });
  child.on('error', (error) => logger.error('injector error:', error.message));
  child.on('exit', (code) => logger[code === 0 ? 'info' : 'warn']('injector exited with code', code));
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    printUsage();
    process.exit(2);
    return;
  }
  if (options.help) {
    printUsage();
    return;
  }
  const logger = createLogger(options.logLevel);
  if (!options.token) options.token = makeToken();

  // The persistent network config is the single source of truth for which
  // protocol surfaces run. First start seeds it from the CLI flags; once the
  // file exists it wins, so the /config page is where ports and tokens live.
  options.configFile = options.configFile || resolveRepoPath('qqproto', 'data', 'network.json');
  let networkConfig;
  try {
    const loaded = loadConfigFile(options.configFile);
    if (loaded) {
      networkConfig = normalizeConfig(loaded, { allowPublic: options.allowPublic });
      logger.info('network config: ' + options.configFile + '（文件优先；命令行网络参数只是首次启动的默认）');
    } else {
      networkConfig = normalizeConfig(defaultNetworkConfig(options), { allowPublic: options.allowPublic });
      saveConfigFile(options.configFile, networkConfig);
      logger.info('network config: 按命令行生成并写入 ' + options.configFile);
    }
  } catch (error) {
    console.error('[error] network config: ' + error.message);
    process.exit(2);
    return;
  }
  let configRevision = 0;
  options.satori = networkConfig.satori.enable;
  options.host = networkConfig.satori.host;
  options.port = networkConfig.satori.port;
  options.onebot.enable = networkConfig.onebot.enable;
  options.protocol = protocolLabel(networkConfig);

  const loopback = new Set(['127.0.0.1', '0:0:0:0:0:0:0:1', '::1', 'localhost']);
  if (!loopback.has(options.host) && !options.allowPublic) {
    console.error(
      `[error] refusing to bind ${options.host}: the endpoint can send and read ` +
      'this QQ account. Pass --allow-public only behind your own firewall/auth.'
    );
    process.exit(2);
    return;
  }
  if (options.allowUntested) {
    console.log('[warn] --allow-untested: writes are allowed on an unverified QQ build');
  }

  const store = new Store();
  const rpc = new BridgeRpc({
    host: options.bridgeHost,
    port: options.bridgePort,
    token: options.bridgeToken,
    logger: logger.child('bridge')
  });
  const core = new Core({
    rpc, store, logger: logger.child('core'), allowUntested: options.allowUntested
  });
  const satoriToken = () => networkConfig.satori.token || options.token;
  let satori = options.satori
    ? new SatoriProtocol({
      token: satoriToken(),
      core,
      store,
      logger: logger.child('satori'),
      // healthSnapshot is declared below; the protocol only calls it per request.
      getHealth: () => healthSnapshot()
    })
    : null;
  const obOptions = options.onebot;
  const unique = new MessageUnique({
    file: obOptions.uniqueFile || resolveRepoPath('qqproto', 'data', 'onebot-msg.json'),
    logger: logger.child('msg-id')
  });
  let onebot = networkConfig.onebot.enable
    ? new OneBotProtocol({
      core,
      store,
      unique,
      logger: logger.child('onebot'),
      config: toOneBotConfig(networkConfig, options.token)
    })
    : null;
  if (!satori && !onebot) {
    logger.info('没有启用任何协议端口：打开配置页 http://127.0.0.1:' + options.uiPort +
      '/config 启用 Satori 或新增 OneBot 网络，保存后立即生效');
  }

  const localHost = ['0.0.0.0', '::', '0:0:0:0:0:0:0:1'].includes(options.host)
    ? '127.0.0.1'
    : options.host;

  function clientCounts() {
    let onebotClients = 0;
    if (onebot) {
      for (const adapter of onebot.adapters) {
        if (adapter.sessions) onebotClients += adapter.sessions.size;
      }
    }
    return { satori: satori && satori.ws ? satori.ws.clients.size : 0, onebot: onebotClients };
  }

  const obAdapterPort = (kind) => {
    if (!onebot) return 0;
    const adapter = onebot.adapters.find((a) => a.kind === kind);
    return adapter ? adapter.port : 0;
  };

  const uiState = () => {
    const counts = clientCounts();
    return {
      bridgeConnected: rpc.connected,
      bridgeAddress: rpc.peer || '',
      bridgeGeneration: rpc.activeGeneration,
      bridgeVersion: rpc.bridgeInfo && rpc.bridgeInfo.bridge_version,
      qqVersion: rpc.bridgeInfo && rpc.bridgeInfo.qq_version,
      bridgeCapabilities: rpc.bridgeInfo && rpc.bridgeInfo.capabilities || null,
      bridgeAuth: !!options.bridgeToken,
      compat: core.compatibility(),
      bridgeLimits: (rpc.bridgeHeartbeat && rpc.bridgeHeartbeat.limits) ||
        (rpc.bridgeInfo && rpc.bridgeInfo.limits) || null,
      self: store.self,
      offline: store.offline,
      uptimeMs: Date.now() - store.startedAt,
      protocol: options.protocol,
      token: satori ? satori.token : options.token,
      configFile: options.configFile,
      configRevision,
      counts,
      satori: satori
        ? {
          enabled: true,
          host: options.host,
          port: options.port,
          token: satori.token,
          wsPath: WS_PATH,
          clients: counts.satori,
          implemented: satori.features.length,
          known: Object.keys(satori.methods).length
        }
        : { enabled: false },
      onebot: onebot
        ? {
          enabled: true,
          httpPort: obAdapterPort('http-server'),
          wsPort: obAdapterPort('ws-server'),
          token: onebot.token,
          format: onebot.config.messagePostFormat,
          clients: counts.onebot,
          // Registered refusals (unimplemented names and the four stubs that can
          // only answer with a reason) are not "implemented" just because they
          // have a handler.
          implemented: Object.keys(onebot.actionContext.actions)
            .filter((name) => !UNIMPLEMENTED.includes(name) && !REFUSED.includes(name)).length,
          // the two tables overlap (a refused stub is listed in both), so the
          // page gets the union size rather than a double-counted total
          known: new Set([
            ...Object.keys(onebot.actionContext.actions), ...UNIMPLEMENTED
          ]).size,
          adapters: onebot.status()
        }
        : { enabled: false }
    };
  };

  // One snapshot is shared by /health, the health file and the header card, so
  // the number an external supervisor sees cannot disagree with the page.
  const healthSnapshot = () => {
    const stats = rpc.stats();
    const compat = core.compatibility();
    const counts = clientCounts();
    const memory = process.memoryUsage();
    return {
      ok: !!rpc.connected && !!store.self.uin && !store.offline,
      service: 'qqproto',
      pid: process.pid,
      now: Date.now(),
      uptimeMs: Date.now() - store.startedAt,
      protocol: options.protocol,
      bridge: {
        connected: stats.connected,
        peer: stats.peer,
        generation: stats.generation,
        connectedAt: stats.connectedAt,
        lastHelloAt: stats.lastHelloAt,
        lastEventAt: stats.lastEventAt,
        lastHeartbeatAt: stats.lastHeartbeatAt,
        pendingActions: stats.pending,
        counters: stats.counters,
        bridgeVersion: stats.bridgeInfo && stats.bridgeInfo.bridge_version,
        qqVersion: stats.bridgeInfo && stats.bridgeInfo.qq_version,
        capabilities: stats.bridgeInfo && stats.bridgeInfo.capabilities,
        limits: (stats.heartbeat && stats.heartbeat.limits) ||
          (stats.bridgeInfo && stats.bridgeInfo.limits),
        heartbeat: stats.heartbeat
      },
      compat,
      self: store.self,
      offline: store.offline,
      clients: counts,
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal
      }
    };
  };

  const uiCatalog = () => ({
    protocol: options.protocol,
    satori: satori
      ? Object.keys(satori.methods).sort().map((name) => ({
        name,
        implemented: satori.features.includes(name),
        template: TEMPLATES[name] || '{}'
      }))
      : [],
    onebot: onebot
      ? (() => {
        // A name can sit in both tables: the action map holds an explicit
        // "not implemented, because X" refusal. That is not an implementation,
        // so the page must not list it as one.
        const refused = new Set([...UNIMPLEMENTED, ...REFUSED]);
        const names = new Set([...Object.keys(onebot.actionContext.actions), ...UNIMPLEMENTED]);
        return [...names].sort().map((name) => ({
          name,
          implemented: !refused.has(name),
          template: TEMPLATES[name] || '{}'
        }));
      })()
      : []
  });

  // via=http goes out through the endpoint's own listening port, so the page
  // exercises the token check, the body parsing and the JSON shape a real bot
  // framework sees. via=internal calls the handler straight away, which is what
  // you want when the port itself is the suspect.
  async function uiInvoke({ protocol, method, params, via }) {
    const body = params && typeof params === 'object' ? params : {};
    if (protocol === 'satori') {
      if (!satori) {
        return { ok: false, status: 0, ms: 0, error: '这个实例没有启用 Satori（在 /config 配置页里打开）', data: null };
      }
      if (via === 'internal') {
        const handler = satori.methods[method];
        if (typeof handler !== 'function') {
          return { ok: false, status: 404, ms: 0, error: `unknown method: ${method}`, data: null };
        }
        const started = Date.now();
        try {
          const data = await handler(body);
          return { ok: true, status: 200, ms: Date.now() - started, data: data === undefined ? null : data };
        } catch (error) {
          return {
            ok: false, status: error.status || 500, ms: Date.now() - started,
            error: error.message, data: null
          };
        }
      }
      return httpJson(`http://${localHost}:${options.port}/v1/${encodeURIComponent(method)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: satori.token ? `Bearer ${satori.token}` : ''
        },
        body
      });
    }
    if (protocol === 'onebot') {
      if (!onebot) {
        return { ok: false, status: 0, ms: 0, error: '这个实例没有启用 OneBot（在 /config 配置页里打开）', data: null };
      }
      if (via === 'internal') {
        const started = Date.now();
        const result = await onebot.handleAction(method, body);
        return {
          ok: result.retcode === 0,
          status: result.retcode === 0 ? 200 : 400,
          ms: Date.now() - started,
          error: result.retcode === 0 ? undefined : (result.message || 'failed'),
          data: result
        };
      }
      const httpAdapter = onebot.adapters.find((a) => a.kind === 'http-server' && a.enabled);
      if (!httpAdapter) {
        return { ok: false, status: 0, ms: 0, error: 'OneBot 没有启用的 HTTP 服务器网络，改用 via=internal 或在配置页新增', data: null };
      }
      const host = ['0.0.0.0', '::'].includes(httpAdapter.host) ? '127.0.0.1' : httpAdapter.host;
      return httpJson(`http://${host}:${httpAdapter.port}/${encodeURIComponent(method)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: httpAdapter.token ? `Bearer ${httpAdapter.token}` : ''
        },
        body
      });
    }
    return { ok: false, status: 0, ms: 0, error: `unknown protocol: ${protocol}`, data: null };
  }

  // The chat page reads the same in-memory cache the protocol layer uses and
  // sends through core, so it works whichever protocol ports are open - and it
  // never reads QQ's message database or history: the cache only holds messages
  // this endpoint saw since it started.
  const channelKeyOf = (event) => event.is_group
    ? String(event.group_id)
    : String(event.peer_uin || (event.sender && event.sender.uin) || '');

  const renderMessage = (event) => {
    const sender = event.sender || {};
    return {
      id: String(event.message_id || ''),
      time: Number(event.time) || Math.floor(Date.now() / 1000),
      channel: channelKeyOf(event),
      kind: event.is_group ? 'group' : 'private',
      mine: String(sender.uin || '') === String(store.self.uin) ||
        String(event.direction || '').startsWith('out'),
      sender: {
        uin: String(sender.uin || ''),
        uid: String(sender.uid || ''),
        nick: sender.nick || '',
        card: sender.card || '',
        remark: sender.remark || ''
      },
      elements: Array.isArray(event.elements) ? event.elements : [],
      raw: event.raw_message || '',
      deleted: !!event.deleted,
      synthetic: !!event.synthetic
    };
  };

  const displayName = (key, kind) => {
    if (kind === 'group') {
      const group = store.groups.get(key);
      return group ? (group.name || key) : key;
    }
    const friend = store.friendByUin(key);
    return friend ? (friend.display || friend.remark || friend.nick || key) : key;
  };

  const chatApi = {
    mediaRoots: [...new Set([resolveRepoPath(), os.homedir(), ...options.uiDirs])],
    describe: renderMessage,

    async getChats() {
      let groups = null;
      let friends = null;
      try { groups = await core.groups(false); } catch (e) { groups = null; }
      try { friends = await core.friends(false); } catch (e) { friends = null; }
      if (!groups) groups = [...store.groups.values()];
      if (!friends) friends = [...store.friends.values()];

      const chats = new Map();
      for (const id of store.messageOrder) {
        const event = store.messages.get(id);
        if (!event || event.type !== 'message') continue;
        const key = channelKeyOf(event);
        if (!key) continue;
        const rendered = renderMessage(event);
        const entry = chats.get(key) || {
          channel: key, kind: rendered.kind, count: 0, last: null, unread: 0
        };
        entry.count++;
        if (!entry.unread && !rendered.mine) entry.unread++;
        entry.last = rendered;
        chats.set(key, entry);
      }
      const list = [...chats.values()].map((entry) => ({
        ...entry,
        name: displayName(entry.channel, entry.kind)
      })).sort((a, b) => (b.last && b.last.time || 0) - (a.last && a.last.time || 0));

      return {
        self: store.self,
        offline: store.offline,
        bridgeConnected: rpc.connected,
        chats: list,
        groups: groups.map((group) => ({
          id: String(group.group_id || group.group_code || ''),
          name: group.name || '',
          member_count: Number(group.member_count) || 0
        })).filter((group) => group.id),
        friends: friends.map((friend) => ({
          uin: String(friend.uin || ''),
          uid: String(friend.uid || ''),
          nick: friend.nick || '',
          remark: friend.remark || '',
          display: friend.display || friend.remark || friend.nick || String(friend.uin || ''),
          provisional: !!friend.provisional
        })).filter((friend) => friend.uin)
      };
    },

    async getConversation(channel, limit = 50) {
      const key = String(channel || '');
      if (!key) throw new Error('channel is required');
      const kind = store.hasGroup(key) ? 'group' : 'private';
      let members = [];
      if (kind === 'group') {
        try {
          members = [...(await core.members(key, false)).values()].map((member) => ({
            uin: String(member.uin || ''),
            uid: String(member.uid || ''),
            nick: member.nick || '',
            card: member.card || '',
            role: member.roles && member.roles.length ? member.roles.join(',') : ''
          }));
        } catch (error) {
          logger.debug('group members not loaded:', error.message);
        }
      }
      return {
        channel: key,
        kind,
        name: displayName(key, kind),
        members,
        // in-memory cache only: whatever this endpoint has seen since it started
        messages: core.messages(key, limit).reverse().map(renderMessage)
      };
    },

    async send(payload) {
      const channel = String(payload.channel || '');
      if (!channel) throw new Error('channel is required');
      let segments = Array.isArray(payload.segments) ? payload.segments : null;
      if (!segments && typeof payload.text === 'string') {
        segments = [{ type: 'text', data: { text: payload.text } }];
      }
      if (!segments || !segments.length) throw new Error('没有内容可发');
      // core is the gate: text/at/image pass, anything else is refused there with
      // the real reason, exactly like a protocol client would be refused.
      return await core.send(channel, segments);
    },

    async recall(payload) {
      const channel = String(payload.channel || '');
      const id = String(payload.message_id || '');
      if (!channel || !id) throw new Error('channel 和 message_id 都要填');
      await core.recall(channel, id);
      return { recalled: id, channel };
    }
  };

  // ---- hot-appliable protocol surfaces --------------------------------------
  // The config page saves a whole network config; applyNetworkConfig() diffs it
  // against what is running and only touches what changed. Satori rebinds its
  // listener (new port bound before the old one drops); OneBot reloads adapters
  // by name, so an unchanged network keeps its connected frameworks.
  let server = null;        // Satori HTTP/WS listener, null while disabled
  let satoriBound = null;   // { host, port } actually bound

  function wireSatoriActivity() {
    satori.onActivity = (body, clients) => {
      if (ui) ui.onDelivery({ protocol: 'satori', channel: `ws×${clients}`, body });
    };
  }
  function wireOnebotActivity() {
    onebot.onActivity = (name, payload, enabled) => {
      if (ui) ui.onDelivery({ protocol: 'onebot', channel: name + (enabled ? '' : '·未启用'), body: payload });
    };
  }

  const satoriHttpHandler = (request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      });
      response.end();
      return;
    }
    let url;
    try {
      url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end('{"message":"bad request"}');
      return;
    }
    satori.handleHttp(request, response, url).catch((error) => {
      logger.error('http handler failed:', error);
      if (!response.writableEnded) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ message: 'internal error' }));
      }
    });
  };

  async function listenSatori(host, port) {
    const fresh = http.createServer(satoriHttpHandler);
    fresh.on('error', (error) => logger.error('endpoint HTTP server error:', error.message));
    await new Promise((resolve, reject) => {
      fresh.once('error', reject);
      fresh.listen(port, host, () => resolve());
    });
    return fresh;
  }

  function dropSatoriServer() {
    if (satori) satori.close();
    if (server) {
      try { server.closeAllConnections(); } catch (e) { /* ignore */ }
      try { server.close(); } catch (e) { /* ignore */ }
      server = null;
    }
    satoriBound = null;
  }

  // Bind the new listener before dropping the old one: a taken port must not
  // take the working surface down with it.
  async function startSatoriSurface() {
    const fresh = await listenSatori(options.host, options.port);
    dropSatoriServer();
    server = fresh;
    satori.attach(server);
    satoriBound = { host: options.host, port: options.port };
    logger.info(`Satori endpoint: http://${options.host}:${options.port}`);
    logger.info(`Satori WebSocket: ws://${options.host}:${options.port}${WS_PATH}`);
    logger.info(`health: http://${localHost}:${options.port}/health (no token, 503 until the bridge is up)`);
    logger.info(`token: ${satori.token}`);
  }

  function logOnebotSummary(started) {
    logger.info(`OneBot v11: ${onebot.implementedCount} actions routed, ` +
      `${onebot.unimplementedCount} further known actions answered as not-implemented`);
    for (const status of onebot.status()) {
      logger.info(`OneBot ${status.kind} [${status.name}] ${status.status} ${status.detail}`);
    }
    if (started && started.failures.length) {
      for (const failure of started.failures) logger.warn(`OneBot adapter not started: ${failure}`);
    }
  }

  async function applyNetworkConfig(next) {
    const summary = { satori: 'unchanged', onebot: null };
    // The debug page and the bridge own their ports; a network must not steal
    // them (normalizeConfig already checked the networks against each other).
    const reserved = [options.uiPort, options.bridgePort].filter((p) => p > 0);
    const checkReserved = (host, port, label) => {
      if (isLoopback(host) && reserved.includes(port)) {
        throw new Error(`${label} 的端口 ${port} 已被调试页或桥占用，换一个`);
      }
    };
    if (next.satori.enable) checkReserved(next.satori.host, next.satori.port, 'Satori');
    if (next.onebot.enable) {
      for (const network of next.onebot.networks) {
        if (network.enable && (network.type === 'httpServer' || network.type === 'wsServer')) {
          checkReserved(network.host, network.port, `网络「${network.name}」`);
        }
      }
    }

    // ---- Satori ----
    if (next.satori.enable && !satori) {
      const prevHost = options.host;
      const prevPort = options.port;
      satori = new SatoriProtocol({
        token: next.satori.token || options.token,
        core, store, logger: logger.child('satori'), getHealth: () => healthSnapshot()
      });
      wireSatoriActivity();
      options.host = next.satori.host;
      options.port = next.satori.port;
      try {
        await startSatoriSurface();
      } catch (error) {
        satori = null;
        options.host = prevHost;
        options.port = prevPort;
        throw error;
      }
      if (bridgeUp) { satori.setLink('up'); satori.loginUpdated(); }
      summary.satori = 'started';
    } else if (!next.satori.enable && satori) {
      dropSatoriServer();
      satori = null;
      summary.satori = 'stopped';
    } else if (satori) {
      const oldToken = satori.token;
      const addrChanged = next.satori.host !== options.host || next.satori.port !== options.port;
      satori.token = next.satori.token || options.token;
      if (addrChanged) {
        const prevHost = options.host;
        const prevPort = options.port;
        options.host = next.satori.host;
        options.port = next.satori.port;
        try {
          await startSatoriSurface();
        } catch (error) {
          satori.token = oldToken;
          options.host = prevHost;
          options.port = prevPort;
          throw error;
        }
        summary.satori = 'rebound';
      }
    }
    options.satori = next.satori.enable;

    // ---- OneBot ----
    const obConfig = toOneBotConfig(next, options.token);
    if (next.onebot.enable && !onebot) {
      onebot = new OneBotProtocol({
        core, store, unique, logger: logger.child('onebot'), config: obConfig
      });
      wireOnebotActivity();
      const started = await onebot.start();
      summary.onebot = { kept: [], opened: started.opened, closed: [], failures: started.failures };
      if (bridgeUp) onebot.lifecycle('enable');
      logOnebotSummary(started);
    } else if (!next.onebot.enable && onebot) {
      onebot.close();
      onebot = null;
      summary.onebot = { kept: [], opened: [], closed: ['all'], failures: [] };
    } else if (onebot) {
      summary.onebot = await onebot.reload(obConfig);
    }
    options.onebot.enable = next.onebot.enable;
    options.protocol = protocolLabel(next);

    networkConfig = next;
    configRevision++;
    saveConfigFile(options.configFile, next);
    logger.info(`network config 已保存并应用（rev ${configRevision}）：satori=${summary.satori}` +
      (summary.onebot
        ? ` onebot kept=${summary.onebot.kept.length} opened=${summary.onebot.opened.length}` +
          ` closed=${summary.onebot.closed.length} failures=${summary.onebot.failures.length}`
        : ''));
    return { revision: configRevision, ...summary };
  }

  let ui = null;
  if (options.uiPort) {
    // The debug page is a local tool: bind loopback unless the operator asked for
    // a public endpoint bind, in which case it follows the same address.
    const uiHost = options.allowPublic ? options.host : '127.0.0.1';
    ui = createDebugUi({
      host: uiHost,
      port: options.uiPort,
      logger: logger.child('ui'),
      getState: uiState,
      getCatalog: uiCatalog,
      getHealth: healthSnapshot,
      invoke: uiInvoke,
      chat: chatApi,
      // The /config page reads and hot-applies the persistent network config.
      // Like the other write routes it sits behind the same-origin header, and
      // the body must additionally carry allow_write (see ui.js).
      configApi: {
        get: () => ({
          file: options.configFile,
          revision: configRevision,
          config: networkConfig,
          allowPublic: options.allowPublic,
          reservedPorts: [options.uiPort, options.bridgePort].filter((p) => p > 0),
          status: {
            satori: satori ? { bound: satoriBound, token: satori.token, clients: clientCounts().satori } : null,
            onebot: onebot ? onebot.status() : []
          }
        }),
        save: async (raw, revision) => {
          if (revision !== undefined && revision !== null && revision !== configRevision) {
            const error = new Error('配置已被其他地方修改（当前 rev ' + configRevision + '），请刷新页面后重试');
            error.status = 409;
            throw error;
          }
          const next = normalizeConfig(raw, { allowPublic: options.allowPublic });
          return await applyNetworkConfig(next);
        }
      },
      // Synthetic inbound message for framework tests (the bridge's emit_test);
      // like /api/call it needs the X-Debug-Call header and only exists on the
      // loopback debug port.
      emitTest: (params) => core.rpc.call('emit_test', params || {}, 10000)
    });
    addTap((level, text, line, source) => {
      if (ui) ui.onLog(level, text, line, source);
    });
  }

  rpc.on('hello', (message) => {
    if (message.self) store.setSelf(message.self);
    // A fresh hello means a previous kick no longer applies.
    store.markOnline();
    if (message.self && message.self.uin) {
      logger.info(`QQ bridge ready: ${message.self.uin} ${message.self.nick || ''}`);
    }
    const compat = core.compatibility();
    const key = compat.qqVersion + '|' + compat.allowUntested + '|' +
      compat.criticalMissing.join(',') + '|' + compat.missing.length;
    if (compat.warnings.length && key !== compatWarned) {
      compatWarned = key;
      for (const warning of compat.warnings) logger.warn('compat:', warning);
    } else if (compat.tested) {
      logger.info('compat: QQ ' + compat.qqVersion + ' is a tested build');
    }
  });
  // Two bridge promotions in a row (a stale socket being replaced) must not
  // look like an account that went offline and came back.
  let bridgeUp = false;
  let compatWarned = '';
  rpc.on('connect', () => {
    core.ensureSelf(true)
      .then(() => logger.info('self resolved:', store.self))
      .catch((error) => logger.warn('self resolve failed:', error.message))
      .finally(() => {
        if (bridgeUp) return;
        bridgeUp = true;
        // Satori clients see ONLINE/RECONNECT through login-updated; OneBot has
        // its own lifecycle meta-event for the same moment.
        if (satori) {
          satori.setLink('up');
          satori.loginUpdated();
        }
        if (onebot) onebot.lifecycle('enable');
      });
  });
  rpc.on('disconnect', () => {
    logger.warn('QQ bridge offline; waiting for reconnect');
    if (!bridgeUp) return;
    bridgeUp = false;
    if (satori) {
      satori.setLink('down');
      satori.loginUpdated();
    }
    if (onebot) onebot.lifecycle('disable');
  });
  rpc.on('event', (event) => {
    store.applyEvent(event);
    if (ui) ui.onKernelEvent(event);
    if (event.type === 'message') {
      const who = event.sender ? (event.sender.card || event.sender.nick || event.sender.uin) : '';
      logger.debug(`event ${event.direction} ${event.is_group ? 'group ' + event.group_id : 'private'} ${who}: ${event.raw_message || ''}`);
    } else {
      logger.debug('event:', event.type);
    }
    if (satori) satori.onEvent(event);
    if (onebot) onebot.onEvent(event);
  });

  try {
    await rpc.start();
    logger.info(`bridge RPC listening on ${options.bridgeHost}:${options.bridgePort}`);
  } catch (error) {
    logger.error('failed to start bridge RPC:', error.message);
    process.exit(1);
    return;
  }

  if (satori) {
    wireSatoriActivity();
    try {
      await startSatoriSurface();
    } catch (error) {
      logger.error('failed to bind endpoint:', error.message);
      process.exit(1);
      return;
    }
    logger.info(`example: curl -H "Authorization: Bearer ${satori.token}" http://${options.host}:${options.port}/v1/login.get`);
  }

  if (onebot) {
    wireOnebotActivity();
    const started = await onebot.start();
    logOnebotSummary(started);
  }

  if (ui) {
    // A debug page must never be the reason the endpoint is down, so a bind
    // failure here is a warning, not an exit.
    try {
      const url = await ui.listen();
      logger.info('debug page: ' + url + '  ·  聊天界面 chat: ' + url + 'chat  ·  网络配置 config: ' + url + 'config');
    } catch (error) {
      logger.warn(`debug page did not start on :${options.uiPort} (${error.message}); protocols are unaffected`);
      ui.close();
      ui = null;
    }
  }

  let healthWriter = null;
  if (options.healthFile) {
    healthWriter = startHealthWriter({
      file: options.healthFile,
      snapshot: healthSnapshot,
      intervalMs: 5000,
      logger: logger.child('health')
    });
    logger.info('health file: ' + options.healthFile + ' (rewritten every 5s)');
  }

  if (options.install) {
    installBridge(options, logger);
  } else {
    logger.info('inject with: bin\\qqinject.exe --bridge-only --port ' + options.bridgePort);
  }

  let stopWatching = null;
  if (options.watch) {
    stopWatching = watchConsole(options, logger, resolveRepoPath('scripts', 'headless_stop.js'));
    logger.info('watching the launcher console pid=' + options.watch +
      (options.ownedQQ ? ' (会连带停掉 QQ pid=' + options.ownedQQ + ')' : '') +
      (options.instance ? ' instance ' + options.instance : ''));
  }

  const shutdown = () => {
    logger.info('shutting down');
    if (healthWriter) healthWriter.stop();
    if (stopWatching) stopWatching();
    if (ui) ui.close();
    if (satori) satori.close();
    if (onebot) onebot.close();
    if (server) {
      try { server.close(); } catch (e) { /* ignore */ }
    }
    rpc.stop();
    setTimeout(() => process.exit(0), 100);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => {
    if (healthWriter) {
      try { healthWriter.stop(); } catch (e) { /* ignore */ }
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
