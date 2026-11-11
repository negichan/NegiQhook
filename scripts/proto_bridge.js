// QQ <-> external protocol endpoint bridge (runs inside QQ's Node main process).
//
// This script only owns the QQ side: it listens to kernel callbacks, normalises
// them into transport-neutral events, and executes actions requested by the
// external endpoint. It contains no Satori/OneBot concepts.
//
// Wire format (newline-delimited JSON, one object per line):
//   QQ -> endpoint : {type:'hello'|'event'|'log'}
//   endpoint -> QQ : {type:'action', id, action, params}
//   QQ -> endpoint : {type:'result', id, ok, data|error}
//
// Installed by: qqinject.exe --bridge-only --port <port>
(() => {
  'use strict';
  const main = process.mainModule;
  const req = main && main.require ? main.require.bind(main) :
    (process.getBuiltinModule ? process.getBuiltinModule.bind(process) : null);
  if (!req) throw new Error('no require available');
  const fs = req('fs');
  const path = req('path');
  const net = req('net');
  const crypto = req('crypto');

  // The host (src/headless/app.main.js) hands configuration over through one
  // symbol-keyed object. The old __qqhook* globals are still read as a fallback
  // for the attach/debug path, where the installer evaluates this file without
  // the headless main. Mutable state lives in one symbol-keyed object so a
  // re-evaluation replaces one namespace instead of scattering a dozen names
  // over QQ's global object.
  const CONFIG_KEY = Symbol.for('qqhook.bridge.config');
  const STATE_KEY = Symbol.for('qqhook.bridge.state');
  const fileConfig = (() => {
    const value = globalThis[CONFIG_KEY];
    return value && typeof value === 'object' ? value : {};
  })();
  function setting(name, legacy) {
    if (Object.prototype.hasOwnProperty.call(fileConfig, name)) return fileConfig[name];
    return legacy ? globalThis[legacy] : undefined;
  }
  const state = (() => {
    if (globalThis[STATE_KEY] && typeof globalThis[STATE_KEY] === 'object') {
      return globalThis[STATE_KEY];
    }
    const created = {
      generation: 0,
      instance: null,
      wrapper: globalThis.__qqhookWrapper || null,
      wrapperPath: globalThis.__qqhookWrapperPath || '',
      session: globalThis.__qqhookSession || null,
      self: {
        uin: Number(globalThis.__qqhookSelfUin || 0) || 0,
        uid: globalThis.__qqhookSelfUid || '',
        nick: globalThis.__qqhookSelfNick || ''
      },
      msgService: globalThis.__qqhookMsgService || null,
      listeners: {
        registered: !!globalThis.__qqhookBridgeListenerRegistered,
        msg: globalThis.__qqhookBridgeListenerId || '',
        group: globalThis.__qqhookBridgeGroupListenerId || '',
        buddy: globalThis.__qqhookBridgeBuddyListenerId || ''
      },
      window: globalThis.__qqhookWindowState || null,
      tray: globalThis.__qqhookTrayState || null
    };
    Object.defineProperty(globalThis, STATE_KEY, {
      value: created, configurable: true, writable: true, enumerable: false
    });
    return created;
  })();

  const requestedPort = Number(setting('port', '__qqhookProtoPort') || 47840) || 47840;
  const logFile = setting('log_file', '__qqhookLogFile') ||
    path.join(process.env.TEMP || 'C:/Windows/Temp', 'qqhook_proto.log');
  const logEnabled = setting('log_enabled', '__qqhookLogEnabled') !== false;
  // Local IPC authentication. Empty means "legacy / debug attach": qqproto only
  // enforces this when it was started with --bridge-token.
  const bridgeToken = String(setting('bridge_token', '__qqhookBridgeToken') || '');
  const bridgeVersion = Number(setting('bridge_version', '__qqhookBridgeVersion') || 2) || 2;
  const bridgeQQVersion = String(setting('qq_version', '__qqhookQQVersion') || '');
  const bridgeAppid = String(setting('appid', '__qqhookAppid') || '');
  const bridgeQua = String(setting('qua', '__qqhookQua') || '');
  const bridgeHeadless = !!setting('headless', '__qqhookHeadless');
  const MAX_EVENT_BUFFER = 500;

  // Each evaluation is a new generation. Older closures stop reconnecting once
  // superseded, so iterating on the bridge cannot leave two sockets flapping
  // against the endpoint.
  const generation = (Number(state.generation) || 0) + 1;
  state.generation = generation;
  function isCurrent() {
    return Number(state.generation) === generation;
  }

  // Re-evaluating this script replaces the previous instance (useful while
  // iterating on the bridge without restarting QQ). `dispose` removes the native
  // listener and drops the socket before the new closure starts.
  const previous = state.instance;
  if (previous) {
    try {
      if (typeof previous.dispose === 'function') {
        previous.dispose();
      } else {
        // Older instance without dispose(): at least detach its native listener
        // so the new closure owns the event stream. Its socket is replaced when
        // the new connection reaches the endpoint.
        const service = state.msgService ||
          (state.session && state.session.getMsgService());
        const listenerId = state.listeners.msg;
        if (service && listenerId) service.removeKernelMsgListener(listenerId);
        state.listeners.registered = false;
        state.listeners.msg = '';
      }
    } catch (e) { /* ignore */ }
  }

  let currentPort = requestedPort;
  let sock = null;
  let sockReady = false;
  let helloDone = false;
  let buffered = [];
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let lastError = '';
  let lastEventAt = 0;
  let inboundBuffer = '';
  const counters = {
    event: 0, action: 0, actionError: 0, dropped: 0, recall: 0, send: 0
  };

  // Actions whose effect can be seen by someone else, or that mutate a group,
  // friend or file tree. Local red-dot clears, reads, window/tray tools and ping
  // are deliberately absent: they neither reach another account nor spend a
  // server-side quota.
  const WRITE_ACTIONS = new Set([
    'send_message', 'upload_group_file', 'recall',
    'set_group_ban', 'set_group_whole_ban', 'set_group_kick', 'set_group_admin',
    'set_group_card', 'set_group_name', 'set_group_special_title',
    'set_group_leave', 'set_group_remark',
    'handle_group_request', 'handle_friend_request',
    'set_friend_remark', 'delete_friend',
    'send_group_notice', 'delete_group_notice',
    'set_msg_reaction', 'set_essence', 'forward_message', 'send_like',
    'delete_group_file', 'create_group_folder', 'delete_group_folder',
    'rename_group_folder', 'move_group_file'
  ]);

  function bounded(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(number)));
  }

  // A bridge is one account with one human behind it. These limits are not a
  // security boundary; they keep a looping bot from turning into the kind of
  // uniform burst that gets an account restricted.
  const budgetConfig = (() => {
    const raw = setting('write_budget', '__qqhookWriteBudget');
    return raw && typeof raw === 'object' ? raw : {};
  })();
  const writeBudget = {
    perMinute: bounded(budgetConfig.per_minute, 30, 1, 600),
    perHour: bounded(budgetConfig.per_hour, 600, 1, 20000),
    minIntervalMs: bounded(budgetConfig.min_interval_ms, 300, 0, 60000),
    jitterMs: bounded(budgetConfig.jitter_ms, 120, 0, 10000),
    breakerErrors: bounded(budgetConfig.breaker_errors, 3, 1, 20),
    breakerCooldownMs: bounded(budgetConfig.breaker_cooldown_ms, 60000, 1000, 3600000)
  };
  const writeState = {
    minute: [], hour: [], lastAt: 0, strikes: 0, openUntil: 0,
    total: 0, blocked: 0, lastError: ''
  };

  function pruneWrites(now) {
    const minuteFloor = now - 60000;
    const hourFloor = now - 3600000;
    while (writeState.minute.length && writeState.minute[0] < minuteFloor) writeState.minute.shift();
    while (writeState.hour.length && writeState.hour[0] < hourFloor) writeState.hour.shift();
  }

  function writeLimits() {
    const now = Date.now();
    pruneWrites(now);
    return {
      budget: {
        per_minute: writeBudget.perMinute,
        per_hour: writeBudget.perHour,
        min_interval_ms: writeBudget.minIntervalMs,
        jitter_ms: writeBudget.jitterMs,
        breaker_errors: writeBudget.breakerErrors,
        breaker_cooldown_ms: writeBudget.breakerCooldownMs
      },
      used_minute: writeState.minute.length,
      used_hour: writeState.hour.length,
      total: writeState.total,
      blocked: writeState.blocked,
      strikes: writeState.strikes,
      open: now < writeState.openUntil,
      open_until: writeState.openUntil || 0,
      retry_after: now < writeState.openUntil
        ? Math.ceil((writeState.openUntil - now) / 1000) : 0,
      last_error: writeState.lastError
    };
  }

  function isWriteAction(action) {
    return WRITE_ACTIONS.has(String(action || ''));
  }

  // Called from the action result path, not from the action bodies: every
  // external write goes through here once, whichever action it was.
  function noteWriteSuccess(action) {
    if (!isWriteAction(action)) return;
    writeState.strikes = 0;
  }

  function noteWriteFailure(action, error) {
    if (!isWriteAction(action)) return;
    if (error && (error.code === 'rate_limited' || error.code === 'circuit_open' ||
        error.code === 'untested_version')) return;
    const message = String(error && error.message || error);
    const risk = /result\s*=\s*121\b|risk.?control|风控|频率限制|操作频繁|too\s+(?:many|frequent)|rate.?limit/i
      .test(message);
    if (!risk) return;
    writeState.strikes++;
    writeState.lastError = message;
    if (writeState.strikes >= writeBudget.breakerErrors) {
      writeState.openUntil = Date.now() + writeBudget.breakerCooldownMs;
      writeState.strikes = 0;
      appendLog('write circuit opened for ' + writeBudget.breakerCooldownMs +
        'ms after risk-control failures; last=' + message);
      sendLog('warn', 'write circuit opened after ' + message);
    }
  }

  // Token buckets + spacing + jitter. A refusal here never touches the kernel:
  // the caller gets a result with a code the adapters can map to 429/1401.
  async function gateWrite(action) {
    if (!isWriteAction(action)) return;
    const now = Date.now();
    pruneWrites(now);
    if (now < writeState.openUntil) {
      writeState.blocked++;
      const seconds = Math.ceil((writeState.openUntil - now) / 1000);
      const error = new Error(
        'write circuit is open after repeated risk-control failures; retry in ' +
        seconds + 's (last: ' + (writeState.lastError || 'unknown') + ')'
      );
      error.code = 'circuit_open';
      error.retry_after = seconds;
      throw error;
    }
    if (writeState.minute.length >= writeBudget.perMinute ||
        writeState.hour.length >= writeBudget.perHour) {
      writeState.blocked++;
      const windowMs = writeState.minute.length >= writeBudget.perMinute ? 60000 : 3600000;
      const error = new Error(
        'write budget exhausted (' + (windowMs === 60000
          ? writeBudget.perMinute + '/minute'
          : writeBudget.perHour + '/hour') + '); refusing "' + action + '"'
      );
      error.code = 'rate_limited';
      error.retry_after = Math.ceil(windowMs / 1000);
      throw error;
    }
    const spacing = Math.max(
      0,
      writeState.lastAt + writeBudget.minIntervalMs - now,
      writeBudget.jitterMs > 0 ? Math.floor(Math.random() * (writeBudget.jitterMs + 1)) : 0
    );
    if (spacing > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, spacing);
        if (timer.unref) timer.unref();
      });
    }
    const at = Date.now();
    writeState.lastAt = at;
    writeState.minute.push(at);
    writeState.hour.push(at);
    writeState.total++;
  }

  const messageCache = new Map();       // msgId -> normalised event
  const emittedOutgoing = new Set();    // msgId already reported
  const emittedRecall = new Set();
  const emittedMembership = new Set();  // gray-tip "someone joined / left" msgIds
  // TipGroupElement.type for the two membership notices this build reports.
  // The enum is NapCat's reading of the same kernel field (KMEMBERADD=1,
  // KQUITTE=3); anything else stays a normal message.
  const MEMBERSHIP_TIP = new Map([[1, 'add'], [3, 'quit']]);
  const pendingSends = new Map();       // clientId -> {resolve, timer}
  // The kernel's sent-message callback carries peerUid (a uid for friends) but
  // not the QQ number, so remember the destination of each send by its client id
  // and fill the missing peer fields on the outgoing echo. Without this a Satori
  // `send` event addressed the channel as "0".
  const sentPeers = new Map();          // clientId -> {is_group, peer_uin, peer_name}
  const stagedFallbackTimers = new Set(); // late cleanups of staged copies
  let selfPromise = null;
  let friendsCache = null;
  let friendsAt = 0;
  let groupsCache = null;
  let groupsAt = 0;
  const memberCache = new Map();        // groupId -> {at, members}

  function appendLog(line) {
    if (!logEnabled) return;
    try {
      const st = fs.statSync(logFile);
      if (st.size > 8 * 1024 * 1024) fs.renameSync(logFile, logFile + '.1');
    } catch (e) { /* first write */ }
    try { fs.appendFileSync(logFile, new Date().toISOString() + ' ' + line + '\n'); }
    catch (e) { /* best effort */ }
  }

  function text(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  // A compact structural dump of a kernel payload. The type definitions say
  // what a callback *should* carry; when the client pushes something else the
  // action just looks empty, so the empty paths print this instead of guessing.
  function describe(value, depth) {
    const level = depth || 0;
    if (value === null || value === undefined) return String(value);
    if (Array.isArray(value)) {
      const head = value.slice(0, 3).map((item) => describe(item, level + 1)).join(', ');
      return '[' + head + (value.length > 3 ? ', …+' + (value.length - 3) : '') + '] len=' + value.length;
    }
    const t = typeof value;
    if (t === 'string') return JSON.stringify(value.length > 60 ? value.slice(0, 60) + '…' : value);
    if (t !== 'object') return t + ':' + String(value);
    // Cross-realm safe: an injected Map/Set does not pass instanceof here.
    if (typeof value.get === 'function' && typeof value.keys === 'function' && typeof value.size === 'number') {
      const entries = [];
      try {
        for (const key of Array.from(value.keys()).slice(0, 4)) entries.push(text(key) + '=>' + describe(value.get(key), level + 1));
      } catch (e) { entries.push('unreadable'); }
      return 'Map(' + value.size + '){' + entries.join(', ') + '}';
    }
    if (level >= 2) return 'object{' + Object.keys(value).slice(0, 14).join(',') + '}';
    const parts = [];
    for (const key of Object.keys(value).slice(0, 14)) {
      try { parts.push(key + ':' + describe(value[key], level + 1)); }
      catch (e) { parts.push(key + ':<throw>'); }
    }
    return '{' + parts.join(', ') + '}';
  }

  // Full payload dump for the cases where describe() hides too much: a feed
  // list we cannot read looks exactly like a board with nothing on it. Falls
  // back to describe() for anything JSON cannot take (cycles, getters that
  // throw), and is only reached behind an explicit `debug` option.
  function dump(value, limit) {
    const seen = new WeakSet();
    try {
      const line = JSON.stringify(value, (key, item) => {
        if (item instanceof WeakMap || item instanceof WeakSet) return '[weak]';
        if (item && typeof item === 'object') {
          if (seen.has(item)) return '[cycle]';
          seen.add(item);
          // Cross-realm safe duck-typing for the kernel's Map/Set containers.
          if (typeof item.get === 'function' && typeof item.keys === 'function' && typeof item.size === 'number') {
            const out = {};
            for (const k of Array.from(item.keys()).slice(0, 20)) out[text(k)] = item.get(k);
            return out;
          }
          if (typeof item.keys === 'function' && typeof item.size === 'number' && typeof item.get !== 'function') {
            return Array.from(item).slice(0, 20);
          }
        }
        return item;
      });
      const cap = limit || 6000;
      return line && line.length > cap ? line.slice(0, cap) + '…(' + line.length + ')' : line;
    } catch (e) {
      return describe(value) + ' (json failed: ' + (e && e.message || e) + ')';
    }
  }

  function emptyId(value) {
    const s = text(value);
    return s === '' || /^0+$/.test(s);
  }

  function sendRaw(obj) {
    if (!isCurrent()) return false;
    const line = JSON.stringify(obj);
    // Do not put events/logs on the wire before hello: with a bridge token the
    // endpoint has no way to authenticate them yet. They wait for the first
    // hello (which is sent as soon as the account is known) and are flushed
    // right after it.
    if (obj.type !== 'hello' && !helloDone) {
      if (obj.type === 'event') {
        if (buffered.length < MAX_EVENT_BUFFER) buffered.push(line);
        else counters.dropped++;
      } else {
        counters.dropped++;
      }
      return false;
    }
    if (sock && sockReady) {
      try {
        sock.write(line + '\n');
        return true;
      } catch (e) {
        lastError = 'write: ' + (e && e.message || e);
        counters.dropped++;
      }
    }
    // Actions never queue; events queue so a short endpoint restart does not
    // lose the incoming message that caused the reconnect.
    if (obj.type !== 'event') return false;
    if (buffered.length < MAX_EVENT_BUFFER) buffered.push(line); else counters.dropped++;
    return false;
  }

  function flushBuffered() {
    if (!isCurrent() || !sock || !sockReady || !helloDone) return;
    const pending = buffered;
    buffered = [];
    for (const line of pending) {
      try { sock.write(line + '\n'); }
      catch (e) {
        lastError = 'write: ' + (e && e.message || e);
        counters.dropped++;
      }
    }
  }

  // Kernel methods this bridge actually calls, grouped by the service that is
  // supposed to expose them. Reported in hello so the endpoint can tell a
  // changed build from a broken setup before anyone tries a write.
  const REQUIRED_METHODS = {
    getMsgService: [
      'addKernelMsgListener', 'removeKernelMsgListener', 'sendMsg', 'recallMsg',
      'setMsgRead', 'setMsgEmojiLikes', 'forwardMsg', 'generateMsgUniqueId',
      'getRichMediaFilePathForGuild'
    ],
    getGroupService: [
      'addKernelGroupListener', 'removeKernelGroupListener', 'getGroupList',
      'getAllMemberList', 'getUidByUins', 'getUinByUids', 'setMemberShutUp',
      'setGroupShutUp', 'kickMember', 'modifyMemberRole', 'modifyMemberCardName',
      'modifyGroupName', 'modifyGroupRemark', 'quitGroup', 'destroyGroup',
      'getGroupRemainAtTimes', 'getGroupMemberLevelInfo', 'getGroupDetailInfo',
      'getGroupShutUpMemberList', 'getSingleScreenNotifies', 'operateSysNotify',
      'addGroupEssence', 'removeGroupEssence', 'publishGroupBulletin',
      'deleteGroupBulletin', 'uploadGroupBulletinPic', 'getGroupBulletinList',
      'clearGroupNotifies', 'clearGroupNotifiesUnreadCount'
    ],
    getBuddyService: [
      'addKernelBuddyListener', 'removeKernelBuddyListener', 'getBuddyList',
      'getBuddyReq', 'approvalFriendRequest', 'setBuddyRemark', 'delBuddy',
      'clearBuddyReqUnreadCnt'
    ],
    getRichMediaService: [
      'getGroupFileList', 'batchGetGroupFileCount', 'getGroupFileInfo',
      'deleteGroupFile', 'createGroupFolder', 'deleteGroupFolder',
      'renameGroupFolder', 'moveGroupFile', 'getPicTmpPath', 'translateEnWordToZn'
    ],
    getTipOffService: ['getPskey'],
    getUixConvertService: ['getUid'],
    getProfileService: ['getCoreAndBaseInfo', 'getUidByUin'],
    getProfileLikeService: ['setBuddyProfileLike'],
    getMSFService: ['getServerTime'],
    getNodeMiscService: ['wantWinScreenOCR']
  };

  function bridgeCapabilities() {
    const services = [];
    const missing = [];
    try {
      const alive = session();
      for (const name of [
        'getMsgService', 'getBuddyService', 'getGroupService',
        'getProfileService', 'getRichMediaService', 'getFlashTransferService',
        'getStorageCleanService', 'getMSFService', 'getNodeMiscService',
        'getTipOffService', 'getUixConvertService', 'getProfileLikeService'
      ]) {
        if (alive && typeof alive[name] === 'function') {
          services.push(name.replace(/^get/, '').replace(/Service$/, ''));
        }
      }
      for (const [name, methods] of Object.entries(REQUIRED_METHODS)) {
        let service = null;
        try {
          service = typeof alive[name] === 'function' ? alive[name]() : null;
        } catch (e) { service = null; }
        if (!service) {
          missing.push(name + ' (service unavailable)');
          continue;
        }
        for (const method of methods) {
          if (typeof service[method] !== 'function') missing.push(name + '.' + method);
        }
      }
    } catch (e) { /* kernel/session not ready yet */ }
    let actionCount = 0;
    try { actionCount = Object.keys(actions).length; } catch (e) { /* TDZ during very early hello */ }
    return { services: services, actions: actionCount, missing: missing };
  }

  function sendHello() {
    const self = currentSelf();
    const sent = sendRaw({
      type: 'hello',
      bridge: 'qqproto/2',
      bridge_version: bridgeVersion,
      token: bridgeToken,
      qq_version: bridgeQQVersion,
      appid: bridgeAppid,
      qua: bridgeQua,
      headless: bridgeHeadless,
      capabilities: bridgeCapabilities(),
      limits: writeLimits(),
      generation: generation,
      instance: generation + '-' + process.pid,
      pid: process.pid,
      time: Date.now(),
      self: self
    });
    if (sent) {
      helloDone = true;
      flushBuffered();
      startHeartbeat();
    }
  }

  // With `qqinject --launch` the bridge can be installed before the login list
  // exists. A hello carrying uin=0 would make the endpoint's self id useless,
  // so wait for a real account and then announce it (also after reconnect).
  let helloRetryTimer = null;
  function sendHelloWhenReady() {
    if (!isCurrent()) return;
    ensureSelf().then((self) => {
      if (!isCurrent()) return;
      if (self && self.uin) {
        if (sockReady) sendHello();
        if (helloRetryTimer) {
          clearTimeout(helloRetryTimer);
          helloRetryTimer = null;
        }
        return;
      }
      if (!helloRetryTimer) {
        helloRetryTimer = setTimeout(() => {
          helloRetryTimer = null;
          sendHelloWhenReady();
        }, 1000);
        if (helloRetryTimer.unref) helloRetryTimer.unref();
      }
    }).catch(() => { /* retried by the next event/action */ });
  }

  function sendLog(level, message) {
    sendRaw({ type: 'log', level: level, message: message, time: Date.now() });
  }

  function scheduleReconnect() {
    if (!isCurrent() || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 2000);
  }

  // A small control frame the endpoint does not have to ask for. It keeps the
  // write-budget and circuit state visible in /health without a periodic RPC.
  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      if (!isCurrent() || !sockReady || !helloDone) return;
      sendRaw({
        type: 'heartbeat',
        time: Date.now(),
        self: currentSelf(),
        connected: true,
        last_event_at: lastEventAt,
        counters: Object.assign({}, counters),
        limits: writeLimits()
      });
    }, 15000);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }

  function connect() {
    if (!isCurrent() || sock) return;
    let socket = null;
    try {
      socket = net.connect({ host: '127.0.0.1', port: currentPort });
      sock = socket;
      socket.setNoDelay(true);
      socket.on('connect', () => {
        if (!isCurrent() || sock !== socket) {
          try { socket.destroy(); } catch (e) { /* ignore */ }
          return;
        }
        sockReady = true;
        helloDone = false;
        lastError = '';
        inboundBuffer = '';
        sendHelloWhenReady();
      });
      socket.on('data', (chunk) => {
        if (!isCurrent() || sock !== socket) return;
        inboundBuffer += chunk.toString('utf8');
        let index;
        while ((index = inboundBuffer.indexOf('\n')) !== -1) {
          const line = inboundBuffer.slice(0, index).replace(/\r$/, '');
          inboundBuffer = inboundBuffer.slice(index + 1);
          if (!line) continue;
          handleEndpointLine(line);
        }
        // A malformed endpoint should not grow this buffer without bound.
        if (inboundBuffer.length > 8 * 1024 * 1024) {
          inboundBuffer = '';
          lastError = 'inbound buffer overflow';
          counters.dropped++;
        }
      });
      socket.on('error', (e) => {
        if (sock === socket) lastError = String(e && e.message || e);
      });
      socket.on('close', () => {
        if (sock !== socket) return;
        sockReady = false;
        sock = null;
        socket = null;
        if (isCurrent()) scheduleReconnect();
      });
    } catch (e) {
      lastError = String(e && e.message || e);
      sock = null;
      sockReady = false;
      scheduleReconnect();
    }
  }

  function handleEndpointLine(line) {
    if (!isCurrent()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (e) {
      sendLog('warn', 'bad endpoint frame: ' + line.slice(0, 120));
      return;
    }
    if (!message || message.type !== 'action') return;
    const id = message.id;
    const action = text(message.action);
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    counters.action++;
    Promise.resolve()
      .then(() => gateWrite(action))
      .then(() => dispatch(action, params))
      .then((data) => {
        noteWriteSuccess(action);
        sendRaw({ type: 'result', id: id, ok: true, data: data === undefined ? null : data });
      })
      .catch((error) => {
        counters.actionError++;
        noteWriteFailure(action, error);
        const textError = String(error && error.message || error);
        appendLog('action ' + action + ' failed: ' + textError);
        const result = { type: 'result', id: id, ok: false, error: textError };
        if (error && error.code) result.code = error.code;
        if (error && error.retry_after) result.retry_after = error.retry_after;
        sendRaw(result);
      });
  }

  function wrapperModule() {
    if (state.wrapper) return state.wrapper;
    const versionsRoot = path.join(path.dirname(process.execPath), 'versions');
    const candidates = [];
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'app', 'wrapper.node'));
    candidates.push(path.join(path.dirname(process.execPath), 'resources', 'app', 'wrapper.node'));
    try {
      for (const name of fs.readdirSync(versionsRoot)) {
        candidates.push(path.join(versionsRoot, name, 'resources', 'app', 'wrapper.node'));
      }
    } catch (e) { /* not the versioned layout */ }
    const file = candidates.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
    if (!file) throw new Error('wrapper.node not found');
    const mod = { exports: {} };
    process.dlopen(mod, file);
    state.wrapper = mod.exports;
    state.wrapperPath = file;
    return mod.exports;
  }

  function session() {
    if (state.session) return state.session;
    const wrapper = wrapperModule();
    const cls = wrapper.NodeIQQNTWrapperSession;
    if (!cls || typeof cls.getNTWrapperSession !== 'function') {
      throw new Error('NodeIQQNTWrapperSession.getNTWrapperSession is missing');
    }
    const value = cls.getNTWrapperSession('nt_1');
    if (!value) throw new Error("session 'nt_1' not created yet");
    state.session = value;
    return value;
  }

  function currentSelf() {
    return {
      uin: Number(state.self.uin || 0) || 0,
      uid: state.self.uid || '',
      nick: state.self.nick || ''
    };
  }

  function ensureSelf() {
    if (state.self.uin && state.self.uid) {
      return Promise.resolve(currentSelf());
    }
    if (selfPromise) return selfPromise;
    selfPromise = new Promise((resolve) => {
      const finish = (value) => {
        if (value && value.uin) {
          state.self.uin = Number(value.uin) || 0;
          state.self.uid = value.uid || '';
          state.self.nick = value.nickName || value.nick || '';
        }
        resolve(currentSelf());
      };
      try {
        const wrapper = wrapperModule();
        const cls = wrapper.NodeIKernelLoginService;
        const service = cls && typeof cls.get === 'function' ? cls.get() : null;
        if (!service || typeof service.getLoginList !== 'function') {
          finish(null);
          return;
        }
        const apply = (value) => {
          const list = (value && value.LocalLoginInfoList) || [];
          finish(list.find(item => item && item.isUserLogin) ||
            list.find(item => item && item.isAutoLogin) || list[0] || null);
        };
        const result = service.getLoginList();
        if (result && typeof result.then === 'function') {
          result.then(apply).catch(() => finish(null));
        } else {
          apply(result);
        }
      } catch (e) {
        appendLog('ensureSelf: ' + (e && e.stack || e));
        finish(null);
      }
    }).finally(() => { selfPromise = null; });
    return selfPromise;
  }

  function convertTextElement(el) {
    const te = el.textElement || {};
    const content = text(te.content);
    const atType = Number(te.atType || 0);
    const atUin = emptyId(te.atUin) ? '' : text(te.atUin);
    const atUid = emptyId(te.atNtUid) ? '' : text(te.atNtUid);
    if (atType !== 0 || atUin || atUid) {
      const all = atType === 2 || atUin === 'all' || atUid === 'all';
      const name = content.replace(/^@\s*/, '') || (all ? '全体成员' : atUin || atUid);
      return { type: 'at', data: { qq: all ? 'all' : (atUin || atUid), uid: atUid, name: name } };
    }
    return { type: 'text', data: { text: content } };
  }

  function convertElement(el) {
    if (!el || typeof el !== 'object') return { type: 'unknown', data: {} };
    const type = Number(el.elementType);
    switch (type) {
      case 1:
        return convertTextElement(el);
      case 2: {
        const pic = el.picElement || {};
        // `path` is where the bytes actually are on this machine (original or,
        // failing that, the client's thumbnail); `thumb` says which. `url` stays
        // the server-side address and is often empty for pictures this account
        // sent itself.
        const local = existingFile(elementPicPaths(pic)) ||
          resolvePicPath(pic.md5HexStr, pic.fileName);
        return { type: 'image', data: {
          file: text(pic.fileName), url: text(pic.originImageUrl),
          file_size: Number(pic.fileSize) || 0, md5: text(pic.md5HexStr),
          file_uuid: text(pic.fileUuid), width: Number(pic.picWidth) || 0,
          height: Number(pic.picHeight) || 0, summary: text(pic.summary),
          path: text(local && local.path), thumb: !!(local && local.thumb)
        } };
      }
      case 3: {
        const file = el.fileElement || {};
        return { type: 'file', data: {
          name: text(file.fileName), size: Number(file.fileSize) || 0,
          md5: text(file.fileMd5 || file.file10MMd5), file_uuid: text(file.fileUuid)
        } };
      }
      case 4: {
        const ptt = el.pttElement || {};
        return { type: 'record', data: {
          file: text(ptt.fileName), duration: Number(ptt.duration) || 0,
          md5: text(ptt.md5HexStr), text: text(ptt.text)
        } };
      }
      case 5: {
        const video = el.videoElement || {};
        return { type: 'video', data: {
          file: text(video.fileName), size: Number(video.fileSize) || 0,
          duration: Number(video.fileTime) || 0, md5: text(video.videoMd5),
          file_uuid: text(video.fileUuid)
        } };
      }
      case 6: {
        const face = el.faceElement || {};
        return { type: 'face', data: {
          id: Number(face.faceIndex) || 0, text: text(face.faceText), face_type: face.faceType
        } };
      }
      case 7: {
        const reply = el.replyElement || {};
        return { type: 'reply', data: {
          id: text(reply.replyMsgId), sender_uin: text(reply.senderUin), text: text(reply.sourceMsgText)
        } };
      }
      case 10:
        return { type: 'json', data: { text: text((el.arkElement || {}).bytesData).slice(0, 500) } };
      case 11: {
        const mface = el.marketFaceElement || {};
        return { type: 'mface', data: {
          id: text(mface.emojiId), name: text(mface.faceName), summary: text(mface.summary)
        } };
      }
      case 16:
        return { type: 'forward', data: { id: text((el.multiForwardMsgElement || {}).resId) } };
      case 8: {
        // Gray tips carry the group's own little notices: member joined/left,
        // admin changed, mute/unmute, group renamed. NapCat reads the same
        // `grayTipElement.groupElement`; the ids are uids, so uins are resolved
        // by the caller. `json` is the fallback for tips that only exist as a
        // sentence (the "[x] 加入了群聊" variant).
        const tip = el.grayTipElement || {};
        const group = tip.groupElement || {};
        return { type: 'gray_tip', data: {
          sub_type: Number(tip.subElementType) || 0,
          tip_type: Number(group.type) || 0,
          group_name: text(group.groupName),
          member_uid: text(group.memberUid),
          member_nick: text(group.memberNick),
          operator_uid: text(group.adminUid),
          operator_nick: text(group.adminNick),
          role: Number(group.role) || 0,
          json: text((tip.jsonGrayTipElement || {}).jsonStr).slice(0, 500)
        } };
      }
      default:
        return { type: 'unknown', data: {
          element_type: type,
          keys: Object.keys(el).filter(k => k !== 'elementType' && k !== 'elementId').slice(0, 12)
        } };
    }
  }

  function segmentText(seg) {
    switch (seg.type) {
      case 'text': return seg.data.text;
      case 'at': return seg.data.qq === 'all' ? '@全体成员' : '@' + (seg.data.name || seg.data.qq);
      case 'image': return '[图片]';
      case 'face': return seg.data.text ? '[表情:' + seg.data.text + ']' : '[表情]';
      case 'mface': return '[表情]';
      case 'record': return '[语音]';
      case 'video': return '[视频]';
      case 'file': return '[文件]';
      case 'reply': return '';
      case 'forward': return '[聊天记录]';
      case 'json': return '[卡片消息]';
      default: return '[消息]';
    }
  }

  function normalizeRaw(raw, direction) {
    const message = raw || {};
    const elements = Array.isArray(message.elements) ? message.elements : [];
    const segments = elements.map(convertElement);
    const chatType = Number(message.chatType) || 0;
    const isGroup = chatType === 2;
    const self = currentSelf();
    const senderUin = Number(message.senderUin || 0) || 0;
    const event = {
      type: 'message',
      direction: direction,
      message_id: text(message.msgId),
      client_id: text(message.guildId),
      // The kernel's per-chat sequence and random are what the essence and
      // emoji-reaction APIs address a message by; the 64-bit msgId alone is not
      // enough for them, so carry them instead of reading them back from the DB.
      sequence: text(message.msgSeq),
      client_seq: text(message.clientSeq),
      random: text(message.msgRandom),
      time: Number(message.msgTime) || Math.floor(Date.now() / 1000),
      self_id: self.uin,
      chat_type: chatType,
      is_group: isGroup,
      peer_uid: text(message.peerUid),
      peer_uin: text(message.peerUin),
      peer_name: text(message.peerName),
      group_id: isGroup ? (Number(message.peerUin || 0) || 0) : 0,
      sender: {
        uin: senderUin,
        uid: text(message.senderUid),
        nick: text(message.sendNickName),
        card: text(message.sendMemberName),
        remark: text(message.sendRemarkName)
      },
      elements: segments,
      raw_message: segments.map(segmentText).join(''),
      send_status: message.sendStatus === undefined ? null : message.sendStatus
    };
    const who = event.sender.card || event.sender.nick || String(senderUin);
    event.display = '[' + (isGroup ? '群 ' + event.group_id : '私聊') + '] ' +
      who + '(' + senderUin + '): ' + event.raw_message;
    return event;
  }

  function cacheEvent(event) {
    if (!event.message_id) return;
    messageCache.delete(event.message_id);
    messageCache.set(event.message_id, event);
    while (messageCache.size > 500) {
      const oldest = messageCache.keys().next().value;
      if (oldest === undefined) break;
      messageCache.delete(oldest);
    }
  }

  function emit(event) {
    lastEventAt = Date.now();
    counters.event++;
    cacheEvent(event);
    sendRaw({ type: 'event', event: event });
    return event;
  }

  function handleIncoming(raw) {
    try {
      // A revoke tip can arrive on this callback instead of the info-list one,
      // depending on whether that chat is open. It is a notice, not a message.
      if (handleRecall(raw)) return;
      // Same for "someone joined / left": its own event, not a blank message.
      if (handleMembershipTip(raw)) return;
      const self = currentSelf();
      // A message echoed from another one of our own devices arrives on
      // onRecvMsg; label it by sender so protocol adapters do not show it as
      // someone else talking to themselves.
      const outgoing = self.uin && Number(raw && raw.senderUin) === Number(self.uin);
      emit(normalizeRaw(raw, outgoing ? 'outgoing' : 'incoming'));
    } catch (e) {
      counters.dropped++;
      appendLog('incoming: ' + (e && e.stack || e));
    }
  }

  function handleOutgoing(raw) {
    try {
      // Our own recall shows up as a gray tip that the kernel also reports as
      // an added message; emit it as the notice, never as an empty message.
      if (handleRecall(raw)) return;
      const event = normalizeRaw(raw, 'outgoing');
      if (!event.message_id) return;
      // Fill the destination the kernel did not report (see sentPeers).
      const dest = event.client_id ? sentPeers.get(event.client_id) : null;
      if (dest) {
        sentPeers.delete(event.client_id);
        event.is_group = dest.is_group;
        event.chat_type = dest.is_group ? 2 : 1;
        if (dest.is_group) {
          event.group_id = Number(dest.peer_uin) || 0;
          if (!Number(event.peer_uin)) event.peer_uin = dest.peer_uin;
        } else if (!Number(event.peer_uin)) {
          event.peer_uin = dest.peer_uin;
        }
        if (!event.peer_name && dest.peer_name) event.peer_name = dest.peer_name;
      }
      // send_message returns as soon as QQ accepts the frame; the kernel
      // callback is what supplies the final msgId. Resolve the pending send
      // before the dedup check so a retry cannot lose the confirmation.
      const pending = event.client_id ? pendingSends.get(event.client_id) : null;
      if (pending) {
        pendingSends.delete(event.client_id);
        clearTimeout(pending.timer);
        pending.resolve({ msgId: event.message_id, msgTime: event.time });
      }
      if (emittedOutgoing.has(event.message_id)) return;
      emittedOutgoing.add(event.message_id);
      while (emittedOutgoing.size > 1000) {
        const oldest = emittedOutgoing.values().next().value;
        if (oldest === undefined) break;
        emittedOutgoing.delete(oldest);
      }
      emit(event);
    } catch (e) {
      counters.dropped++;
      appendLog('outgoing: ' + (e && e.stack || e));
    }
  }

  function handleRecall(msg) {
    try {
      const elements = Array.isArray(msg.elements) ? msg.elements : [];
      const found = elements.find(el => el && el.grayTipElement && el.grayTipElement.revokeElement);
      if (!found) return false;
      const revoke = found.grayTipElement.revokeElement;
      const key = text(msg.chatType) + '/' + text(msg.peerUid) + '/' + text(msg.msgId);
      if (emittedRecall.has(key)) return true;
      emittedRecall.add(key);
      while (emittedRecall.size > 500) {
        const oldest = emittedRecall.values().next().value;
        if (oldest === undefined) break;
        emittedRecall.delete(oldest);
      }
      const cached = messageCache.get(text(msg.msgId)) || null;
      const originalId = text(revoke.origMsgId) || text(revoke.msgId) ||
        (cached && cached.message_id) || text(msg.msgId);
      const chatType = Number(msg.chatType) || 0;
      const isGroup = chatType === 2;
      counters.recall++;
      emit({
        type: 'message_deleted',
        direction: 'notice',
        message_id: originalId,
        recall_msg_id: text(msg.msgId),
        time: Number(msg.msgTime) || Math.floor(Date.now() / 1000),
        self_id: currentSelf().uin,
        chat_type: chatType,
        is_group: isGroup,
        peer_uid: text(msg.peerUid),
        peer_uin: text(msg.peerUin),
        group_id: isGroup ? (Number(msg.peerUin || 0) || 0) : 0,
        operator_uin: text(revoke.operatorUin),
        operator_uid: text(revoke.operatorUid),
        self_operate: !!revoke.isSelfOperate,
        cached: cached
      });
      return true;
    } catch (e) {
      appendLog('recall: ' + (e && e.stack || e));
      return false;
    }
  }

  // "Someone joined / left the group" arrives as a message whose only content is
  // a gray tip. Turning it into its own event keeps frameworks from seeing an
  // empty message, and the uid->uin lookup is async, so the event is emitted as
  // soon as the numbers are known instead of holding up the kernel callback.
  function handleMembershipTip(raw) {
    try {
      if (Number(raw && raw.chatType) !== 2) return false;
      const elements = Array.isArray(raw.elements) ? raw.elements : [];
      const tip = elements.map(el => el && el.grayTipElement).find(t => t && t.groupElement);
      if (!tip) return false;
      const group = tip.groupElement || {};
      const action = MEMBERSHIP_TIP.get(Number(group.type) || 0);
      if (!action) return false;
      const key = text(raw.msgId);
      if (key) {
        if (emittedMembership.has(key)) return true;
        emittedMembership.add(key);
        trimSet(emittedMembership, 500);
      }
      const memberUid = text(group.memberUid);
      const operatorUid = text(group.adminUid);
      const base = {
        type: 'group_member',
        action: action,
        direction: 'notice',
        time: Number(raw.msgTime) || Math.floor(Date.now() / 1000),
        self_id: currentSelf().uin,
        chat_type: 2,
        is_group: true,
        group_id: Number(raw.peerUin || 0) || 0,
        group_name: text(group.groupName),
        user_uid: memberUid,
        user_nick: text(group.memberNick),
        operator_uid: operatorUid,
        operator_nick: text(group.adminNick)
      };
      // emit() owns counters.event, so this path does not touch it
      Promise.all([uinByUid(memberUid), uinByUid(operatorUid)])
        .then(([userUin, operatorUin]) => emit({
          ...base,
          user_uin: userUin || 0,
          operator_uin: operatorUin || 0
        }))
        .catch(() => emit(base));
      return true;
    } catch (e) {
      appendLog('membership tip: ' + (e && e.stack || e));
      return false;
    }
  }

  function ensureListener() {
    const alive = session();
    const service = alive.getMsgService();
    if (!service) throw new Error('getMsgService returned nothing');
    state.msgService = service;
    if (state.listeners.registered) {
      return 'already registered id=' + (state.listeners.msg || '?');
    }

    const listener = feedingListener('msg', {
      onRecvMsg: (msgs) => {
        for (const raw of (Array.isArray(msgs) ? msgs : [msgs])) handleIncoming(raw);
      },
      onAddSendMsg: (msg) => handleOutgoing(msg),
      onMsgInfoListUpdate: (msgs) => {
        const list = Array.isArray(msgs) ? msgs : [msgs];
        for (const msg of list) {
          if (!msg) continue;
          if (handleRecall(msg)) continue;
          // Confirm a send initiated through send_message.
          const id = text(msg.guildId);
          const pending = pendingSends.get(id);
          if (pending && msg.sendStatus !== 1) {
            pendingSends.delete(id);
            clearTimeout(pending.timer);
            pending.resolve(msg);
          }
          if (msg.senderUin && Number(msg.senderUin) === Number(currentSelf().uin)) {
            handleOutgoing(msg);
          }
        }
      },
      onKickedOffLine: (info) => emit({
        type: 'offline', time: Math.floor(Date.now() / 1000),
        self_id: currentSelf().uin, payload: info || {}
      })
    });
    const id = service.addKernelMsgListener(listener);
    state.listeners.object = listener;
    state.listeners.msg = id === undefined || id === null ? '' : String(id);
    state.listeners.registered = true;
    return 'registered id=' + (state.listeners.msg || '?');
  }

  async function getFriends(force) {
    const now = Date.now();
    if (!force && friendsCache && now - friendsAt < 30000) return friendsCache;
    const self = await ensureSelf();
    const alive = session();
    const buddyService = alive.getBuddyService();
    const profileService = alive.getProfileService();
    const result = await buddyService.getBuddyListV2('0', true, 0);
    const uids = [];
    for (const category of ((result && result.data) || [])) {
      for (const uid of (category.buddyUids || [])) {
        if (uid && !uids.includes(uid)) uids.push(uid);
      }
    }
    let profiles = new Map();
    if (uids.length) {
      try {
        const value = profileService.getCoreAndBaseInfo('nodeStore', uids);
        profiles = value && typeof value.then === 'function' ? await value : value;
      } catch (e) {
        appendLog('getCoreAndBaseInfo: ' + (e && e.stack || e));
      }
    }
    const friends = [];
    for (const uid of uids) {
      const profile = profiles && typeof profiles.get === 'function' ? profiles.get(uid) : null;
      const core = (profile && profile.coreInfo) || {};
      const uin = core.uin ? String(core.uin) : '';
      if (!uin) continue;
      if ((self.uin && String(self.uin) === uin) || (self.uid && self.uid === uid)) continue;
      const nick = core.nick || '';
      const remark = core.remark || '';
      friends.push({
        uid: uid, uin: uin, nick: nick, remark: remark,
        display: remark || nick || uin
      });
    }
    friends.sort((a, b) => a.display.localeCompare(b.display, 'zh-CN'));
    friendsCache = friends;
    friendsAt = now;
    return friends;
  }

  function groupService() {
    return session().getGroupService();
  }

  // ---------------------------------------------------------------------------
  // Kernel plumbing.
  //
  // Several NT services do not answer through the call's return value: they
  // resolve through a listener callback (group detail info, shut list, file
  // list, buddy/group requests). NapCat wraps that pattern as
  // callNormalEventV2; this is the same idea kept as small as the bridge needs:
  // register a task against a callback name, call the service, and let the
  // shared listener proxies hand the result to the first waiting checker.
  // ---------------------------------------------------------------------------

  const kernelTasks = new Map();     // 'service.callbackName' -> [{resolve, timer, checker}]

  function waitKernelEvent(key, checker, timeoutMs) {
    let task = null;
    const promise = new Promise((resolve) => {
      task = { checker, resolve, timer: null };
      task.timer = setTimeout(() => {
        dropTask(key, task);
        resolve(null);
      }, timeoutMs || 3000);
      if (!kernelTasks.has(key)) kernelTasks.set(key, []);
      kernelTasks.get(key).push(task);
    });
    // Callers that give up early (a sendMsg error, say) must be able to drop the
    // waiter, otherwise it sits in kernelTasks until its timeout.
    promise.cancel = () => {
      if (!task) return;
      clearTimeout(task.timer);
      dropTask(key, task);
      task.resolve(null);
    };
    return promise;
  }

  function dropTask(key, task) {
    const list = kernelTasks.get(key);
    if (!list) return;
    const index = list.indexOf(task);
    if (index >= 0) list.splice(index, 1);
    if (!list.length) kernelTasks.delete(key);
  }

  function feedKernelTask(key, args) {
    const list = kernelTasks.get(key);
    if (!list || !list.length) return false;
    for (let i = 0; i < list.length; i++) {
      const task = list[i];
      let ok = true;
      try {
        ok = task.checker ? task.checker(args) : true;
      } catch (e) {
        ok = false;
      }
      if (!ok) continue;
      clearTimeout(task.timer);
      list.splice(i, 1);
      if (!list.length) kernelTasks.delete(key);
      task.resolve(args);
      return true;
    }
    return false;
  }

  // A listener that reports every callback into the task table, so one proxy
  // serves both the streaming events and the request/response waits.
  function feedingListener(prefix, handlers) {
    return new Proxy({}, {
      get: (target, prop) => {
        const key = String(prop);
        if (handlers && typeof handlers[key] === 'function') {
          return function () {
            const args = Array.prototype.slice.call(arguments);
            feedKernelTask(prefix + '.' + key, args);
            try {
              handlers[key].apply(null, args);
            } catch (e) {
              appendLog(prefix + '.' + key + ': ' + (e && e.stack || e));
            }
          };
        }
        if (typeof target[key] !== 'undefined') return target[key];
        return function () {
          feedKernelTask(prefix + '.' + key, Array.prototype.slice.call(arguments));
        };
      }
    });
  }

  function getSessionService(name) {
    const value = session();
    if (!value || typeof value[name] !== 'function') {
      throw new Error('session has no ' + name + '()');
    }
    const instance = value[name]();
    if (!instance) throw new Error(name + '() returned nothing');
    return instance;
  }

  function callMethod(instance, method, args) {
    if (typeof instance[method] !== 'function') {
      throw new Error(method + ' is not available on this QQ build');
    }
    const value = instance[method].apply(instance, args || []);
    return value && typeof value.then === 'function' ? value : Promise.resolve(value);
  }

  // One call against one service, with the promise normalised away.
  function nativeCall(serviceName, method, args) {
    return callMethod(getSessionService(serviceName), method, args);
  }

  // Call and wait for the callback NapCat would have subscribed to. `pick`
  // turns the raw callback arguments into the value the action returns.
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Call and wait for the callback NapCat would have subscribed to. `pick`
  // turns the raw callback arguments into the value the action returns.
  //
  // Two rules learned the hard way from the real client: the call promise and
  // the callback are independent (some services never settle the promise when
  // there is nothing to report, so awaiting it first would hang the action),
  // and the first push is often a cold-cache partial record - `enough` keeps
  // waiting for a complete one while remembering what it saw.
  async function nativeCallWithEvent(options) {
    const key = options.listener + '.' + options.callback;
    const partial = [];
    const waiter = waitKernelEvent(key, (args) => {
      if (options.debug) appendLog((options.label || options.method) + ' push ' + dump(args));
      if (options.matches && !options.matches(args)) return false;
      if (options.enough && !options.enough(args)) {
        partial.push(args);
        return false;
      }
      return true;
    }, options.timeoutMs || 3000);

    let value;
    let callError = null;
    let callState = 'pending';
    const call = nativeCall(options.service, options.method, options.args)
      .then((resolved) => {
        value = resolved;
        callState = 'done';
        if (options.debug) appendLog((options.label || options.method) + ' returned ' + dump(resolved));
      })
      .catch((error) => { callError = error; callState = 'error'; });
    // The callback may answer first and the rejection must not surface as an
    // unhandled promise inside QQ's main process.
    call.catch(() => {});

    if (options.awaitCall) {
      try {
        await call;
      } catch (error) {
        // Nobody is waiting any more, and the failure is the service's answer.
        const list = kernelTasks.get(key);
        if (list) {
          for (const task of list.splice(0, list.length)) clearTimeout(task.timer);
          kernelTasks.delete(key);
        }
        throw error;
      }
    }

    let args = await waiter;
    if (!args && partial.length) args = partial[partial.length - 1];
    if (!args && callState === 'pending') {
      // Nothing pushed and the promise is still open: give the call a short
      // extra window before deciding, never an unbounded one.
      await Promise.race([call, delay(options.graceMs || 2000)]);
    }
    if (value && typeof value.result === 'number' && value.result !== 0 && options.fastFail !== false) {
      throw nativeError(value, options.label || options.method);
    }
    if (callState === 'error' && !args) throw callError;
    if (!args) {
      // The call answered but the callback never came; let pick() read whatever
      // the return value carries instead of failing the whole action.
      //
      // Silent is not the same as empty, though: an action that answers `[]`
      // because nothing ever pushed looks exactly like one that answers `[]`
      // because the list really is empty. Say which one it was in the log.
      if (options.allowTimeoutReturn && value) {
        appendLog(`${options.method} answered without ${options.callback}; used the return value`);
        return options.pick ? options.pick(null, value) : value;
      }
      // "Nothing to report" is a legitimate answer for the list-type callbacks.
      if (options.tolerateNoCallback) {
        appendLog(`${options.method} got no ${options.callback} push within ${options.timeoutMs || 3000}ms; returning an empty answer`);
        return options.pick ? options.pick(null, value || null) : null;
      }
      throw new Error((options.label || options.method) + ' timed out waiting for ' + options.callback);
    }
    return options.pick ? options.pick(args, value) : args;
  }

  function nativeError(value, label) {
    const code = value && typeof value.result === 'number' ? value.result : -1;
    const detail = (value && (value.errMsg || value.clientWording || value.retMsg)) || 'failed';
    const error = new Error(label + ': ' + detail + ' (result=' + code + ')');
    error.qqResult = code;
    return error;
  }

  function checkResult(value, label) {
    if (value && typeof value.result === 'number' && value.result !== 0) {
      throw nativeError(value, label);
    }
    return value;
  }

  // The group-space calls wrap their own return code one level down, so
  // result === 0 alone does not mean the operation worked.
  function checkFileResult(value, label) {
    checkResult(value, label);
    const nested = (value && (value.groupFileCommonResult ||
      (value.moveGroupFileResult && value.moveGroupFileResult.result) ||
      (value.transGroupFileResult && value.transGroupFileResult.result) ||
      (value.resultWithGroupItem && value.resultWithGroupItem.result))) || null;
    if (nested && Number(nested.retCode) !== 0) {
      const error = new Error(label + ': ' + (nested.clientWording || nested.retMsg || 'failed') +
        ' (retCode=' + nested.retCode + ')');
      error.qqResult = Number(nested.retCode) || 0;
      throw error;
    }
    return value;
  }

  function mapGet(map, key) {
    if (!map) return '';
    if (typeof map.get === 'function') return map.get(key) || '';
    return map[key] || '';
  }

  function peerOf(chatType, peerUid) {
    return { chatType: Number(chatType) || 0, peerUid: text(peerUid), guildId: '' };
  }

  function groupCodeOf(groupId) {
    const id = text(groupId);
    if (!id) throw new Error('group_id is required');
    return id;
  }

  // ---------------------------------------------------------------------------
  // Request notices.
  //
  // QQ pushes the group-approval list and the friend-request list through the
  // same listeners that answer the matching fetch, so an event has to be
  // raised exactly once per request: the kernel re-sends the whole list every
  // time the screen refreshes. Only unhandled entries are interesting.
  // ---------------------------------------------------------------------------

  const emittedRequests = new Set();   // 'g:<seq>' | 'f:<reqTime>:<uid>'

  // The only GroupNotify types that are really answerable requests. Measured on
  // the real client: 7 = 加群申请 (the one NapCat also filters on), 1 and 5 =
  // 邀请加群, while a 管理员变更 notice arrives with type 8 (user1 = the account
  // promoted, user2 = the actor) - approving that would mean nothing, so it is
  // neither an event nor an option here.
  const REQUEST_NOTIFY_TYPES = new Set([1, 5, 7]);

  function trimSet(set, max) {
    while (set.size > max) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
  }

  function handleGroupNotifies(notifies, doubt) {
    try {
      const list = Array.isArray(notifies) ? notifies : [];
      const fresh = [];
      for (const entry of list) {
        const item = entry && entry.notify || entry;
        // GroupNotifyMsgStatus 1 is "unhandled"; everything else is a state
        // change of a request already reported (or one we handled ourselves).
        if (!item || Number(item.status) !== 1) continue;
        if (!REQUEST_NOTIFY_TYPES.has(Number(item.type) || 0)) continue;
        const key = 'g:' + text(item.seq);
        if (emittedRequests.has(key)) continue;
        emittedRequests.add(key);
        fresh.push(normalizeSysNotify(item));
      }
      if (!fresh.length) return;
      trimSet(emittedRequests, 2000);
      withRequestUserIds(fresh).then((items) => {
        const now = Math.floor(Date.now() / 1000);
        for (const request of items) {
          emit({
            type: 'request', kind: 'group', direction: 'incoming',
            time: now, self_id: currentSelf().uin,
            doubt: !!doubt,
            request_type: classifyRequest(request),
            notify_type: request.type,
            flag: text(request.seq),
            seq: request.seq,
            group_id: request.group_id,
            group_name: request.group_name,
            user_id: request.user_id,
            user_uid: request.user_uid,
            user_nick: request.user_nick,
            actor_uid: request.actor_uid,
            comment: request.comment,
            created_time: request.created_time
          });
        }
      }).catch(error => appendLog('group notifies: ' + (error && error.message || error)));
    } catch (error) {
      appendLog('group notifies: ' + (error && error.message || error));
    }
  }

  function handleBuddyReqChange(source) {
    try {
      const list = (source && Array.isArray(source.buddyReqs)) ? source.buddyReqs : [];
      const fresh = [];
      for (const item of list) {
        if (!item) continue;
        const normalized = normalizeBuddyRequest(item);
        // A request is only worth reporting when the other side started it and
        // nobody has answered it yet.
        if (normalized.agreed || normalized.is_initiator) continue;
        const key = 'f:' + normalized.req_time + ':' + normalized.user_uid;
        if (emittedRequests.has(key)) continue;
        emittedRequests.add(key);
        fresh.push(normalized);
      }
      if (!fresh.length) return;
      trimSet(emittedRequests, 2000);
      withRequestUserIds(fresh).then((items) => {
        const now = Math.floor(Date.now() / 1000);
        for (const request of items) {
          emit({
            type: 'request', kind: 'friend', direction: 'incoming',
            time: now, self_id: currentSelf().uin,
            request_type: 'friend',
            flag: text(request.req_time),
            req_time: request.req_time,
            req_type: request.req_type,
            user_id: request.user_id,
            user_uid: request.user_uid,
            user_nick: request.nick,
            comment: request.comment,
            source_id: request.source_id,
            unread: request.unread,
            doubt: request.doubt,
            created_time: request.created_time
          });
        }
      }).catch(error => appendLog('buddy req: ' + (error && error.message || error)));
    } catch (error) {
      appendLog('buddy req: ' + (error && error.message || error));
    }
  }

  async function ensureGroupListener() {
    if (state.listeners.group) return state.listeners.group;
    const gs = groupService();
    if (!gs || typeof gs.addKernelGroupListener !== 'function') return '';
    const handlers = {
      // Keep the group cache warm: QQ pushes the whole list here, which is also
      // what getGroups waits for.
      onGroupListUpdate: (first, second) => {
        const list = Array.isArray(second) ? second : (Array.isArray(first) ? first : null);
        if (list && list.length) {
          groupsCache = list.map(normalizeGroup).filter(item => item.group_id);
          groupsAt = Date.now();
        }
      },
      // onGroupNotifiesUpdated(doubt, notifies) is the push for new approvals;
      // getSingleScreenNotifies answers on a different callback, so this one is
      // free to turn straight into events.
      onGroupNotifiesUpdated: (doubt, notifies) => handleGroupNotifies(notifies, doubt)
    };
    try {
      const id = gs.addKernelGroupListener(feedingListener('group', handlers));
      state.listeners.group = text(id);
    } catch (e) {
      appendLog('ensureGroupListener: ' + (e && e.message || e));
    }
    return state.listeners.group;
  }

  async function ensureBuddyListener() {
    if (state.listeners.buddy) return state.listeners.buddy;
    let bs = null;
    try {
      bs = getSessionService('getBuddyService');
    } catch (e) {
      return '';
    }
    if (typeof bs.addKernelBuddyListener !== 'function') return '';
    try {
      const id = bs.addKernelBuddyListener(feedingListener('buddy', {
        onBuddyReqChange: (source) => handleBuddyReqChange(source)
      }));
      state.listeners.buddy = text(id);
    } catch (e) {
      appendLog('ensureBuddyListener: ' + (e && e.message || e));
    }
    return state.listeners.buddy;
  }

  // uin -> uid. NapCat tries the uix converter, then the profile service, then
  // the group service, then a detail lookup. The caches are checked first here
  // because they are free and already warm.
  async function uidByUin(uin, groupCode) {
    const id = text(uin);
    if (!id) return '';
    if (!/^\d+$/.test(id)) return id;                       // already a uid
    const self = currentSelf();
    if (self.uin && String(self.uin) === id && self.uid) return self.uid;
    const friend = (friendsCache || []).find(item => text(item.uin) === id);
    if (friend && friend.uid) return friend.uid;
    if (groupCode) {
      try {
        const members = await getGroupMembers(groupCode, false);
        const hit = members.find(item => text(item.uin) === id);
        if (hit && hit.uid) return hit.uid;
      } catch (e) { /* fall through */ }
    }
    try {
      const data = await nativeCall('getUixConvertService', 'getUid', [[id]]);
      const got = mapGet(data && data.uidInfo, id);
      if (got && !text(got).includes('*')) return text(got);
    } catch (e) { /* not on this build */ }
    try {
      const data = await nativeCall('getGroupService', 'getUidByUins', [[id]]);
      const got = mapGet(data && data.uids, id);
      if (got && !text(got).includes('*')) return text(got);
    } catch (e) { /* keep going */ }
    try {
      const data = await nativeCall('getProfileService', 'getUidByUin', ['FriendsServiceImpl', [id]]);
      const got = mapGet(data, id);
      if (got && !text(got).includes('*')) return text(got);
    } catch (e) { /* keep going */ }
    if (groupCode) {
      try {
        const members = await getGroupMembers(groupCode, true);
        const hit = members.find(item => text(item.uin) === id);
        if (hit && hit.uid) return hit.uid;
      } catch (e) { /* give up */ }
    }
    return '';
  }

  async function memberUidForGroup(groupCode, uinOrUid) {
    const uid = await uidByUin(uinOrUid, groupCode);
    if (!uid) throw new Error('cannot resolve member ' + uinOrUid + ' in group ' + groupCode);
    return uid;
  }

  async function qunPskey(groupCode) {
    const data = await nativeCall('getTipOffService', 'getPskey', [['qun.qq.com'], true]);
    const pskey = text(mapGet(data && data.domainPskeyMap, 'qun.qq.com'));
    if (!pskey) throw new Error('getPskey returned no qun.qq.com key');
    return pskey;
  }

  // Only paths that exist on this machine reach the kernel: several of these
  // services read a file directly instead of taking a buffer.
  function requireLocalFile(value, label) {
    const raw = text(value);
    if (!raw) throw new Error(label + ' is required');
    if (/^(https?:|base64:|data:)/i.test(raw)) {
      throw new Error(label + ' must be a path on this machine; ' +
        'this endpoint neither downloads nor uploads media');
    }
    const full = path.resolve(raw);
    if (!fs.existsSync(full)) throw new Error(label + ' does not exist: ' + full);
    return full;
  }

  // GroupNotify list, with the QQ numbers filled in where they can be found.
  async function fetchSingleScreenNotifies(doubt, count, keepRaw) {
    await ensureGroupListener();
    const value = await nativeCallWithEvent({
      service: 'getGroupService',
      method: 'getSingleScreenNotifies',
      args: [doubt, '', count],
      listener: 'group',
      callback: 'onGroupSingleScreenNotifies',
      label: 'getSingleScreenNotifies',
      timeoutMs: 8000,
      allowTimeoutReturn: true,
      // An admin with no pending applications gets no push at all.
      tolerateNoCallback: true,
      // onGroupSingleScreenNotifies(doubt, seq, notifies): take whichever
      // argument actually holds the list.
      matches: (args) => !!((args || []).find(Array.isArray) ||
        (args || []).find(item => item && item.notifies)),
      pick: (args, returned) => {
        const list = (args || []).find(Array.isArray) ||
          ((args || []).find(item => item && Array.isArray(item.notifies)) || {}).notifies ||
          (returned && (returned.notifies || returned.notifyList)) || [];
        return (Array.isArray(list) ? list : []).map(item =>
          Object.assign(normalizeSysNotify(item && item.notify || item),
            keepRaw ? { raw: item } : {}));
      }
    });
    return withRequestUserIds(value);
  }

  // Reverse-map the uids a request carries; getUinByUids takes the whole batch.
  async function withRequestUserIds(list) {
    const uids = [];
    for (const item of list) {
      if (item.user_uid && !/^\d+$/.test(item.user_uid)) uids.push(item.user_uid);
      if (item.actor_uid && !/^\d+$/.test(item.actor_uid)) uids.push(item.actor_uid);
    }
    let map = null;
    if (uids.length) {
      try {
        const data = await nativeCall('getGroupService', 'getUinByUids', [uids]);
        map = data && data.uins;
      } catch (e) {
        appendLog('getUinByUids: ' + (e && e.message || e));
      }
    }
    for (const item of list) {
      item.user_id = item.user_uid && /^\d+$/.test(item.user_uid) ? Number(item.user_uid) : 0;
      item.actor_uin = 0;
      if (map) {
        item.user_id = Number(mapGet(map, item.user_uid)) || item.user_id;
        item.actor_uin = Number(mapGet(map, item.actor_uid)) || 0;
      } else if (item.user_uid && !item.user_id) {
        // The batch reverse map is not available on this build; the friend
        // cache is the only place left that knows this uid.
        item.user_id = await uinByUid(item.user_uid);
      }
      // OneBot's flag is the seq for a group request and the reqTime for a
      // friend request; clients echo it back untouched.
      item.flag = text(item.seq || item.req_time);
    }
    return list;
  }

  async function withUserIds(list) {
    return await withRequestUserIds(list);
  }

  // GroupNotifyMsgType, as the kernel numbers it: 1 and 5 are invitations
  // someone sent, 7 is a person asking to join.
  function classifyRequest(item) {
    const type = Number(item.type) || 0;
    if (type === 1 || type === 5) return 'invite';
    if (type === 7) return 'inspect';
    return 'group';
  }

  // onGroupDetailInfoChange pushes one GroupDetailInfo; a few builds push a
  // list or nest it under groupInfo, so accept every shape and pick ours.
  function findDetailInfo(args, code) {
    for (const item of (args || [])) {
      if (!item || typeof item !== 'object') continue;
      if (Array.isArray(item)) {
        const hit = item.find(entry => entry && text(entry.groupCode ||
          (entry.groupInfo || {}).groupCode) === code);
        if (hit) return hit.groupInfo || hit;
        continue;
      }
      const got = text(item.groupCode || (item.groupInfo || {}).groupCode);
      if (!code || got === code) return item.groupInfo || item;
    }
    return null;
  }

  function normalizeNoticeFeed(feed, fromInst) {
    const msg = feed && feed.msg || {};
    const texts = (msg.text || []).map(item => text(item));
    return {
      notice_id: text(feed.u || feed.fid),
      group_id: Number(feed.groupCode || 0) || 0,
      sender_id: Number(feed.publishUin || 0) || 0,
      sender_uid: text(feed.publishUid),
      title: texts[0] || '',
      content: texts.join('\n'),
      time: Number(feed.pubt || feed.publishTime || 0) || 0,
      pinned: !!(feed.settings && feed.settings.is_pinned),
      // "发给新成员" 的公告只出现在 inst 里，读出来要能分辨是哪一类。
      send_to_new_member: !!fromInst,
      image: ((msg.pics || [])[0] || {}).url || ''
    };
  }

  // GroupNotify, as the kernel reports it: user1 is the person the request is
  // about (the applicant), user2 the actor. Both are uids; QQ numbers have to
  // be reverse-mapped, which the uin cache and getUinByUids can do.
  function normalizeSysNotify(notify) {
    const group = notify && notify.group || {};
    const user1 = notify && notify.user1 || {};
    const user2 = notify && notify.user2 || {};
    const status = Number(notify && notify.status || 0) || 0;
    return {
      request_id: text(notify && notify.seq),
      seq: text(notify && notify.seq),
      type: Number(notify && notify.type || 0) || 0,
      // GroupNotifyMsgStatus: 1 = unhandled; anything else is already decided.
      status: status,
      group_id: Number(group.groupCode || 0) || 0,
      group_name: text(group.groupName),
      user_uid: text(user1.uid),
      user_nick: text(user1.nickName),
      actor_uid: text(user2.uid),
      actor_nick: text(user2.nickName),
      comment: text(notify && notify.postscript),
      created_time: Number(notify && notify.actionTime || 0) || 0,
      checked: status !== 1
    };
  }

  // FriendRequest, from FriendRequestNotify.buddyReqs. flag is reqTime.
  function normalizeBuddyRequest(request) {
    const reqType = Number(request && request.reqType || 0) || 0;
    return {
      request_id: text(request && request.reqTime),
      req_time: text(request && request.reqTime),
      user_uid: text(request && request.friendUid),
      // BuddyReqType: 1 = someone else asked to add us; the rest are our own
      // outbound requests or their confirmations.
      req_type: reqType,
      // Newer builds say it directly; reqType 1 (KPEERINITIATOR) is the older
      // way to tell an incoming request from one we sent.
      is_initiator: request && request.isInitiator !== undefined ?
        !!request.isInitiator : reqType !== 1,
      comment: text(request && request.extWords),
      nick: text(request && request.friendNick),
      source_id: Number(request && request.sourceId || 0) || 0,
      group_id: Number(request && request.groupCode || 0) || 0,
      unread: !!(request && request.isUnread),
      doubt: !!(request && request.isDoubt),
      agreed: !!(request && request.isAgreed),
      created_time: Number((request && request.reqTime) || 0) || 0
    };
  }

  // uid -> uin for a single record, used when the batch reverse map is missing:
  // the friend cache is free, so it is tried before the kernel call.
  async function uinByUid(uid) {
    const id = text(uid);
    if (!id) return 0;
    if (/^\d+$/.test(id)) return Number(id) || 0;
    const friend = (friendsCache || []).find(item => text(item.uid) === id);
    if (friend) return Number(friend.uin) || 0;
    try {
      const data = await nativeCall('getGroupService', 'getUinByUids', [[id]]);
      return Number(mapGet(data && data.uins, id)) || 0;
    } catch (e) {
      return 0;
    }
  }

  function normalizeGroupFileItem(item) {
    const info = (item && item.fileInfo) || null;
    const folder = (item && item.folderInfo) || null;
    if (folder) {
      return {
        kind: 'folder',
        folder_id: text(folder.folderId),
        folder_name: text(folder.folderName),
        create_time: Number(folder.createTime || 0) || 0,
        creator: Number(folder.createUin || 0) || 0,
        total_file_count: Number(folder.totalFileCount || 0) || 0
      };
    }
    return {
      kind: 'file',
      group_id: Number(item && item.peerId || 0) || 0,
      file_id: text(info && info.fileId),
      file_name: text(info && info.fileName),
      busid: Number(info && info.busId || 0) || 0,
      file_size: Number(info && info.fileSize || 0) || 0,
      upload_time: Number(info && info.uploadTime || 0) || 0,
      dead_time: Number(info && info.deadTime || 0) || 0,
      modify_time: Number(info && info.modifyTime || 0) || 0,
      download_times: Number(info && info.downloadTimes || 0) || 0,
      uploader: Number(info && info.uploaderUin || 0) || 0,
      uploader_name: text(info && info.uploaderName),
      parent_folder_id: text(info && info.parentFolderId)
    };
  }

  function normalizeGroup(group) {
    const owner = group.groupOwnerId || {};
    return {
      group_id: Number(group.groupCode || group.groupId || 0) || 0,
      group_code: text(group.groupCode || group.groupId),
      name: text(group.groupName || group.name),
      remark: text(group.remarkName),
      member_count: Number(group.memberCount || group.memberNum || 0) || 0,
      max_member_count: Number(group.maxMemberCount || group.maxMember || group.maxMemberNum || 0) || 0,
      // The Group record keeps its owner inside groupOwnerId; older shapes used
      // a flat ownerUin.
      owner_uin: Number(group.ownerUin || owner.memberUin || 0) || 0,
      owner_uid: text(group.ownerUid || owner.memberUid),
      self_role: group.memberRole === undefined ? null : group.memberRole,
      is_top: !!group.isTop,
      credit_level: Number(group.groupCreditLevel || 0) || 0,
      status: group.groupStatus === undefined ? null : group.groupStatus
    };
  }

  async function getGroups(force) {
    const now = Date.now();
    if (!force && groupsCache && now - groupsAt < 30000) return groupsCache;
    const gs = groupService();
    if (!gs) throw new Error('getGroupService returned nothing');
    await ensureGroupListener();

    // QQ answers getGroupList through onGroupListUpdate(updateType, groupList),
    // and some builds put the list in the first argument. Some also carry it in
    // the call result, so both routes race and either one is enough - this is
    // the same shape NapCat's group-list wrapper accepts.
    const fromCallback = waitKernelEvent('group.onGroupListUpdate', (args) => {
      const [first, second] = args || [];
      return Array.isArray(second) || Array.isArray(first);
    }, 5000).then((args) => {
      if (!args) return null;
      const [first, second] = args;
      return Array.isArray(second) ? second : (Array.isArray(first) ? first : null);
    });
    let fromReturn = Promise.resolve(null);
    try {
      const value = gs.getGroupList(false);
      fromReturn = Promise.resolve(value).then((result) => {
        if (Array.isArray(result)) return result;
        if (Array.isArray(result && result.groupList)) return result.groupList;
        if (Array.isArray(result && result.groups)) return result.groups;
        return null;
      }).catch(() => null);
    } catch (e) {
      appendLog('getGroupList: ' + (e && e.message || e));
    }

    let list = await Promise.race([fromCallback, fromReturn]);
    if (!list || !list.length) {
      list = (await fromCallback) || (await fromReturn) || groupsCache || [];
    }

    groupsCache = list.map(normalizeGroup).filter(item => item.group_id);
    groupsAt = now;
    return groupsCache;
  }

  async function getGroupMembers(groupId, force) {
    const id = text(groupId);
    if (!id) throw new Error('group_id is required');
    const cached = memberCache.get(id);
    if (!force && cached && Date.now() - cached.at < 30000) return cached.members;
    const gs = groupService();
    if (!gs) throw new Error('getGroupService returned nothing');
    let result = null;
    if (typeof gs.getAllMemberList === 'function') {
      // `false` can return an empty Map while the cache is cold; QQ fills it
      // when the call is forced. This is the same path NapCat uses.
      result = gs.getAllMemberList(id, true);
    } else {
      throw new Error('no group member API on this QQ build');
    }
    if (result && typeof result.then === 'function') result = await result;
    let infos = (result && result.result && result.result.infos) ||
      (result && result.infos) || (result && result.memberList) || [];
    // Realm-safe: kernel Maps do not answer to `instanceof Map` when the object
    // crosses a context boundary, but they always carry values().
    if (infos && typeof infos.values === 'function') infos = Array.from(infos.values());
    else if (!Array.isArray(infos)) infos = Object.values(infos || {});
    const members = infos.map(member => ({
      uid: text(member.uid),
      uin: Number(member.uin || 0) || 0,
      nick: text(member.nick),
      card: text(member.cardName || member.card),
      remark: text(member.remark),
      // GroupMember.role is the field the kernel type uses; memberRole is the
      // name older builds carried.
      role: member.role !== undefined ? member.role :
        (member.memberRole === undefined ? null : member.memberRole),
      join_time: Number(member.joinTime || 0) || 0,
      last_sent_time: Number(member.lastSpeakTime || 0) || 0,
      special_title: text(member.memberSpecialTitle),
      title_expire_time: Number(member.specialTitleExpireTime || 0) || 0,
      // Remaining mute seconds; 0 means the member is not muted.
      shut_up_time: Number(member.shutUpTime || 0) || 0,
      is_robot: !!member.isRobot,
      level: Number(member.memberRealLevel || member.memberLevel || 0) || 0
    }));
    memberCache.set(id, { at: Date.now(), members: members });
    return members;
  }

  async function getUser(params) {
    const uid = text(params.uid);
    const uin = Number(params.uin || 0) || 0;
    if (uid) {
      try {
        const profileService = session().getProfileService();
        const value = profileService.getCoreAndBaseInfo('nodeStore', [uid]);
        const profiles = value && typeof value.then === 'function' ? await value : value;
        const profile = profiles && typeof profiles.get === 'function' ? profiles.get(uid) : null;
        const core = (profile && profile.coreInfo) || {};
        if (core.uin) {
          return {
            uid: core.uid || uid, uin: Number(core.uin) || 0,
            nick: core.nick || '', remark: core.remark || ''
          };
        }
      } catch (e) { /* fall through to the caches */ }
    }
    const friends = friendsCache || [];
    const friend = friends.find(f => (uid && f.uid === uid) || (uin && Number(f.uin) === uin));
    if (friend) return { uid: friend.uid, uin: Number(friend.uin) || 0, nick: friend.nick, remark: friend.remark };
    return null;
  }

  // -- media staging ---------------------------------------------------------
  //
  // How an image gets sent on this client, established by watching a real QQ
  // send (scripts/capture_send_shape.js) and reproducing it (round 3 of
  // scripts/probe_send_group_image.js): the kernel wants the file inside the
  // account's own media tree named by its md5, plus a picElement whose
  // `fileName` is that same `<md5><ext>`. An empty `thumbPath` Map still sends
  // fine, so thumbnails are the client's display concern and not part of the
  // upload - which means no image decoding beyond size sniffing is needed here.
  //
  // Two failures along the way are worth keeping in mind, because both looked
  // like a shape problem and neither was: a wrong `fileName` (the original name
  // instead of the md5 name) and, worse, a private peer this account cannot open
  // at all (not a friend, temporary sessions closed) - that one answers
  // `fileErrCode 2006003` with `fileSrvErrCode 0`, i.e. the server never saw it.
  function imageInfoOf(file) {
    const buf = fs.readFileSync(file);
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    let width = 0;
    let height = 0;
    const isPng = buf.length > 24 && buf.slice(1, 4).toString('ascii') === 'PNG';
    if (isPng) {
      width = buf.readUInt32BE(16);
      height = buf.readUInt32BE(20);
    } else if (buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) break;
        const marker = buf[off + 1];
        const len = buf.readUInt16BE(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf &&
            marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          height = buf.readUInt16BE(off + 5);
          width = buf.readUInt16BE(off + 7);
          break;
        }
        off += 2 + len;
      }
    }
    let ext = path.extname(file).toLowerCase();
    if (!ext) ext = isPng ? '.png' : '.jpg';
    return { md5: md5, size: buf.length, width: width, height: height, ext: ext };
  }

  function picOriDir() {
    // getPicTmpPath() answers four directories - Emoji Ori/Thumb then Pic
    // Ori/Thumb - each shaped <...>\nt_data\Pic\<yyyy-mm>\OriTemp, so the tree
    // root is two levels above the Pic temp dir.
    const dirs = session().getRichMediaService().getPicTmpPath() || [];
    const picTemp = dirs
      .map((d) => text(d))
      .find((d) => /[\\/](Pic|pic)[\\/]/.test(d)) || text(dirs[2]);
    if (!picTemp) throw new Error('no Pic directory in getPicTmpPath');
    // The client names its month folders in local time, so do the same; an
    // ISO/UTC month would file pictures into the wrong folder around midnight
    // on the first of a month.
    const now = new Date();
    const month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    return path.join(path.dirname(path.dirname(picTemp)), month, 'Ori');
  }

  // -- finding a picture the client already has -------------------------------
  //
  // The receive side needs no kernel call: the client stores originals as
  // `<nt_data>/Pic/<yyyy-mm>/Ori/<md5><ext>` and thumbnails as
  // `<md5>_<n><ext>` in the sibling Thumb dir (verified against the real tree:
  // every file name is the md5 of its bytes). So a received picture can be
  // handed to a bot as a path as long as the client downloaded it - and the
  // thumbnail when only that came down. What we cannot do yet is force a
  // download for a picture the client never fetched (that needs a received
  // fileUuid to probe `downloadFileForFileUuid` with).
  let picRootCache = '';
  function picRootDir() {
    if (picRootCache) return picRootCache;
    try {
      const dirs = session().getRichMediaService().getPicTmpPath() || [];
      const picTemp = (dirs || []).map((d) => text(d))
        .find((d) => /[\\/](Pic|pic)[\\/]/.test(d));
      if (picTemp) picRootCache = path.dirname(path.dirname(path.resolve(picTemp)));
    } catch (e) { /* no client tree */ }
    return picRootCache;
  }

  function listDir(dir) {
    try { return fs.readdirSync(dir) || []; } catch (e) { return []; }
  }

  function existingFile(candidates) {
    for (const candidate of candidates || []) {
      const value = text(candidate);
      if (value && fs.existsSync(value)) return { path: value, thumb: false };
    }
    return null;
  }

  function resolvePicPath(md5Hex, fileName) {
    const md5 = text(md5Hex).toLowerCase();
    const root = picRootDir();
    if (!md5 || !root) return null;
    const months = listDir(root)
      .filter((name) => /^\d{4}-\d{2}$/.test(name))
      .sort().reverse().slice(0, 6);
    const named = (name) => name.toLowerCase().startsWith(md5);
    for (const month of months) {
      const dir = path.join(root, month, 'Ori');
      const hit = listDir(dir).find((name) => named(name) && name.indexOf('.') > 0);
      if (hit) return { path: path.join(dir, hit), thumb: false };
    }
    for (const month of months) {
      const dir = path.join(root, month, 'Thumb');
      const hit = listDir(dir).find(named);
      if (hit) return { path: path.join(dir, hit), thumb: true };
    }
    return null;
  }

  // The client sometimes fills a path of its own into the element; thumbPath is
  // a Map of size -> path, and its values are just as good.
  function elementPicPaths(pic) {
    const out = [text(pic && pic.sourcePath), text(pic && pic.filePath)];
    try {
      const thumbs = pic && pic.thumbPath;
      if (thumbs && typeof thumbs.forEach === 'function') {
        thumbs.forEach((value) => out.push(text(value)));
      }
    } catch (e) { /* ignore */ }
    return out.filter(Boolean);
  }

  // `track` is called only when this send actually copied the bytes into the
  // client tree. A file that was already there belongs to the client (or to a
  // received message) and must survive the send, so it is not tracked.
  function stagePic(file, track) {
    const info = imageInfoOf(file);
    const dir = picOriDir();
    const staged = path.join(dir, info.md5 + info.ext);
    if (!fs.existsSync(staged)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(file, staged);
      } catch (error) {
        throw new Error('cannot stage the image into the client media directory: ' +
          (error && error.message || error));
      }
      if (track) track(staged);
    }
    return { file: staged, md5: info.md5, size: info.size, width: info.width,
      height: info.height, ext: info.ext };
  }

  // Undo what the staging did, once the kernel is done reading the bytes.
  // Best effort only: a copy that cannot be removed is litter, not an error
  // worth failing a send that already succeeded.
  //
  // Windows keeps a handle on the staged file for a moment after the upload
  // report (`rmSync` says EPERM, verified live), so retry briefly before
  // giving up. Each round is 2s; the file is normally removable by round 1-2.
  function releaseStaged(files, attempt) {
    const round = attempt || 0;
    const retry = [];
    for (const file of files) {
      try {
        fs.rmSync(file, { force: true });
      } catch (error) {
        if (round < 10) {
          retry.push(file);
        } else {
          appendLog('staged cleanup failed for ' + file + ': ' +
            (error && error.message || error));
        }
      }
    }
    if (retry.length) {
      setTimeout(() => releaseStaged(retry, round + 1), 2000);
    }
  }

  // -- windows ---------------------------------------------------------------
  //
  // QQ is an Electron app, so its UI can be put away without touching the
  // kernel: hide the BrowserWindows and leave the Tray alone. `quiet` also
  // hides windows created later (chat/notification popups), stops taskbar
  // flashes and tray balloons, stubs main-process Notification toasts and web
  // Notifications in each page, and mutes the renderers. `show` leaves quiet
  // mode and brings the main panel back.
  //
  // The state and hooks live on globalThis because re-injecting the bridge
  // must not leave an old generation's listener hiding windows behind the new
  // one's back.
  const windowState = state.window ||
    (state.window = {
      quiet: false, created: null, patched: null, muted: new Set(), mute: true
    });

  function electronApi() {
    try {
      const e = req('electron');
      return e && e.BrowserWindow ? e : null;
    } catch (e) {
      return null;
    }
  }

  function windowUrl(win) {
    try { return String(win.webContents.getURL() || ''); } catch (e) { return ''; }
  }

  function windowInfo(win) {
    return {
      id: win.id,
      title: (() => { try { return win.getTitle(); } catch (e) { return ''; } })(),
      url: windowUrl(win).slice(0, 240),
      visible: (() => { try { return win.isVisible(); } catch (e) { return false; } })(),
      muted: (() => { try { return win.webContents.isAudioMuted(); } catch (e) { return false; } })(),
      bounds: (() => { try { return win.getBounds(); } catch (e) { return null; } })()
    };
  }

  function windowsNow() {
    const e = electronApi();
    if (!e) throw new Error('electron is not reachable from this process');
    return e.BrowserWindow.getAllWindows();
  }

  // The login flow is the one window that must stay visible: hiding it would
  // leave no way to scan a QR code after a restart.
  function isLoginWindow(win) {
    const url = windowUrl(win);
    if (/login|qrcode|扫码/i.test(url)) return true;
    try { return /登录/.test(win.getTitle()); } catch (e) { return false; }
  }

  function quietWindow(win, mute) {
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
    if (isLoginWindow(win)) return;
    try {
      if (!win.__qqhookShowHooked) {
        win.__qqhookShowHooked = true;
        win.on('show', () => {
          if (!windowState.quiet) return;
          try { win.hide(); } catch (e) { /* ignore */ }
        });
      }
      win.hide();
      if (mute) {
        try {
          if (!win.webContents.isAudioMuted()) {
            win.webContents.setAudioMuted(true);
            windowState.muted.add(win.id);
          }
        } catch (e) { /* ignore */ }
      }
    } catch (e) {
      appendLog('quiet window ' + (win.id || '?') + ': ' + (e && e.message || e));
    }
  }

  function patchElectron(e) {
    if (windowState.patched) return;
    windowState.patched = {};
    try {
      const flash = e.BrowserWindow.prototype.flashFrame;
      windowState.patched.flashFrame = flash;
      e.BrowserWindow.prototype.flashFrame = function () {
        if (!windowState.quiet) return flash.apply(this, arguments);
      };
    } catch (e) { /* ignore */ }
    try {
      if (e.Tray && e.Tray.prototype && typeof e.Tray.prototype.displayBalloon === 'function') {
        const balloon = e.Tray.prototype.displayBalloon;
        windowState.patched.balloon = balloon;
        e.Tray.prototype.displayBalloon = function () {
          if (!windowState.quiet) return balloon.apply(this, arguments);
        };
      }
    } catch (e) { /* ignore */ }
    try {
      if (e.Notification && e.Notification.prototype &&
          typeof e.Notification.prototype.show === 'function') {
        const show = e.Notification.prototype.show;
        windowState.patched.notification = show;
        e.Notification.prototype.show = function () {
          if (windowState.quiet) {
            try { this.close(); } catch (e2) { /* ignore */ }
            return;
          }
          return show.apply(this, arguments);
        };
      }
    } catch (e) { /* ignore */ }
  }

  // Renderer-side Notifications are per-page objects, so each page gets a
  // wrapper that consults a flag. The flag flips without reloading the page.
  function quietPage(win, on) {
    try {
      const flag = on ? 'true' : 'false';
      const code = '(function(){' +
        'if (' + flag + ' && window.Notification && !window.__qqhookQuietNotification){' +
        'var Orig=window.Notification;' +
        'function QuietNotification(title,options){' +
        'if(window.__qqhookQuietMode){' +
        'return {close:function(){},addEventListener:function(){},removeEventListener:function(){},' +
        'dispatchEvent:function(){return false;}};' +
        '}' +
        'return new Orig(title,options);' +
        '}' +
        'QuietNotification.permission=Orig.permission;' +
        'QuietNotification.requestPermission=Orig.requestPermission?Orig.requestPermission.bind(Orig):undefined;' +
        'window.Notification=QuietNotification;' +
        'window.__qqhookQuietNotification=true;' +
        '}' +
        'window.__qqhookQuietMode=' + flag + ';' +
        '})()';
      win.webContents.executeJavaScript(code).catch(() => {});
    } catch (e) { /* ignore */ }
  }

  function hookNewWindows(e) {
    if (windowState.created) return;
    windowState.created = (event, win) => {
      if (!windowState.quiet) return;
      appendLog('quiet: window ' + win.id + ' ' + windowUrl(win).slice(0, 160));
      quietWindow(win, windowState.mute);
      try {
        win.webContents.once('did-finish-load', () => {
          if (windowState.quiet) quietPage(win, true);
        });
      } catch (e) { /* ignore */ }
    };
    e.app.on('browser-window-created', windowState.created);
  }

  function enterQuiet(params) {
    const e = electronApi();
    if (!e) throw new Error('electron is not reachable from this process');
    windowState.quiet = true;
    windowState.mute = params.mute !== false;
    patchElectron(e);
    hookNewWindows(e);
    for (const win of e.BrowserWindow.getAllWindows()) {
      quietPage(win, true);
      quietWindow(win, windowState.mute);
    }
  }

  function leaveQuiet() {
    windowState.quiet = false;
    const e = electronApi();
    if (!e) return;
    for (const win of e.BrowserWindow.getAllWindows()) {
      quietPage(win, false);
      if (windowState.muted.has(win.id)) {
        try { win.webContents.setAudioMuted(false); } catch (err) { /* ignore */ }
      }
    }
    windowState.muted.clear();
  }

  function mainWindow() {
    const list = windowsNow();
    const byUrl = list.find((win) => /#\/main/.test(windowUrl(win)));
    if (byUrl) return byUrl;
    const visible = list.find((win) => { try { return win.isVisible(); } catch (e) { return false; } });
    if (visible) return visible;
    return list.sort((a, b) => {
      const ba = (() => { try { return a.getBounds(); } catch (e) { return { width: 0, height: 0 }; } })();
      const bb = (() => { try { return b.getBounds(); } catch (e) { return { width: 0, height: 0 }; } })();
      return bb.width * bb.height - ba.width * ba.height;
    })[0] || null;
  }

  function showMainWindow() {
    const win = mainWindow();
    if (!win) return null;
    try {
      if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();
    } catch (e) { /* ignore */ }
    win.show();
    try { win.focus(); } catch (e) { /* ignore */ }
    return win;
  }

  // -- tray icon -------------------------------------------------------------
  //
  // Electron keeps Tray instances in native code and exposes no getAll(); a
  // bridge injected after startup cannot ask for QQ's Tray. So the prototype is
  // wrapped once: the next time QQ updates the icon or tooltip, `this` is the
  // real instance, and it is kept on globalThis for later calls. While a custom
  // icon is set, QQ's own setImage calls are swallowed so the icon does not
  // flip back on the next unread count; `reset` puts the last QQ image back.
  const trayState = state.tray ||
    (state.tray = {
      ref: null, patched: false, hits: [], lastImage: null, lastTooltip: '',
      custom: null, customTooltip: false, bypass: false
    });

  function installTrayHook() {
    if (bridgeHeadless) return 'headless';
    const e = electronApi();
    if (!e || !e.Tray || !e.Tray.prototype) return false;
    if (trayState.patched) return true;
    const proto = e.Tray.prototype;
    const wrap = (name, run) => {
      const orig = proto[name];
      if (typeof orig !== 'function') return;
      proto[name] = function () {
        trayState.ref = this;
        try {
          trayState.hits.push({ name: name, at: Date.now() });
          if (trayState.hits.length > 20) trayState.hits.shift();
        } catch (e2) { /* ignore */ }
        return run
          ? run.call(this, orig, arguments)
          : orig.apply(this, arguments);
      };
    };
    wrap('setImage', function (orig, args) {
      if (trayState.custom && !trayState.bypass) return;
      if (!trayState.custom && args[0]) trayState.lastImage = args[0];
      return orig.apply(this, args);
    });
    wrap('setToolTip', function (orig, args) {
      if (trayState.customTooltip && !trayState.bypass) return;
      if (args[0] !== undefined && args[0] !== null) trayState.lastTooltip = String(args[0]);
      return orig.apply(this, args);
    });
    wrap('setTitle');
    wrap('setPressedImage');
    wrap('setContextMenu');
    trayState.patched = true;
    return true;
  }

  function trayStatus() {
    const ref = trayState.ref;
    return {
      captured: !!ref,
      bounds: ref ? (() => { try { return ref.getBounds(); } catch (e) { return null; } })() : null,
      title: ref ? (() => { try { return ref.getTitle(); } catch (e) { return null; } })() : null,
      custom: trayState.custom,
      hasLastImage: !!trayState.lastImage,
      lastTooltip: trayState.lastTooltip,
      hits: trayState.hits.slice(-5)
    };
  }

  // Field-for-field the shape the client submits, including the nulls for the
  // features a plain picture does not carry (meme faces, flash pics, rich-media
  // import context) - leaving those keys out is what made earlier guesses fail.
  function buildPicElement(staged) {
    return {
      elementType: 2,
      elementId: '',
      elementGroupId: 0,
      picElement: {
        picSubType: 0,
        picSubSubType: null,
        fileName: text(staged.md5 + staged.ext),
        fileSize: text(staged.size),
        picWidth: staged.width,
        picHeight: staged.height,
        original: true,
        md5HexStr: staged.md5,
        sourcePath: staged.file,
        thumbPath: new Map(),
        transferStatus: 0,
        progress: 0,
        picType: 1000,
        invalidState: 0,
        fileUuid: '',
        fileSubId: '',
        thumbFileSize: 0,
        fileBizId: null,
        downloadIndex: null,
        summary: '',
        emojiFrom: null,
        emojiWebUrl: null,
        emojiAd: { url: '', desc: '' },
        emojiMall: { packageId: 0, emojiId: 0 },
        emojiZplan: { actionId: 0, actionName: '', actionType: 0, playerNumber: 0,
          peerUid: '0', bytesReserveInfo: '' },
        originImageMd5: '',
        originImageUrl: null,
        import_rich_media_context: null,
        isFlashPic: null,
        storeID: 0
      }
    };
  }

  // -- files -----------------------------------------------------------------
  //
  // Same trick as pictures, with a much smaller element: the client wants the
  // file inside its own media tree and a fileElement pointing at that path.
  // `getRichMediaFilePathForGuild({md5HexStr, fileName, elementType: 3, ...})`
  // answers `<nt_data>/File/Ori/<md5><ext>` (no month folder, unlike Pic).
  // Verified live on 2026-10-27 against group 20000001: sendMsg result 0,
  // onRichMediaUploadComplete `fileErrCode 0` with a fileId, and
  // onGroupFileInfoAdd shows the file in the group's file list. No highway.
  function fileInfoOf(file, name) {
    const buf = fs.readFileSync(file);
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    let fileName = text(name) || path.basename(file);
    if (fileName.indexOf('.') === -1) fileName += path.extname(file).toLowerCase();
    return { md5: md5, size: buf.length, fileName: fileName };
  }

  function stageFile(info) {
    const value = session().getMsgService().getRichMediaFilePathForGuild({
      md5HexStr: info.md5,
      fileName: info.fileName,
      elementType: 3,
      elementSubType: 0,
      thumbSize: 0,
      needCreate: true,
      downloadType: 1,
      file_uuid: ''
    });
    const staged = text(value);
    if (!staged) throw new Error('getRichMediaFilePathForGuild returned no path');
    return staged;
  }

  function fileForSend(file, name, track) {
    const info = fileInfoOf(file, name);
    const staged = stageFile(info);
    if (!fs.existsSync(staged)) {
      try {
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        fs.copyFileSync(file, staged);
      } catch (error) {
        throw new Error('cannot stage the file into the client media directory: ' +
          (error && error.message || error));
      }
      if (track) track(staged);
    }
    return { path: staged, fileName: info.fileName, size: info.size, md5: info.md5 };
  }

  // The client's own file element is tiny; md5/sha1 are only for inbound
  // display, the upload reads them off the staged file itself.
  function buildFileElement(staged) {
    return {
      elementType: 3,
      elementId: '',
      elementGroupId: 0,
      fileElement: {
        fileName: text(staged.fileName),
        folderId: text(staged.folderId),
        filePath: text(staged.path),
        fileSize: text(staged.size)
      }
    };
  }

  function buildSendElements(params, track) {
    const elements = Array.isArray(params.elements) ? params.elements : null;
    if (!elements || elements.length === 0) {
      const content = text(params.text);
      if (!content) throw new Error('text is required');
      return [{
        elementType: 1, elementId: '',
        textElement: { content: content, atType: 0, atUid: '', atTinyId: '', atNtUid: '' }
      }];
    }
    const result = [];
    for (const segment of elements) {
      const type = text(segment && segment.type);
      const data = (segment && segment.data) || {};
      if (type === 'text') {
        const content = text(data.text);
        if (!content) continue;
        result.push({
          elementType: 1, elementId: '',
          textElement: { content: content, atType: 0, atUid: '', atTinyId: '', atNtUid: '' }
        });
      } else if (type === 'at') {
        const targetUin = text(data.qq);
        const targetUid = text(data.uid);
        if (!targetUid && !targetUin) continue;
        result.push({
          elementType: 1, elementId: '',
          textElement: {
            content: '@' + (text(data.name) || targetUin || targetUid),
            atType: targetUin === 'all' ? 2 : 1,
            atUid: targetUin === 'all' ? 'all' : targetUin,
            atTinyId: '',
            atNtUid: targetUid || targetUin
          }
        });
      } else if (type === 'image') {
        // Only a path that exists on this machine: this endpoint does not fetch
        // media, so a url or a base64 payload is refused with a reason rather
        // than silently degraded.
        const raw = text(pickFirst(data, ['file', 'path', 'url', 'base64']));
        if (/^(https?:|base64:|data:)/i.test(raw)) {
          throw new Error('image must be a path on this machine; ' +
            'this endpoint neither downloads nor accepts base64 media');
        }
        const picture = requireLocalFile(raw, 'image');
        result.push(buildPicElement(stagePic(picture, track)));
      } else if (type === 'reply') {
        // QQ addresses a reply by the quoted message's seq + msgId + sender, so
        // the id has to resolve inside our own cache. Shapes follow NapCat's
        // replyElement (including the kernel's "replayMsg*" spelling).
        const id = text(data.id);
        if (!id) throw new Error('reply needs the id of a message the bridge has seen');
        const quoted = messageCache.get(id);
        if (!quoted) {
          throw new Error('message ' + id + ' is not in the bridge cache, so it cannot be quoted');
        }
        const peer = quoted.is_group
          ? { chatType: 2, peerUid: text(quoted.group_id), guildId: '' }
          : { chatType: 1, peerUid: text(quoted.peer_uid), guildId: '' };
        result.push({
          elementType: 7, elementId: '',
          replyElement: {
            replayMsgSeq: text(quoted.sequence),
            replayMsgId: text(quoted.message_id),
            senderUin: Number(quoted.sender && quoted.sender.uin) || 0,
            senderUinStr: text(quoted.sender && quoted.sender.uin),
            replyMsgClientSeq: text(quoted.client_seq),
            _replyMsgPeer: peer
          }
        });
      } else if (type === 'face') {
        const faceId = Number(data.id) || 0;
        if (!faceId) throw new Error('face needs a numeric id (QQ face index)');
        // Classic faces are 1..221; the animated ones are a different element
        // with sticker fields this endpoint does not carry, so they keep
        // faceType 2 and let the kernel decide.
        result.push({
          elementType: 6, elementId: '',
          faceElement: {
            faceIndex: faceId,
            faceType: faceId >= 222 ? 2 : 1,
            faceText: text(data.text) || '[\u8868\u60c5]',
            sourceType: 1,
            chainCount: 0
          }
        });
      } else if (type === 'file') {
        const raw = text(pickFirst(data, ['file', 'path']));
        if (/^(https?:|base64:|data:)/i.test(raw)) {
          throw new Error('file must be a path on this machine; ' +
            'this endpoint neither downloads nor accepts base64 media');
        }
        const local = requireLocalFile(raw, 'file');
        const staged = fileForSend(local, text(data.name), track);
        staged.folderId = text(pickFirst(data, ['folder', 'folder_id']));
        result.push(buildFileElement(staged));
      } else {
        throw new Error('sending "' + type + '" segments is not implemented yet');
      }
    }
    if (result.length === 0) throw new Error('message has no sendable segments');
    return result;
  }

  function waitForSend(clientId, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingSends.delete(clientId);
        resolve(null);
      }, timeoutMs || 2500);
      pendingSends.set(clientId, { resolve: resolve, timer: timer });
    });
  }

  function cancelPendingSend(clientId) {
    const pending = pendingSends.get(clientId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingSends.delete(clientId);
  }

  async function sendMessage(params) {
    const alive = session();
    const msgService = alive.getMsgService();
    if (!msgService) throw new Error('getMsgService returned nothing');
    const self = await ensureSelf();
    const scene = text(params.scene) || (params.group_id ? 'group' : 'private');
    let peer;
    let destUin = '';
    let destName = '';
    if (scene === 'group') {
      const groupId = text(params.group_id || params.channel_id);
      if (!groupId) throw new Error('group_id is required');
      peer = { chatType: 2, peerUid: groupId, guildId: '' };
      destUin = groupId;
    } else {
      let uid = text(params.peer_uid || params.uid);
      destUin = text(params.user_id || params.uin);
      if (!uid) {
        const friends = await getFriends(false);
        const friend = friends.find(f => (destUin && f.uin === destUin) || f.uid === uid);
        if (!friend) throw new Error('friend not found: ' + (destUin || uid));
        uid = friend.uid;
        destUin = text(friend.uin) || destUin;
        destName = text(friend.remark) || text(friend.nick);
      }
      peer = { chatType: 1, peerUid: uid, guildId: '' };
    }

    const stagedFiles = new Set();
    const elements = buildSendElements(params, (file) => stagedFiles.add(file));
    // A file send is an upload: the kernel reports it on
    // onRichMediaUploadComplete keyed by the staged path, and that callback is
    // the only place the fileId shows up (the sent element keeps fileUuid '').
    // Pictures upload too, but their confirmation already implies success and
    // the reply does not wait for the upload; the staged copy is removed when
    // that report arrives instead (below).
    const uploadPaths = elements
      .filter((element) => Number(element.elementType) === 3)
      .map((element) => text((element.fileElement || {}).filePath))
      .filter(Boolean);
    const uploadDone = uploadPaths.length
      ? waitKernelEvent('msg.onRichMediaUploadComplete', (args) => {
        const raw = (args || [])[0];
        if (!raw) return false;
        return uploadPaths.indexOf(text(raw.filePath)) !== -1;
      }, 120000)
      : null;
    // Only copies made by this send are candidates, and only once the kernel
    // says the upload finished; deleting earlier could pull the bytes out from
    // under an in-flight upload.
    const pictureCleanups = elements
      .filter((element) => Number(element.elementType) === 2)
      .map((element) => text((element.picElement || {}).sourcePath))
      .filter((file) => stagedFiles.has(file))
      .map((file) => {
        const done = waitKernelEvent('msg.onRichMediaUploadComplete', (args) => {
          const raw = (args || [])[0];
          return text(raw && raw.filePath) === file;
        }, 120000);
        done.then((pushed) => {
          const report = (pushed || [])[0];
          if (report && (Number(report.fileErrCode) || 0) === 0) releaseStaged([file]);
        });
        return done;
      });
    const serverTime = alive.getMSFService().getServerTime();
    const clientId = String(msgService.generateMsgUniqueId(peer.chatType, serverTime));
    peer.guildId = clientId;
    sentPeers.set(clientId, {
      is_group: scene === 'group',
      peer_uin: destUin,
      peer_name: destName
    });
    while (sentPeers.size > 200) {
      const oldest = sentPeers.keys().next().value;
      if (oldest === undefined) break;
      sentPeers.delete(oldest);
    }

    // Register before calling sendMsg: the kernel callback can fire while the
    // send promise is still resolving.
    const confirmation = waitForSend(clientId, 2500);

    let result;
    let sendTimedOut = false;
    try {
      result = msgService.sendMsg('0', peer, elements, new Map());
      if (result && typeof result.then === 'function') {
        // sendMsg returns a promise, and it can settle long after the message is
        // out. Seen on a real run: onAddSendMsg had already delivered the echo
        // while the promise was still unsettled 30 s later, which timed out the
        // protocol action even though QQ had sent the message. So the echo wins
        // when it comes first; the promise still wins when it carries an error
        // (result=121 and friends). 10 s is only the last resort - NapCat wraps
        // the same call in a timeout for the same reason.
        const kernel = result.then(
          (value) => ({ kind: 'result', value }),
          (error) => ({ kind: 'error', error })
        );
        const echoed = confirmation.then(
          (confirmed) => (confirmed ? { kind: 'echo', confirmed } : { kind: 'noecho' })
        );
        const first = await Promise.race([
          kernel,
          echoed,
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ kind: 'slow' }), 10000);
            if (timer.unref) timer.unref();
          })
        ]);
        if (first.kind === 'error') throw first.error;
        if (first.kind === 'result') {
          result = first.value;
        } else if (first.kind === 'echo') {
          result = { result: 0 };
        } else if (first.kind === 'noecho') {
          // No echo in 2.5 s; give the kernel promise its remaining time so a
          // real refusal is reported instead of an invented success.
          const later = await Promise.race([
            kernel,
            new Promise((resolve) => {
              const timer = setTimeout(() => resolve({ kind: 'slow' }), 7500);
              if (timer.unref) timer.unref();
            })
          ]);
          if (later.kind === 'error') throw later.error;
          if (later.kind === 'result') result = later.value;
          else {
            result = null;
            sendTimedOut = true;
          }
        } else {
          result = null;
          sendTimedOut = true;
        }
      }
    } catch (e) {
      cancelPendingSend(clientId);
      sentPeers.delete(clientId);
      if (uploadDone) uploadDone.cancel();
      for (const done of pictureCleanups) done.cancel();
      throw new Error('sendMsg threw: ' + String(e && e.message || e));
    }
    if (sendTimedOut) {
      cancelPendingSend(clientId);
      sentPeers.delete(clientId);
      if (uploadDone) uploadDone.cancel();
      for (const done of pictureCleanups) done.cancel();
      throw new Error('sendMsg neither returned nor echoed within 10s; treat it as not sent');
    }
    const code = result && typeof result.result === 'number' ? result.result : undefined;
    if (code !== undefined && code !== 0) {
      cancelPendingSend(clientId);
      sentPeers.delete(clientId);
      if (uploadDone) uploadDone.cancel();
      for (const done of pictureCleanups) done.cancel();
      throw new Error('sendMsg result=' + code +
        (result.errMsg ? ': ' + result.errMsg : ''));
    }

    counters.send++;
    // Insurance: once live the upload finished server-side but this process
    // never saw onRichMediaUploadComplete, which would leave the copy behind
    // forever. Sweep whatever this send staged a few minutes later; harmless
    // if the normal path already removed it, and long enough that no upload
    // can still be reading the bytes.
    if (stagedFiles.size) {
      const timer = setTimeout(() => {
        stagedFallbackTimers.delete(timer);
        releaseStaged(Array.from(stagedFiles));
      }, 180000);
      stagedFallbackTimers.add(timer);
    }
    const confirmed = await confirmation;
    let upload = null;
    if (uploadDone) {
      const pushed = (await uploadDone) || [];
      const report = pushed[0];
      if (!report) {
        throw new Error('the upload of ' + uploadPaths[0] + ' did not report back within 120s');
      }
      const errCode = Number(report.fileErrCode) || 0;
      if (errCode !== 0) {
        throw new Error('upload failed: ' +
          (text(report.fileErrMsg) || ('fileErrCode ' + errCode)));
      }
      upload = { file_id: text(report.fileId), size: Number(report.totalSize) || 0 };
    }
    // The kernel is done with the file once it reports the upload, so the copy
    // this send made can go. Anything staged before this call is never in the
    // set and stays untouched.
    releaseStaged(uploadPaths.filter((file) => stagedFiles.has(file)));
    return {
      client_id: clientId,
      message_id: text(confirmed && confirmed.msgId) || clientId,
      confirmed: !!confirmed,
      time: Number(confirmed && confirmed.msgTime) || Math.floor(Date.now() / 1000),
      peer: { chat_type: peer.chatType, peer_uid: peer.peerUid },
      self: self,
      upload: upload
    };
  }

  async function recallMessage(params) {
    const alive = session();
    const msgService = alive.getMsgService();
    if (!msgService) throw new Error('getMsgService returned nothing');
    const messageId = text(params.message_id);
    if (!messageId) throw new Error('message_id is required');
    let chatType = Number(params.chat_type || 0) || 0;
    let peerUid = text(params.peer_uid);
    if (!chatType || !peerUid) {
      const cached = messageCache.get(messageId);
      if (!cached) throw new Error('cannot resolve peer for message ' + messageId);
      chatType = Number(cached.chat_type) || 0;
      peerUid = text(cached.peer_uid);
    }
    if (!chatType || !peerUid) throw new Error('cannot resolve peer for message ' + messageId);
    const peer = { chatType: chatType, peerUid: peerUid, guildId: '' };
    try {
      const value = msgService.recallMsg(peer, [messageId]);
      if (value && typeof value.then === 'function') await value;
    } catch (e) {
      throw new Error('recallMsg failed: ' + String(e && e.message || e));
    }
    return { recalled: true, message_id: messageId };
  }

  function listCachedMessages(params) {
    const channelId = text(params.channel_id);
    const limit = Math.max(1, Math.min(Number(params.limit) || 50, 100));
    const items = [];
    for (const event of messageCache.values()) {
      if (event.type !== 'message') continue;
      if (channelId) {
        const candidate = event.is_group ? text(event.group_id) : text(event.peer_uin || event.sender.uin);
        if (candidate !== channelId && text(event.sender.uin) !== channelId) continue;
      }
      items.push(event);
    }
    items.sort((a, b) => b.time - a.time);
    return { messages: items.slice(0, limit) };
  }

  // ---------------------------------------------------------------------------
  // Group administration, notices, files, reactions.
  //
  // Each action below is the same kernel call NapCat makes for the matching
  // OneBot action, adapted to two rules that are ours rather than NapCat's:
  //   * nothing reads the message database - a message is addressed with the
  //     sequence/random the live kernel event carried into messageCache, so
  //     only messages seen since injection are reachable;
  //   * nothing uploads media, so every capability behind Highway stays
  //     unimplemented and says so.
  // ---------------------------------------------------------------------------

  // Some methods changed name or service between QQ builds; walk the
  // candidates and keep the first real answer instead of failing on the first
  // missing name.
  async function nativeAny(serviceName, methods, args) {
    const instance = getSessionService(serviceName);
    let lastError = null;
    for (const method of methods) {
      if (typeof instance[method] !== 'function') {
        lastError = new Error(method + ' is not available on this QQ build');
        continue;
      }
      try {
        return await callMethod(instance, method, args);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(methods.join('/') + ' is not available on this QQ build');
  }

  // Address a message through the live cache. The protocol layer already maps
  // its own ids back to native ones, so this only ever sees a msgId.
  function cachedMessage(messageId, label) {
    const key = text(messageId);
    if (!key) throw new Error('message_id is required');
    const event = messageCache.get(key);
    if (!event) {
      const error = new Error(label + ': message ' + key + ' is not in the bridge cache; ' +
        'only messages seen since injection are addressable');
      error.code = 'message_not_cached';
      throw error;
    }
    if (event.synthetic) throw new Error(label + ': synthetic messages cannot be sent to QQ');
    return event;
  }

  function boolOf(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'string') return !(value === 'false' || value === '0' || value === '');
    return !!value;
  }

  // First parameter spelling the client used; OneBot clients are not consistent
  // about aliases for the same field.
  function pickFirst(params, names) {
    for (const name of names) {
      const value = params ? params[name] : undefined;
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  }

  function approveOf(params) {
    if (params.approve !== undefined) return boolOf(params.approve, true);
    if (params.accept !== undefined) return boolOf(params.accept, true);
    if (params.handle !== undefined) return boolOf(params.handle, false);
    return !(Number(params.refuse) === 1 || Number(params.block) === 1);
  }

  // Destination peer for an action that sends or addresses a chat: group wins
  // when group_id is present, otherwise the user_id is resolved to a uid.
  async function destPeer(params) {
    if (params.group_id) return peerOf(2, groupCodeOf(params.group_id));
    const uid = text(params.peer_uid) || await uidByUin(params.user_id);
    if (!uid) throw new Error('cannot resolve user ' + text(params.user_id) + ' to a uid');
    return peerOf(1, uid);
  }

  const actions = {
    ping: async () => ({ pong: true, time: Date.now() }),
    status: async () => status(),
    get_self: async () => ensureSelf(),
    get_friends: async (params) => ({ friends: await getFriends(!!params.force) }),
    get_groups: async (params) => ({ groups: await getGroups(!!params.force) }),
    get_group_members: async (params) => ({
      members: await getGroupMembers(params.group_id, !!params.force)
    }),
    get_user: async (params) => ({ user: await getUser(params) }),
    qq_window: async (params) => {
      const mode = text(params.mode || params.action || 'status').toLowerCase();
      if (mode === 'status') {
        return { quiet: windowState.quiet, windows: windowsNow().map(windowInfo) };
      }
      if (mode === 'hide') {
        const win = mainWindow();
        if (win) win.hide();
        return { quiet: windowState.quiet, hidden: win ? win.id : null,
          windows: windowsNow().map(windowInfo) };
      }
      if (mode === 'show') {
        leaveQuiet();
        const win = showMainWindow();
        return { quiet: false, shown: win ? win.id : null,
          windows: windowsNow().map(windowInfo) };
      }
      if (mode === 'quiet') {
        enterQuiet(params);
        return { quiet: true, muted: windowState.mute,
          windows: windowsNow().map(windowInfo) };
      }
      throw new Error('mode must be status, hide, show or quiet');
    },
    tray_icon: async (params) => {
      const e = electronApi();
      if (!e) throw new Error('electron is not reachable from this process');
      installTrayHook();
      const mode = text(params.mode || params.action || 'status').toLowerCase();
      if (mode === 'status') return trayStatus();
      const ref = trayState.ref;
      if (!ref) {
        throw new Error('the QQ Tray has not been seen yet: it is captured on its next ' +
          'update (an incoming message or a status change), then retry');
      }
      if (mode === 'set') {
        const file = requireLocalFile(text(params.file || params.icon), 'icon');
        const image = e.nativeImage.createFromPath(file);
        if (!image || image.isEmpty()) throw new Error('cannot read the icon image: ' + file);
        const tooltip = text(params.tooltip);
        try {
          trayState.bypass = true;
          ref.setImage(image);
          if (tooltip) ref.setToolTip(tooltip);
        } finally {
          trayState.bypass = false;
        }
        trayState.custom = { file: file, tooltip: tooltip };
        trayState.customTooltip = !!tooltip;
        return trayStatus();
      }
      if (mode === 'reset') {
        let restored = false;
        try {
          trayState.bypass = true;
          if (trayState.lastImage) {
            ref.setImage(trayState.lastImage);
            restored = true;
          }
          if (trayState.customTooltip && trayState.lastTooltip) {
            ref.setToolTip(trayState.lastTooltip);
          }
        } finally {
          trayState.bypass = false;
        }
        trayState.custom = null;
        trayState.customTooltip = false;
        return Object.assign(trayStatus(), {
          restoredImage: restored,
          note: restored ? '' : 'no earlier QQ image was captured; the next QQ tray update will draw it again'
        });
      }
      throw new Error('mode must be status, set or reset');
    },
    send_message: async (params) => sendMessage(params),
    upload_group_file: async (params) => {
      const code = groupCodeOf(params.group_id);
      const local = requireLocalFile(text(params.file || params.path), 'file');
      // Only the name and size are needed here; the staging and upload happen
      // inside sendMessage, which also removes the copy it made afterwards.
      const info = fileInfoOf(local, text(params.name));
      const value = await sendMessage({
        scene: 'group', group_id: code,
        elements: [{
          type: 'file',
          data: {
            file: local,
            name: info.fileName,
            folder: text(params.folder || params.folder_id)
          }
        }]
      });
      return {
        group_id: Number(code) || 0,
        file_id: text(value.upload && value.upload.file_id),
        message_id: value.message_id,
        file_name: info.fileName,
        file_size: info.size
      };
    },
    recall: async (params) => recallMessage(params),
    get_cached_message: async (params) => ({
      message: messageCache.get(text(params.message_id)) || null
    }),
    list_cached_messages: async (params) => listCachedMessages(params),

    // -- group administration ------------------------------------------------
    set_group_ban: async (params) => {
      const code = groupCodeOf(params.group_id);
      const uid = await memberUidForGroup(code, params.user_id);
      // QQ refuses to ban an owner, and an admin may only be banned by the
      // owner; checking first turns a bare kernel error into a readable one.
      const members = await getGroupMembers(code, false);
      const target = members.find(item => text(item.uid) === uid);
      const self = currentSelf();
      const me = members.find(item => text(item.uid) === text(self.uid)) ||
        members.find(item => text(item.uin) === text(self.uin));
      const roleOf = (item) => Number(item && item.role) || 0;
      if (target && roleOf(target) === 4) throw new Error('cannot ban the group owner');
      if (target && roleOf(target) === 3 && roleOf(me) !== 4) {
        throw new Error('only the owner can ban an admin');
      }
      // timeStamp is the mute length in seconds; 0 lifts an existing mute.
      const duration = Math.max(0, Math.min(Number(params.duration) || 0, 86400 * 365));
      checkResult(await nativeCall('getGroupService', 'setMemberShutUp',
        [code, [{ uid: uid, timeStamp: duration }]]), 'setMemberShutUp');
      return { group_id: Number(code) || 0, user_id: Number(params.user_id) || 0, duration: duration };
    },
    set_group_whole_ban: async (params) => {
      const code = groupCodeOf(params.group_id);
      const enable = boolOf(params.enable, true);
      checkResult(await nativeAny('getGroupService', ['setGroupShutUp'], [code, enable]), 'setGroupShutUp');
      return { group_id: Number(code) || 0, enable: enable };
    },
    get_group_shut_list: async (params) => {
      const code = groupCodeOf(params.group_id);
      await ensureGroupListener();
      return await nativeCallWithEvent({
        service: 'getGroupService',
        method: 'getGroupShutUpMemberList',
        args: [code],
        listener: 'group',
        callback: 'onShutUpMemberListChanged',
        label: 'getGroupShutUpMemberList',
        // NapCat only gives this callback a second; nobody muted is the normal
        // case, so a long wait would just stall the caller.
        timeoutMs: 3000,
        allowTimeoutReturn: true,
        // A group with nobody muted pushes nothing at all: that is an empty
        // list, not a failure (NapCat resolves the same case to []).
        tolerateNoCallback: true,
        matches: (args) => {
          const list = (args || []).find(Array.isArray);
          return !!list || text((args || [])[0]) === code;
        },
        pick: (args, value) => {
          let list = [];
          for (const candidate of [(args || []).find(Array.isArray),
            value && (value.shutUpMemberList || value.members)]) {
            if (Array.isArray(candidate)) { list = candidate; break; }
          }
          // ShutUpGroupMember: uid/uin/nick/cardName/role/shutUpTime, where
          // shutUpTime is the remaining seconds rather than a timestamp.
          return {
            group_id: Number(code) || 0,
            members: list.map(item => ({
              uid: text(item.uid),
              user_id: Number(item.uin || 0) || 0,
              nickname: text(item.nick),
              card: text(item.cardName),
              role: Number(item.role || 0) || 0,
              duration: Number(item.shutUpTime || 0) || 0,
              join_time: Number(item.joinTime || 0) || 0
            }))
          };
        }
      });
    },
    set_group_kick: async (params) => {
      const code = groupCodeOf(params.group_id);
      const uid = await memberUidForGroup(code, params.user_id);
      const reason = text(params.reason);
      const refuseForever = boolOf(params.reject_add_request, false);
      checkResult(await nativeCall('getGroupService', 'kickMember',
        [code, [uid], refuseForever, reason]), 'kickMember');
      return { group_id: Number(code) || 0, user_id: Number(params.user_id) || 0 };
    },
    set_group_admin: async (params) => {
      const code = groupCodeOf(params.group_id);
      const uid = await memberUidForGroup(code, params.user_id);
      const enable = boolOf(params.enable, true);
      // memberRole: 4 owner, 3 admin, 2 member.
      checkResult(await nativeCall('getGroupService', 'modifyMemberRole',
        [code, uid, enable ? 3 : 2]), 'modifyMemberRole');
      return { group_id: Number(code) || 0, user_id: Number(params.user_id) || 0, admin: enable };
    },
    set_group_card: async (params) => {
      const code = groupCodeOf(params.group_id);
      const uid = await memberUidForGroup(code, params.user_id);
      const card = text(params.card);
      checkResult(await nativeCall('getGroupService', 'modifyMemberCardName',
        [code, uid, card]), 'modifyMemberCardName');
      return { group_id: Number(code) || 0, user_id: Number(params.user_id) || 0, card: card };
    },
    set_group_name: async (params) => {
      const code = groupCodeOf(params.group_id);
      const name = text(params.group_name || params.name);
      if (!name) throw new Error('group_name is required');
      checkResult(await nativeCall('getGroupService', 'modifyGroupName',
        [code, name, false]), 'modifyGroupName');
      groupsAt = 0;
      return { group_id: Number(code) || 0, group_name: name };
    },
    set_group_special_title: async (params) => {
      // Measured on this build (9.9.36-53644), by enumerating every method of
      // NodeIKernelGroupService: `modifyMemberSpecialTitle` is simply gone. The
      // two survivors are not a replacement -
      //   getGroupHonorList(param)      answers errCode 20000 "param(group_id)
      //                                 error" for group_id / groupCode / gid in
      //                                 both string and number form, and
      //   setIdentityTitleInfo(param)   does reach the server (cmd 0x899) but
      //                                 answers result 10005 "not group member
      //                                 (0x899_0)" for every member field
      //                                 spelling tried (memberUid, memberUin,
      //                                 uid, specialText/expireTime).
      // NapCat writes titles with the raw 0x899 packet
      // (packet/transformer/action/SetSpecialTitle.ts), and the packet layer is
      // the one thing this endpoint deliberately does not do, so say so instead
      // of pretending the capability is waiting on another argument order.
      throw new Error('set_group_special_title is not available on this QQ build: ' +
        'the kernel title method modifyMemberSpecialTitle no longer exists, and setting ' +
        'a title goes through the raw 0x899 packet, which this endpoint does not send');
    },
    set_group_leave: async (params) => {
      const code = groupCodeOf(params.group_id);
      const self = currentSelf();
      let group = (groupsCache || []).find(item => text(item.group_id) === code);
      if (!group) {
        await getGroups(false).catch(() => null);
        group = (groupsCache || []).find(item => text(item.group_id) === code);
      }
      // destroyGroup is the only call an owner can make; quitGroup is what a
      // plain member gets. Clients may also ask for either one explicitly.
      const asked = boolOf(pickFirst(params, ['is_dismiss', 'dismiss', 'destroy']), null);
      const isOwner = !!group && text(group.owner_uin) === text(self.uin);
      const dismiss = asked === null ? isOwner : asked;
      const method = dismiss ? 'destroyGroup' : 'quitGroup';
      checkResult(await nativeCall('getGroupService', method, [code]), method);
      groupsAt = 0;
      return { group_id: Number(code) || 0, left: true, dissolved: dismiss };
    },
    set_group_remark: async (params) => {
      const code = groupCodeOf(params.group_id);
      const remark = text(params.remark);
      checkResult(await nativeCall('getGroupService', 'modifyGroupRemark',
        [code, remark]), 'modifyGroupRemark');
      groupsAt = 0;
      return { group_id: Number(code) || 0, remark: remark };
    },
    get_group_at_all_remain: async (params) => {
      const code = groupCodeOf(params.group_id);
      const value = checkResult(await nativeCall('getGroupService',
        'getGroupRemainAtTimes', [code]), 'getGroupRemainAtTimes');
      const at = value.atInfo || value.AtCount || value.atCount || {};
      const canAtAll = at.canAtAll === undefined ? !!value.CanAtAll : !!at.canAtAll;
      const forGroup = at.RemainAtAllCountForGroup !== undefined ? at.RemainAtAllCountForGroup :
        (at.AllAt !== undefined ? at.AllAt : at.allAt);
      const forUin = at.RemainAtAllCountForUin !== undefined ? at.RemainAtAllCountForUin :
        (at.RemainAt !== undefined ? at.RemainAt : at.remainAt);
      return {
        group_id: Number(code) || 0,
        is_show: true,
        can_at_all: canAtAll,
        remain_at_all_count_for_group: Number(forGroup) || 0,
        remain_at_all_count_for_uin: Number(forUin) || 0
      };
    },
    get_group_detail: async (params) => {
      const code = groupCodeOf(params.group_id);
      await ensureGroupListener();
      return await nativeCallWithEvent({
        service: 'getGroupService',
        // GroupInfoSource.KDATACARD, the source NapCat asks for.
        method: 'getGroupDetailInfo',
        args: [code, Number(params.source) || 2],
        listener: 'group',
        callback: 'onGroupDetailInfoChange',
        label: 'getGroupDetailInfo',
        timeoutMs: 8000,
        // The listener hands back one GroupDetailInfo, not a list.
        matches: (args) => !!findDetailInfo(args, code),
        // A cold cache answers with only a few fields filled in; keep waiting a
        // moment for the full record but fall back to the richest one seen.
        enough: (args) => {
          const info = findDetailInfo(args, code);
          return !!(info && (Number(info.memberNum) > 0 || info.ownerUin || info.ownerUid));
        },
        pick: (args) => {
          const info = findDetailInfo(args, code) || {};
          const owner = (info.groupExt && info.groupExt.groupOwnerId) || {};
          return {
            group_id: Number(info.groupCode || info.groupUin || code) || 0,
            group_code: text(info.groupCode),
            group_uin: text(info.groupUin),
            group_name: text(info.groupName),
            long_group_name: text(info.longGroupName),
            remark: text(info.remarkName),
            memo: text(info.fingerMemo || info.groupMemo),
            rich_memo: text(info.richFingerMemo),
            member_count: Number(info.memberNum || 0) || 0,
            max_member_count: Number(info.maxMemberNum || 0) || 0,
            active_member_count: Number(info.activeMemberNum || 0) || 0,
            create_time: Number(info.groupCreateTime || 0) || 0,
            join_time: Number(info.cmdUinJoinTime || 0) || 0,
            owner_uid: text(info.ownerUid || owner.memberUid),
            owner_uin: Number(info.ownerUin || owner.memberUin || 0) || 0,
            grade: Number(info.groupGrade || 0) || 0,
            admin_max_num: Number(info.groupAdminMaxNum || 0) || 0,
            is_conf: !!info.isConfGroup,
            // Whole-group mute and this account's own mute, in epoch seconds.
            shut_up_all_timestamp: Number(info.shutUpAllTimestamp || 0) || 0,
            shut_up_me_timestamp: Number(info.shutUpMeTimestamp || 0) || 0,
            is_top: !!info.isTop,
            detail: info
          };
        }
      });
    },

    get_group_level_info: async (params) => {
      const code = groupCodeOf(params.group_id);
      await ensureGroupListener();
      // Measured on the real client: getGroupMemberLevelInfo never settles its
      // promise, the answer arrives on
      // onGroupMemberLevelInfoChange(groupCode, {levelNameNewList, userShowFlag,
      // sysShowFlag}) - it is the group's level naming scheme, not per-member
      // levels. Those come with the member list (memberRealLevel).
      return await nativeCallWithEvent({
        service: 'getGroupService',
        method: 'getGroupMemberLevelInfo',
        args: [code],
        listener: 'group',
        callback: 'onGroupMemberLevelInfoChange',
        label: 'getGroupMemberLevelInfo',
        timeoutMs: 4000,
        tolerateNoCallback: true,
        allowTimeoutReturn: true,
        matches: (args) => !args || !args[0] || text(args[0]) === code,
        pick: (args) => {
          const info = (args || []).find(item => item && typeof item === 'object') || {};
          const names = info.levelNameNewList || info.levelNameList || [];
          return {
            group_id: Number(code) || 0,
            level_names: (Array.isArray(names) ? names : []).map(entry => ({
              level: Number(entry && entry.level || 0) || 0,
              name: text(entry && (entry.name || entry.levelName))
            })),
            user_show_flag: Number(info.userShowFlag || 0) || 0,
            sys_show_flag: Number(info.sysShowFlag || 0) || 0
          };
        }
      });
    },
    clear_group_notice_unread: async (params) => {
      const doubt = boolOf(params.doubt, false);
      await ensureGroupListener();
      if (params.group_id) {
        await nativeAny('getGroupService', ['clearGroupNotifies'], [text(params.group_id)])
          .catch(error => appendLog('clearGroupNotifies: ' + (error && error.message || error)));
      }
      await nativeAny('getGroupService', ['clearGroupNotifiesUnreadCount'], [doubt]);
      return { cleared: true, doubt: doubt };
    },

    // -- group requests / friend requests ------------------------------------
    get_group_system_notices: async (params) => {
      const doubt = boolOf(params.doubt, false);
      const count = Math.max(1, Math.min(Number(params.count) || 50, 100));
      const list = await fetchSingleScreenNotifies(doubt, count);
      return { doubt: doubt, count: list.length, requests: list };
    },
    handle_group_request: async (params) => {
      const approve = approveOf(params);
      // A reason only belongs to a rejection, and an empty postscript makes the
      // kernel fail, so NapCat falls back to a single space.
      const postscript = text(params.reason) || ' ';
      const flag = text(pickFirst(params, ['seq', 'request_id', 'flag', 'notice_id']));
      if (!flag) throw new Error('seq is required');
      await ensureGroupListener();
      let doubt = boolOf(params.doubt, false);
      let notify = null;
      if (params.type !== undefined && params.group_id !== undefined) {
        notify = {
          seq: flag,
          type: Number(params.type) || 0,
          group: { groupCode: text(params.group_id) },
          memberUid: ''
        };
      } else {
        // Same search NapCat runs: the ordinary screen first, then the doubt
        // one, which also decides the doubt flag the operate call needs.
        for (const doubtFlag of [doubt, !doubt]) {
          const found = (await fetchSingleScreenNotifies(doubtFlag, 100, true))
            .find(item => text(item.seq) === flag);
          if (found) { doubt = doubtFlag; notify = found; break; }
        }
      }
      if (!notify) throw new Error('no such group request: ' + flag);
      // Measured: the same screen also carries 管理员变更 notices (type 8). They
      // are not requests, and "agreeing" to one only rewrites the group's
      // notice state, so refuse before the operate call.
      const notifyType = Number(notify.type) || 0;
      if (!REQUEST_NOTIFY_TYPES.has(notifyType)) {
        throw new Error('refusing to answer group notice ' + flag + ': type ' + notifyType +
          ' is not a join/invite request (only 1, 5 and 7 are; 8 is a 管理员变更 notice)');
      }
      const value = checkResult(await nativeCall('getGroupService', 'operateSysNotify', [doubt, {
        // NTGroupRequestOperateTypes: 1 agree, 2 refuse, 3 ignore, 4 delete.
        operateType: Number(params.operate_type) || (approve ? 1 : 2),
        targetMsg: {
          seq: flag,
          type: Number(notify.type) || 0,
          groupCode: text(notify.group_id || (notify.group && notify.group.groupCode)),
          postscript: postscript
        }
      }]), 'operateSysNotify');
      return {
        handled: true,
        seq: flag,
        doubt: doubt,
        approve: approve,
        result: value && value.result
      };
    },
    get_friend_requests: async (params) => {
      await ensureBuddyListener();
      const notify = await nativeCallWithEvent({
        service: 'getBuddyService',
        method: 'getBuddyReq',
        args: [],
        listener: 'buddy',
        callback: 'onBuddyReqChange',
        label: 'getBuddyReq',
        timeoutMs: 6000,
        allowTimeoutReturn: true,
        // No pending friend request means no push, which is an empty list.
        tolerateNoCallback: true,
        matches: (args) => {
          const source = (args || []).find(item => item && item.buddyReqs);
          return !!source;
        },
        pick: (args, value) => {
          const source = (args || []).find(item => item && Array.isArray(item.buddyReqs)) ||
            value || {};
          return source;
        }
      });
      const list = (notify.buddyReqs || []).map(normalizeBuddyRequest);
      // Only requests aimed at us are actionable; our own outbound ones are
      // reported so a bot can see what it already accepted.
      const incoming = params.only_incoming ? list.filter(item => !item.is_initiator) : list;
      return {
        unread: Number(notify.unreadNums) || 0,
        requests: await withUserIds(incoming)
      };
    },
    handle_friend_request: async (params) => {
      const flag = text(pickFirst(params, ['req_time', 'request_id', 'flag', 'seq']));
      if (!flag) throw new Error('flag (the reqTime of the request) is required');
      const approve = approveOf(params);
      await ensureBuddyListener();
      let target = null;
      if (params.user_uid) {
        target = { friendUid: text(params.user_uid), reqTime: flag };
      } else {
        const notify = await nativeCallWithEvent({
          service: 'getBuddyService',
          method: 'getBuddyReq',
          args: [],
          listener: 'buddy',
          callback: 'onBuddyReqChange',
          label: 'getBuddyReq',
          timeoutMs: 6000,
          allowTimeoutReturn: true,
          matches: (args) => {
            const source = (args || []).find(item => item && Array.isArray(item.buddyReqs));
            return !!source && (source.buddyReqs || []).some(e => text(e.reqTime) === flag);
          },
          pick: (args, value) => {
            const source = (args || []).find(item => item && Array.isArray(item.buddyReqs)) ||
              value || {};
            return source;
          }
        });
        target = (notify.buddyReqs || []).find(item => text(item.reqTime) === flag);
      }
      if (!target) throw new Error('no such friend request: ' + flag);
      const uid = text(target.friendUid || target.user_uid);
      if (!uid) throw new Error('the friend request carries no uid');
      // approvalFriendRequest answers through the listener rather than its
      // return value, so the call alone is the acknowledgement we get.
      await nativeAny('getBuddyService', ['approvalFriendRequest'],
        [{ friendUid: uid, reqTime: text(target.reqTime || flag), accept: approve }]);
      const remark = text(params.remark);
      if (remark && approve) {
        await nativeAny('getBuddyService', ['setBuddyRemark'], [{ uid: uid, remark: remark }])
          .catch(error => appendLog('setBuddyRemark: ' + (error && error.message || error)));
      }
      friendsAt = 0;
      return { handled: true, flag: flag, accept: approve };
    },
    clear_friend_request_unread: async () => {
      await ensureBuddyListener();
      await nativeAny('getBuddyService', ['clearBuddyReqUnreadCnt'], []);
      return { cleared: true };
    },
    set_friend_remark: async (params) => {
      const uid = text(params.user_uid) || await uidByUin(params.user_id);
      if (!uid) throw new Error('cannot resolve user ' + text(params.user_id) + ' to a uid');
      const remark = text(params.remark);
      await nativeAny('getBuddyService', ['setBuddyRemark'], [{ uid: uid, remark: remark }]);
      friendsAt = 0;
      return { remark: remark };
    },
    delete_friend: async (params) => {
      const uid = text(params.user_uid) || await uidByUin(params.user_id);
      if (!uid) throw new Error('cannot resolve user ' + text(params.user_id) + ' to a uid');
      checkResult(await nativeAny('getBuddyService', ['delBuddy'], [{
        friendUid: uid,
        tempBlock: boolOf(params.block, false),
        tempBothDel: boolOf(params.delete_both, true)
      }]), 'delBuddy');
      friendsAt = 0;
      return { deleted: uid };
    },

    // -- notices (group bulletin) --------------------------------------------
    send_group_notice: async (params) => {
      const code = groupCodeOf(params.group_id);
      const content = text(params.content || params.text);
      if (!content) throw new Error('content is required');
      const psKey = await qunPskey(code);
      // picInfo is the object uploadGroupBulletinPic answers with, not a url:
      // the picture has to live on this machine because nothing here uploads
      // media over the network.
      const image = text(params.image || params.file);
      let picInfo;
      if (image) {
        const local = requireLocalFile(image, 'notice image');
        const uploaded = checkResult(await nativeCall('getGroupService',
          'uploadGroupBulletinPic', [code, psKey, local]), 'uploadGroupBulletinPic');
        picInfo = uploaded.picInfo || (uploaded.result && uploaded.result.picInfo);
        if (!picInfo) throw new Error('uploadGroupBulletinPic returned no picInfo');
      }
      const value = checkResult(await nativeCall('getGroupService', 'publishGroupBulletin', [
        code, psKey, {
          // qun.qq.com expects the body percent-encoded; NapCat encodes here too.
          text: encodeURI(content),
          picInfo: picInfo,
          oldFeedsId: text(params.notice_id),
          pinned: boolOf(params.pinned, false) ? 1 : 0,
          confirmRequired: boolOf(params.confirm_required, false) ? 1 : 0
        }
      ]), 'publishGroupBulletin');
      return {
        notice_id: text(value.fid || value.feedsId || value.feedId ||
          (value.result && (value.result.fid || value.result.feedsId))),
        group_id: Number(code) || 0
      };
    },
    list_group_notices: async (params) => {
      const code = groupCodeOf(params.group_id);
      const psKey = await qunPskey(code);
      const start = Math.max(0, Number(params.start_index) || 0);
      const count = Math.max(1, Math.min(Number(params.count) || 20, 50));
      // Diagnostic for the argument layout: the build only asserts that it
      // takes four arguments, and the page pair could just as well be
      // (limit, start) or want strings/numbers. Scalars only, so a wrong guess
      // throws instead of corrupting anything, and `debug` dumps each push.
      const variant = text(params.arg_variant) || 'base';
      const argsFor = () => {
        if (variant === 'swap') return [code, psKey, count, start];
        if (variant === 'num') return [Number(code), psKey, start, count];
        if (variant === 'str-page') return [code, psKey, text(start), text(count)];
        if (variant === 'one') return [code, psKey, 1, count];
        return [code, psKey, start, count];
      };
      await ensureGroupListener();
      // Checked against the real client: the signature is
      // getGroupBulletinList(groupCode, pskey, pageStart, pageLimit) - exactly
      // four arguments (fewer trips a NAPI "needs 4 arguments" assertion) - and
      // the answer arrives on onGetGroupBulletinListResult('0', '0', envelope),
      // where the envelope is the qun.qq.com board itself: {srvCode, role,
      // feeds, inst, nextIndex, server_time, …}. Two things NapCat does that we
      // must too: the "send to new members" bulletins only ever appear in
      // `inst`, and the envelope's own groupCode is always '0', so nothing in
      // this callback can be matched against the requested group.
      const envelopeOf = (args) => (args || []).find(Array.isArray) ?
        { list: (args || []).find(Array.isArray) } :
        ((args || []).find(item => item && typeof item === 'object') || null);
      const value = await nativeCallWithEvent({
        service: 'getGroupService',
        method: 'getGroupBulletinList',
        args: argsFor(),
        listener: 'group',
        callback: 'onGetGroupBulletinListResult',
        label: 'getGroupBulletinList',
        timeoutMs: 3000,
        debug: boolOf(params.debug, false),
        allowTimeoutReturn: true,
        // A group without bulletins pushes an empty board - never a failure.
        tolerateNoCallback: true,
        matches: () => true,
        // The client also pushes an all-default envelope on its own, and
        // reading that as the answer is how a real board ends up looking empty:
        // keep waiting while nothing in the envelope says the server answered.
        enough: (args) => {
          const env = envelopeOf(args);
          if (!env) return false;
          const feeds = Array.isArray(env.feeds) ? env.feeds.length : 0;
          const inst = Array.isArray(env.inst) ? env.inst.length : 0;
          return feeds > 0 || inst > 0 || text(env.server_time) !== '0';
        },
        pick: (args, returned) => {
          const source = envelopeOf(args) || returned || {};
          const found = source.feeds || source.feedList || source.list || source.items ||
            (Array.isArray(source) ? source : null);
          const list = Array.isArray(found) ? found : [];
          // `inst` carries the "发给新成员" bulletins: on the board, but in no
          // feed list. Append them after the feeds and drop repeats by id.
          const extra = Array.isArray(source.inst) ? source.inst : [];
          const seen = new Set(list.map((feed) => text(feed && (feed.u || feed.fid))));
          const merged = list.slice();
          for (const feed of extra) {
            const id = text(feed && (feed.u || feed.fid));
            if (seen.has(id)) continue;
            seen.add(id);
            merged.push(feed);
          }
          if (!found) {
            // Nothing that looks like a list at all - print the envelope so the
            // guessed shape can be checked instead of reporting an empty page.
            appendLog('getGroupBulletinList: no feed list ' + describe(args) + ' returned ' + describe(returned));
          } else if (!Array.isArray(found)) {
            appendLog('getGroupBulletinList: feed field is not an array ' + describe(found));
          } else if (list.length === 0 && extra.length === 0) {
            // A group with no bulletins is a normal answer, not a broken one;
            // srvCode 0 with a readable role is what an empty board looks like.
            appendLog('getGroupBulletinList: 0 feeds (srvCode=' + text(source.srvCode) +
              ', role=' + text(source.role) + ', server_time=' + text(source.server_time) + ')');
          }
          return {
            group_id: Number(code) || 0,
            start_index: start,
            next_index: Number(source.nextIndex) || (start + merged.length),
            server_time: Number(source.server_time) || 0,
            // Whether the envelope can be told apart from the all-default push
            // the client emits by itself. Measured: with a bulletin really on the
            // board every one of four argument layouts still returned
            // srvCode 0 / feeds [] / inst [] / server_time '0', so an unanswered
            // read is not the same thing as an empty board and the protocol layer
            // has to be able to say so.
            answered: merged.length > 0 || text(source.server_time) !== '0',
            notices: merged.map((feed) => normalizeNoticeFeed(feed, list.indexOf(feed) < 0))
          };
        }
      });
      return value;
    },
    delete_group_notice: async (params) => {
      const code = groupCodeOf(params.group_id);
      const noticeId = text(params.notice_id || params.id);
      if (!noticeId) throw new Error('notice_id is required');
      const psKey = await qunPskey(code);
      await nativeCall('getGroupService', 'deleteGroupBulletin', [code, psKey, noticeId]);
      return { group_id: Number(code) || 0, notice_id: noticeId, deleted: true };
    },

    // -- message level -------------------------------------------------------
    mark_read: async (params) => {
      let peer;
      if (params.message_id && !params.group_id && !params.user_id) {
        const event = cachedMessage(params.message_id, 'mark_read');
        peer = peerOf(event.chat_type, event.peer_uid);
      } else {
        peer = await destPeer(params);
      }
      const value = await nativeAny('getMsgService',
        ['setMsgRead', 'setGroupMsgRead', 'setBuddyMsgRead'], [peer]);
      return {
        chat_type: peer.chatType,
        peer_uid: peer.peerUid,
        marked: true,
        result: value && value.result
      };
    },
    set_msg_reaction: async (params) => {
      const event = cachedMessage(params.message_id, 'set_msg_reaction');
      const msgSeq = text(params.sequence || event.sequence);
      if (!msgSeq) {
        throw new Error('message ' + event.message_id + ' has no kernel sequence in the cache');
      }
      const emojiId = text(params.emoji_id || params.key);
      if (!emojiId) throw new Error('emoji_id is required');
      // The small face ids are short numbers, the premium ones are long
      // strings - that is what QQ's emojiType argument selects.
      const emojiType = text(params.emoji_type) || (emojiId.length > 3 ? '2' : '1');
      const set = boolOf(params.set, true);
      checkResult(await nativeCall('getMsgService', 'setMsgEmojiLikes',
        [peerOf(event.chat_type, event.peer_uid), msgSeq, emojiId, emojiType, set]),
        'setMsgEmojiLikes');
      return {
        message_id: event.message_id,
        sequence: msgSeq,
        emoji_id: emojiId,
        emoji_type: emojiType,
        set: set
      };
    },
    set_essence: async (params) => {
      const event = cachedMessage(params.message_id, 'set_essence');
      const code = text(params.group_id || event.group_id || event.peer_uin);
      const seq = Number(params.sequence || event.sequence) || 0;
      const random = Number(params.random || event.random) || 0;
      if (!code || !seq || !random) {
        throw new Error('message ' + event.message_id +
          ' is missing group/sequence/random; essence only works on messages the bridge saw live');
      }
      // addGroupEssence/removeGroupEssence both take numbers here, unlike the
      // string ids the message cache is keyed by.
      const cmd = { groupCode: code, msgRandom: random, msgSeq: seq };
      const set = boolOf(params.set, true);
      await nativeCall('getGroupService', set ? 'addGroupEssence' : 'removeGroupEssence', [cmd]);
      return { message_id: event.message_id, group_id: Number(code) || 0, essence: set };
    },
    forward_message: async (params) => {
      const event = cachedMessage(params.message_id, 'forward_message');
      const ids = [text(event.message_id)].concat(
        (Array.isArray(params.message_ids) ? params.message_ids : []).map(text).filter(Boolean));
      const src = peerOf(event.chat_type, event.peer_uid);
      const dest = await destPeer(params);
      // forwardMsg does not answer with the id it created. Snapshot the cache,
      // then take the first outgoing message the kernel adds into the
      // destination chat - that is the forwarded one.
      const known = new Set(messageCache.keys());
      const waiter = waitKernelEvent('msg.onAddSendMsg', (args) => {
        const raw = (args || [])[0];
        if (!raw) return false;
        return text(raw.peerUid) === dest.peerUid &&
          (Number(raw.chatType) || 0) === dest.chatType &&
          !known.has(text(raw.msgId));
      }, 6000);
      const value = await nativeCall('getMsgService', 'forwardMsg',
        [ids, src, [dest], new Map()]);
      checkResult(value, 'forwardMsg');
      const added = await waiter;
      const raw = (added || [])[0];
      return {
        message_ids: ids,
        message_id: text(raw && raw.msgId),
        sequence: text(raw && raw.msgSeq),
        random: text(raw && raw.msgRandom),
        from: { chat_type: src.chatType, peer_uid: src.peerUid },
        to: { chat_type: dest.chatType, peer_uid: dest.peerUid }
      };
    },
    send_like: async (params) => {
      const code = params.group_id ? text(params.group_id) : '';
      const uid = code
        ? await memberUidForGroup(code, params.user_id)
        : await uidByUin(params.user_id);
      if (!uid) throw new Error('cannot resolve user ' + text(params.user_id) + ' to a uid');
      const times = Math.max(1, Math.min(Number(params.times || params.count) || 1, 10));
      checkResult(await nativeCall('getProfileLikeService', 'setBuddyProfileLike', [{
        friendUid: uid,
        sourceId: 71,
        doLikeCount: times,
        doLikeTollCount: 0
      }]), 'setBuddyProfileLike');
      return { user_id: Number(params.user_id) || 0, times: times };
    },

    // -- group files (read, delete, folders) ---------------------------------
    get_group_files: async (params) => {
      const code = groupCodeOf(params.group_id);
      const folderId = text(params.folder_id) || '/';
      const count = Math.max(1, Math.min(Number(params.count) || 50, 100));
      const startIndex = Math.max(0, Number(params.start_index) || 0);
      return await nativeCallWithEvent({
        service: 'getRichMediaService',
        method: 'getGroupFileList',
        args: [code, {
          sortType: Number(params.sort_type) || 2,
          fileCount: count,
          startIndex: startIndex,
          sortOrder: Number(params.sort_order) || 2,
          showOnlinedocFolder: 0,
          folderId: folderId
        }],
        listener: 'msg',
        callback: 'onGroupFileInfoUpdate',
        label: 'getGroupFileList',
        timeoutMs: 10000,
        // onGroupFileInfoUpdate carries one GroupFileInfoUpdateParamType whose
        // item array is the page; there is no group code to match on.
        matches: (args) => {
          const info = (args || []).find(item => item && (item.item || item.allFileCount !== undefined));
          return !!info;
        },
        pick: (args) => {
          const info = (args || []).find(item => item && (item.item || item.allFileCount !== undefined)) || {};
          const list = info.item || info.fileGroupInfoList || [];
          return {
            group_id: Number(code) || 0,
            folder_id: folderId,
            is_end: !!info.isEnd,
            total: Number(info.allFileCount) || list.length,
            next_index: Number(info.nextIndex) || (startIndex + list.length),
            files: (Array.isArray(list) ? list : []).map(normalizeGroupFileItem)
          };
        }
      });
    },
    get_group_file_count: async (params) => {
      const code = groupCodeOf(params.group_id);
      const value = await nativeCall('getRichMediaService', 'batchGetGroupFileCount', [[code]]);
      // The answer is two parallel arrays: groupCodes[i] with groupFileCounts[i].
      const codes = (value && value.groupCodes) || [];
      const counts = (value && value.groupFileCounts) || [];
      let count = 0;
      if (codes.length) {
        const index = codes.findIndex(item => text(item) === code);
        count = index >= 0 ? Number(counts[index]) || 0 : Number(counts[0]) || 0;
      }
      return { group_id: Number(code) || 0, file_count: count };
    },
    delete_group_file: async (params) => {
      const code = groupCodeOf(params.group_id);
      const fileId = text(params.file_id || params.id);
      if (!fileId) throw new Error('file_id is required');
      let busId = Number(params.busid) || 0;
      if (!busId) {
        try {
          const info = await nativeCall('getRichMediaService', 'getGroupFileInfo', [code, fileId]);
          const found = (info && info.groupFileInfoResult) || info || {};
          busId = Number((found.fileInfo || found).busId) || 0;
        } catch (error) {
          appendLog('getGroupFileInfo: ' + (error && error.message || error));
        }
      }
      if (!busId) {
        throw new Error('cannot resolve the busId of file ' + fileId +
          '; pass busid from get_group_files');
      }
      checkFileResult(await nativeCall('getRichMediaService', 'deleteGroupFile',
        [code, [busId], [fileId]]), 'deleteGroupFile');
      return { group_id: Number(code) || 0, file_id: fileId, busid: busId, deleted: true };
    },
    create_group_folder: async (params) => {
      const code = groupCodeOf(params.group_id);
      const name = text(params.folder_name || params.name);
      if (!name) throw new Error('folder_name is required');
      const value = checkFileResult(await nativeCall('getRichMediaService',
        'createGroupFolder', [code, name]), 'createGroupFolder');
      const items = (value && value.resultWithGroupItem && value.resultWithGroupItem.groupItem) || [];
      let folderId = text((items[0] && items[0].folderInfo && items[0].folderInfo.folderId) ||
        (value && value.folderId));
      if (!folderId) {
        // Measured: on this build createGroupFolder answers with a plain result
        // and no id at all, so the caller would have no way to undo its own
        // folder. Read the root listing and take the folder we just named.
        for (let attempt = 0; attempt < 2 && !folderId; attempt++) {
          if (attempt) await delay(1000);
          try {
            const listed = await actions.get_group_files({ group_id: code, folder_id: '/', count: 100 });
            const hit = (listed.files || []).find((item) => item.kind === 'folder' &&
              text(item.folder_name) === name);
            if (hit) folderId = text(hit.folder_id);
          } catch (error) {
            appendLog('createGroupFolder lookup failed: ' + (error && error.message || error));
          }
        }
        if (!folderId) appendLog('createGroupFolder: created "' + name + '" but found no folder id in the root listing');
      }
      return {
        group_id: Number(code) || 0,
        folder_id: folderId,
        folder_name: name
      };
    },
    delete_group_folder: async (params) => {
      const code = groupCodeOf(params.group_id);
      const folderId = text(params.folder_id || params.id);
      if (!folderId) throw new Error('folder_id is required');
      checkFileResult(await nativeCall('getRichMediaService',
        'deleteGroupFolder', [code, folderId]), 'deleteGroupFolder');
      return { group_id: Number(code) || 0, folder_id: folderId, deleted: true };
    },
    rename_group_folder: async (params) => {
      const code = groupCodeOf(params.group_id);
      const folderId = text(params.folder_id || params.id);
      const name = text(params.folder_name || params.name);
      if (!folderId || !name) throw new Error('folder_id and folder_name are required');
      checkFileResult(await nativeCall('getRichMediaService',
        'renameGroupFolder', [code, folderId, name]), 'renameGroupFolder');
      return { group_id: Number(code) || 0, folder_id: folderId, folder_name: name };
    },
    move_group_file: async (params) => {
      const code = groupCodeOf(params.group_id);
      const fileId = text(params.file_id || params.id);
      if (!fileId) throw new Error('file_id is required');
      const target = text(pickFirst(params, ['target_parent_directory', 'folder_id',
        'target_folder_id', 'new_folder_id']));
      const current = text(pickFirst(params, ['current_parent_directory', 'parent_folder_id'])) || '/';
      if (!target) throw new Error('target folder is required');
      const busId = Number(params.busid) || 0;
      if (!busId) throw new Error('busid is required; take it from get_group_files');
      checkFileResult(await nativeCall('getRichMediaService', 'moveGroupFile',
        [code, [busId], [fileId], current, target]), 'moveGroupFile');
      return { group_id: Number(code) || 0, file_id: fileId, folder_id: target, moved: true };
    },

    // -- text tools ----------------------------------------------------------
    translate_text: async (params) => {
      const words = (Array.isArray(params.words) ? params.words : [params.text])
        .map(text).filter(Boolean);
      if (!words.length) throw new Error('text is required');
      const value = checkResult(await nativeCall('getRichMediaService',
        'translateEnWordToZn', [words]), 'translateEnWordToZn');
      // translateEnWordToZn answers with the translated words in the same order.
      const results = value.words || value.trlWordList || value.cnWordList || [];
      return {
        words: words.map((word, index) => ({
          source: word,
          target: text(Array.isArray(results) ? results[index] : results[word])
        }))
      };
    },
    ocr_image: async (params) => {
      const file = requireLocalFile(pickFirst(params, ['image', 'file', 'path']), 'image');
      // wantWinScreenOCR is the Windows client's own OCR, and it reads a file
      // from this machine rather than a url.
      const value = checkResult(await nativeCall('getNodeMiscService',
        'wantWinScreenOCR', [file]), 'wantWinScreenOCR');
      const result = value.result || value;
      // Measured: the kernel answers with the recognised boxes themselves -
      // [{text, pt1, pt2, pt3, pt4, charBox, score}] - not a string and not a
      // `words` list, so the text has to be assembled from the boxes.
      const boxes = Array.isArray(result) ? result :
        (Array.isArray(result.result) ? result.result :
          (Array.isArray(result.results) ? result.results : []));
      const words = boxes.map((box) => text(box && box.text)).filter(Boolean);
      const text_ = text(result && result.text) || text(result && result.ocrResult) || words.join('\n');
      return { text: text_, words, result };
    },

    emit_test: async (params) => {
      const now = Math.floor(Date.now() / 1000);
      const body = text(params.text) || 'synthetic event';
      const groupId = Number(params.group_id || 0) || 0;
      const uin = Number(params.uin || 0) || 10001;
      const uid = text(params.uid) || 'u_synthetic';
      const elements = [{ type: 'text', data: { text: body } }];
      if (groupId && params.at_self) {
        // Lets the protocol tests exercise the uid -> QQ-number mapping of an
        // incoming @ without waiting for a real person to send one.
        elements.unshift({
          type: 'at',
          data: { qq: String(currentSelf().uin), uid: currentSelf().uid, name: currentSelf().nick }
        });
      }
      if (params.image_md5) {
        // Same idea for pictures: run a raw picElement through the real
        // conversion so the local-path lookup is exercised end to end. No file
        // is created and nothing is sent - only the path resolution runs.
        elements.push(convertElement({
          elementType: 2,
          picElement: {
            md5HexStr: text(params.image_md5),
            fileName: text(params.image_name) || (text(params.image_md5) + '.jpg'),
            fileSize: text(params.image_size) || '0',
            picWidth: Number(params.image_width) || 0,
            picHeight: Number(params.image_height) || 0,
            summary: ''
          }
        }));
      }
      const event = {
        type: 'message', direction: 'incoming',
        message_id: 'synthetic-' + Date.now(), time: now,
        self_id: currentSelf().uin,
        chat_type: groupId ? 2 : 1, is_group: !!groupId,
        peer_uid: groupId ? 'u_synthetic_group' : uid,
        peer_uin: groupId ? String(groupId) : String(uin),
        peer_name: groupId ? 'SyntheticGroup' : 'Synthetic',
        group_id: groupId,
        sender: { uin: uin, uid: uid, nick: 'Synthetic', card: '', remark: '' },
        elements: elements,
        raw_message: elements.map(segmentText).join(''),
        display: '[' + (groupId ? '群 ' + groupId : '私聊') + '] Synthetic(' + uin + '): ' + body,
        synthetic: true
      };
      emit(event);
      return event;
    }
  };

  async function dispatch(action, params) {
    const handler = actions[action];
    if (!handler) throw new Error('unknown action: ' + action);
    return await handler(params || {});
  }

  function status() {
    return {
      installed: true, port: currentPort, connected: sockReady,
      generation: generation, buffered: buffered.length, self: currentSelf(),
      bridge_version: bridgeVersion, token_set: !!bridgeToken,
      qq_version: bridgeQQVersion,
      appid: bridgeAppid,
      qua: bridgeQua,
      headless: bridgeHeadless,
      capabilities: bridgeCapabilities(),
      limits: writeLimits(),
      listener_id: state.listeners.msg || '',
      last_error: lastError, last_event_at: lastEventAt,
      counters: Object.assign({}, counters),
      wrapper: state.wrapperPath || '',
      session: !!state.session,
      cache: { messages: messageCache.size, friends: (friendsCache || []).length, groups: (groupsCache || []).length }
    };
  }

  function setPort(value) {
    if (!isCurrent()) return;
    const next = Number(value) || 47840;
    if (next === currentPort) {
      if (sock) return;
      connect();
      return;
    }
    currentPort = next;
    const old = sock;
    sock = null;
    sockReady = false;
    if (old) {
      try { old.destroy(); } catch (e) { /* ignore */ }
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connect();
  }

  connect();
  // `qqinject --launch` can install this bridge as soon as QQ's app main module
  // exists, which may be before the kernel session is created. Retry the native
  // listener instead of failing the whole install; every action calls session()
  // again, so a late listener only delays events, not requests.
  let listenerTimer = null;
  function startListener() {
    try {
      ensureListener();
      listenerTimer = null;
    } catch (e) {
      appendLog('listener wait: ' + (e && e.message || e));
      listenerTimer = setTimeout(startListener, 1000);
      if (listenerTimer.unref) listenerTimer.unref();
    }
  }
  startListener();
  // Group and buddy listeners carry the request notices, so they are registered
  // at install rather than waiting for the first action that needs them. Each
  // action calls the same helper again, so a failure here only delays them.
  ensureGroupListener().catch(() => { /* retried per call */ });
  ensureBuddyListener().catch(() => { /* retried per call */ });
  // Wrapping Tray.prototype at install means the first tray update after the
  // injection captures QQ's instance, even if nobody asks for it.
  try { installTrayHook(); } catch (e) { appendLog('tray hook: ' + (e && e.message || e)); }
  ensureSelf().then(() => sendHelloWhenReady()).catch(() => { /* login may not be ready */ });

  function dispose() {
    try {
      if (state.listeners.msg && state.msgService) {
        state.msgService.removeKernelMsgListener(state.listeners.msg);
      }
      if (state.listeners.group) {
        groupService().removeKernelGroupListener(state.listeners.group);
      }
      if (state.listeners.buddy) {
        getSessionService('getBuddyService')
          .removeKernelBuddyListener(state.listeners.buddy);
      }
    } catch (e) { /* already gone */ }
    state.listeners.registered = false;
    state.listeners.msg = '';
    state.listeners.group = '';
    state.listeners.buddy = '';
    state.listeners.object = null;
    if (helloRetryTimer) {
      clearTimeout(helloRetryTimer);
      helloRetryTimer = null;
    }
    if (listenerTimer) {
      clearTimeout(listenerTimer);
      listenerTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    for (const timer of stagedFallbackTimers) clearTimeout(timer);
    stagedFallbackTimers.clear();
    // A disposed bridge must not leave a caller waiting for an echo that can
    // never arrive; resolve the waiters and let the new generation take over.
    for (const [, pending] of pendingSends) {
      clearTimeout(pending.timer);
      try { pending.resolve(null); } catch (e) { /* ignore */ }
    }
    pendingSends.clear();
    sentPeers.clear();
    messageCache.clear();
    emittedOutgoing.clear();
    emittedRecall.clear();
    emittedMembership.clear();
    memberCache.clear();
    friendsCache = null;
    groupsCache = null;
    selfPromise = null;
    buffered = [];
    inboundBuffer = '';
    if (sock) {
      try { sock.destroy(); } catch (e) { /* ignore */ }
    }
    sock = null;
    sockReady = false;
    if (state.instance === debugHandle) state.instance = null;
    if (globalThis.__qqhookProtoBridge === debugHandle) {
      try { delete globalThis.__qqhookProtoBridge; } catch (e) { /* ignore */ }
    }
  }

  // One non-enumerable debug handle. Everything mutable (session, wrapper,
  // listener ids, window/tray state) lives behind `state` on this object or in
  // the symbol-keyed store; no other __qqhook* global is written by the bridge.
  const debugHandle = {
    setPort: setPort,
    port: currentPort,
    logFile: logFile,
    connected: () => sockReady,
    status: status,
    reconnect: () => setPort(currentPort),
    dispatch: dispatch,
    emit: emit,
    dispose: dispose,
    state: state
  };
  state.instance = debugHandle;
  Object.defineProperty(globalThis, '__qqhookProtoBridge', {
    value: debugHandle, configurable: true, writable: true, enumerable: false
  });

  const listenerState = state.listeners.registered
    ? 'listener id=' + (state.listeners.msg || '?')
    : 'listener pending (waiting for session)';
  return 'proto bridge installed: ' + listenerState + ' port=' + currentPort +
    ' connected=' + sockReady + ' wrapper=' + (state.wrapperPath || '?');
})()
