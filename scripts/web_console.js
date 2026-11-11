// Local QQ test console: friend list + private text send + live incoming feed.
//
// Runs inside QQ's Node main process (installed through `qqinject --console`).
// The HTTP server binds to 127.0.0.1 only and every /api request needs the
// random token printed by the injector.
(() => {
  'use strict';
  const main = process.mainModule;
  const req = main && main.require ? main.require.bind(main) :
    (process.getBuiltinModule ? process.getBuiltinModule.bind(process) : null);
  if (!req) throw new Error('no require available');
  const fs = req('fs');
  const path = req('path');
  const http = req('http');
  const crypto = req('crypto');

  const port = Number(globalThis.__qqhookConsolePort || 47830) || 47830;
  const token = String(globalThis.__qqhookConsoleToken || '');
  const html = String(globalThis.__qqhookConsoleHtml || '');
  const logFile = path.join(process.env.TEMP || 'C:/Windows/Temp', 'qqhook_console.log');

  function appendLog(message) {
    try {
      fs.appendFileSync(logFile, new Date().toISOString() + ' ' + message + '\n');
    } catch (e) { /* best effort */ }
  }

  const state = {
    port: port,
    token: token,
    html: html,
    startedAt: Date.now(),
    server: null,
    listenerId: '',
    sseClients: new Set(),
    waiters: new Map(),
    friends: null,
    friendsAt: 0,
    selfPromise: null,
    heartbeat: null
  };

  const previous = globalThis.__qqhookConsole;
  if (previous) {
    if (previous.port === port) {
      previous.setToken(token);
      previous.setHtml(html);
      return 'console already running at http://127.0.0.1:' + port + '/?token=' + token;
    }
    try { previous.stop(); } catch (e) { /* ignore */ }
    setTimeout(() => {
      try { start(); } catch (e) { appendLog('restart: ' + (e && e.stack || e)); }
    }, 500);
    return 'console moving to http://127.0.0.1:' + port + '/?token=' + token;
  }

  function wrapperModule() {
    if (globalThis.__qqhookWrapper) return globalThis.__qqhookWrapper;
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
    globalThis.__qqhookWrapper = mod.exports;
    globalThis.__qqhookWrapperPath = file;
    return mod.exports;
  }

  function session() {
    if (globalThis.__qqhookSession) return globalThis.__qqhookSession;
    const wrapper = wrapperModule();
    const cls = wrapper.NodeIQQNTWrapperSession;
    if (!cls || typeof cls.getNTWrapperSession !== 'function') {
      throw new Error('NodeIQQNTWrapperSession.getNTWrapperSession is missing');
    }
    const value = cls.getNTWrapperSession('nt_1');
    if (!value) throw new Error("session 'nt_1' not created yet");
    globalThis.__qqhookSession = value;
    return value;
  }

  function ensureSelf() {
    if (globalThis.__qqhookSelfUin && globalThis.__qqhookSelfUid) {
      return Promise.resolve({
        uin: Number(globalThis.__qqhookSelfUin) || 0,
        uid: globalThis.__qqhookSelfUid || '',
        nick: globalThis.__qqhookSelfNick || ''
      });
    }
    if (state.selfPromise) return state.selfPromise;
    state.selfPromise = new Promise((resolve) => {
      const finish = (self) => {
        if (self && self.uin) {
          globalThis.__qqhookSelfUin = Number(self.uin) || 0;
          globalThis.__qqhookSelfUid = self.uid || '';
          globalThis.__qqhookSelfNick = self.nickName || self.nick || '';
        }
        resolve({
          uin: Number(globalThis.__qqhookSelfUin) || 0,
          uid: globalThis.__qqhookSelfUid || '',
          nick: globalThis.__qqhookSelfNick || ''
        });
      };
      try {
        const wrapper = wrapperModule();
        const cls = wrapper.NodeIKernelLoginService;
        const service = cls && typeof cls.get === 'function' ? cls.get() : null;
        if (!service || typeof service.getLoginList !== 'function') {
          finish(null);
          return;
        }
        const result = service.getLoginList();
        const apply = (value) => {
          const list = (value && value.LocalLoginInfoList) || [];
          finish(list.find(item => item && item.isUserLogin) ||
            list.find(item => item && item.isAutoLogin) || list[0] || null);
        };
        if (result && typeof result.then === 'function') {
          result.then(apply).catch(() => finish(null));
        } else {
          apply(result);
        }
      } catch (e) {
        appendLog('ensureSelf: ' + (e && e.stack || e));
        finish(null);
      }
    });
    return state.selfPromise;
  }

  function textOf(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  function previewOf(raw) {
    const parts = [];
    for (const el of (raw.elements || [])) {
      const type = Number(el.elementType);
      if (type === 1) {
        const te = el.textElement || {};
        parts.push(textOf(te.content));
      } else if (type === 2) {
        parts.push('[图片]');
      } else if (type === 3) {
        parts.push('[文件]');
      } else if (type === 4) {
        parts.push('[语音]');
      } else if (type === 5) {
        parts.push('[视频]');
      } else if (type === 6) {
        parts.push('[表情]');
      } else if (type === 7) {
        /* reply source is not part of the body */
      } else if (type === 10) {
        parts.push('[卡片]');
      } else if (type === 11) {
        parts.push('[表情]');
      } else if (type === 16) {
        parts.push('[聊天记录]');
      } else {
        parts.push('[消息]');
      }
    }
    return parts.join('');
  }

  async function getFriends(force) {
    const now = Date.now();
    if (!force && state.friends && now - state.friendsAt < 30000) {
      return state.friends;
    }
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
      if ((self.uin && String(self.uin) === uin) || (self.uid && self.uid === uid)) {
        continue;
      }
      const nick = core.nick || '';
      const remark = core.remark || '';
      friends.push({
        uid: uid,
        uin: uin,
        nick: nick,
        remark: remark,
        display: remark || nick || uin
      });
    }
    friends.sort((a, b) => a.display.localeCompare(b.display, 'zh-CN'));
    state.friends = friends;
    state.friendsAt = now;
    return friends;
  }

  function broadcast(payload) {
    const frame = 'data: ' + JSON.stringify(payload) + '\n\n';
    for (const client of state.sseClients) {
      try { client.write(frame); } catch (e) { /* client went away */ }
    }
  }

  function createWaiter(clientId, timeoutMs) {
    let resolveFn = null;
    let rejectFn = null;
    let timer = null;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
      timer = setTimeout(() => {
        state.waiters.delete(clientId);
        reject(new Error('timeout waiting for send confirmation'));
      }, timeoutMs);
    });
    state.waiters.set(clientId, {
      resolve: (value) => {
        clearTimeout(timer);
        state.waiters.delete(clientId);
        resolveFn(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        state.waiters.delete(clientId);
        rejectFn(error);
      },
      cancel: () => {
        clearTimeout(timer);
        state.waiters.delete(clientId);
        rejectFn(new Error('cancelled'));
      }
    });
    return {
      promise: promise,
      cancel: () => {
        clearTimeout(timer);
        state.waiters.delete(clientId);
        rejectFn(new Error('cancelled'));
      }
    };
  }

  function handleSentRecord(raw) {
    if (!raw) return;
    const clientId = textOf(raw.guildId);
    const waiter = clientId ? state.waiters.get(clientId) : null;
    if (waiter && Number(raw.sendStatus) === 2) {
      waiter.resolve(raw);
      return;
    }
    // A message sent from another QQ window/device still shows up here.
    if (Number(raw.chatType) === 1) {
      broadcast({
        type: 'message',
        direction: 'out',
        message_id: textOf(raw.msgId),
        chat_type: Number(raw.chatType) || 0,
        peer_uin: textOf(raw.peerUin),
        peer_name: textOf(raw.peerName),
        sender_uin: textOf(raw.senderUin),
        sender_name: textOf(raw.sendNickName),
        text: previewOf(raw),
        time: Number(raw.msgTime) || Math.floor(Date.now() / 1000)
      });
    }
  }

  function handleIncoming(raw) {
    if (!raw) return;
    const selfUin = Number(globalThis.__qqhookSelfUin) || 0;
    const outgoing = selfUin && Number(raw.senderUin) === selfUin;
    broadcast({
      type: 'message',
      direction: outgoing ? 'out' : 'in',
      message_id: textOf(raw.msgId),
      chat_type: Number(raw.chatType) || 0,
      peer_uin: textOf(raw.peerUin),
      peer_name: textOf(raw.peerName),
      sender_uin: textOf(raw.senderUin),
      sender_name: textOf(raw.sendNickName || raw.sendMemberName),
      text: previewOf(raw),
      time: Number(raw.msgTime) || Math.floor(Date.now() / 1000)
    });
  }

  function installKernelListener() {
    const alive = session();
    const msgService = alive.getMsgService();
    if (!msgService) throw new Error('getMsgService returned nothing');
    const listener = new Proxy({}, {
      get: (target, prop) => {
        const key = String(prop);
        if (key === 'onRecvMsg') return (msgs) => {
          (Array.isArray(msgs) ? msgs : (msgs ? [msgs] : [])).forEach(handleIncoming);
        };
        if (key === 'onAddSendMsg') return (msg) => handleSentRecord(msg);
        if (key === 'onMsgInfoListUpdate') return (msgs) => {
          (Array.isArray(msgs) ? msgs : (msgs ? [msgs] : [])).forEach(handleSentRecord);
        };
        if (key === 'onKickedOffLine') return (info) => broadcast({
          type: 'notice',
          notice: 'offline',
          message: (info && (info.tipsTitle || info.tipsDesc)) || '账号被踢下线',
          time: Math.floor(Date.now() / 1000)
        });
        if (typeof target[key] !== 'undefined') return target[key];
        return function () { /* optional native callback */ };
      }
    });
    state.listenerId = String(msgService.addKernelMsgListener(listener) || '');
    state.msgService = msgService;
    return state.listenerId;
  }

  function authorized(request, url) {
    const supplied = request.headers['x-auth-token'] ||
      (url && url.searchParams.get('token')) || '';
    if (!state.token || typeof supplied !== 'string' || supplied.length !== state.token.length) {
      return false;
    }
    try {
      return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(state.token));
    } catch (e) {
      return false;
    }
  }

  function originAllowed(request) {
    const origin = request.headers.origin;
    if (!origin) return true;
    return origin === 'http://127.0.0.1:' + port ||
      origin === 'http://localhost:' + port;
  }

  function sendJson(response, status, body) {
    const data = JSON.stringify(body);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(data);
  }

  function readBody(request, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error('body too large'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
    });
  }

  async function handleSend(request, response) {
    if (!originAllowed(request)) {
      sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' });
      return;
    }
    let body = null;
    try {
      const raw = await readBody(request, 64 * 1024);
      body = JSON.parse(raw || '{}');
    } catch (e) {
      sendJson(response, 400, { ok: false, error: 'invalid JSON: ' + (e && e.message || e) });
      return;
    }
    const uid = textOf(body.uid).trim();
    const content = textOf(body.text);
    if (!uid) {
      sendJson(response, 400, { ok: false, error: 'uid is required' });
      return;
    }
    if (!content.trim()) {
      sendJson(response, 400, { ok: false, error: 'text is required' });
      return;
    }
    if (content.length > 4000) {
      sendJson(response, 400, { ok: false, error: 'text is longer than 4000 characters' });
      return;
    }

    try {
      let friends = await getFriends(false);
      let friend = friends.find(item => item.uid === uid);
      if (!friend) {
        friends = await getFriends(true);
        friend = friends.find(item => item.uid === uid);
      }
      if (!friend) {
        sendJson(response, 404, { ok: false, error: 'friend not found in the current buddy list' });
        return;
      }

      const alive = session();
      const msgService = alive.getMsgService();
      const serverTime = alive.getMSFService().getServerTime();
      const clientId = String(msgService.generateMsgUniqueId(1, serverTime));
      const peer = { chatType: 1, peerUid: friend.uid, guildId: clientId };
      const elements = [{
        elementType: 1,
        elementId: '',
        textElement: {
          content: content,
          atType: 0,
          atUid: '',
          atTinyId: '',
          atNtUid: ''
        }
      }];

      if (body.dry_run) {
        sendJson(response, 200, {
          ok: true, dry_run: true, client_id: clientId,
          friend: friend, peer: peer, elements: elements
        });
        return;
      }

      const waiter = createWaiter(clientId, 3000);
      let eventResult = null;
      try {
        eventResult = msgService.sendMsg('0', peer, elements, new Map());
        if (eventResult && typeof eventResult.then === 'function') {
          eventResult = await eventResult;
        }
      } catch (error) {
        waiter.cancel();
        appendLog('sendMsg threw: ' + (error && error.stack || error));
        sendJson(response, 500, { ok: false, error: 'sendMsg threw: ' + (error && error.message || error) });
        return;
      }

      const resultCode = eventResult && typeof eventResult.result === 'number'
        ? eventResult.result : undefined;
      if (resultCode !== undefined && resultCode !== 0) {
        waiter.cancel();
        sendJson(response, 502, {
          ok: false,
          error: eventResult.errMsg || ('sendMsg result=' + resultCode),
          result: eventResult
        });
        return;
      }

      try {
        const confirmed = await waiter.promise;
        broadcast({
          type: 'sent',
          client_id: clientId,
          message_id: textOf(confirmed.msgId),
          time: Number(confirmed.msgTime) || Math.floor(Date.now() / 1000)
        });
        sendJson(response, 200, {
          ok: true,
          confirmed: true,
          client_id: clientId,
          message_id: textOf(confirmed.msgId),
          friend: friend,
          result: eventResult || null
        });
      } catch (error) {
        sendJson(response, 200, {
          ok: true,
          confirmed: false,
          submitted: true,
          client_id: clientId,
          warning: '消息已提交，但未收到发送确认（可能仍已发出）',
          friend: friend,
          result: eventResult || null
        });
      }
    } catch (error) {
      appendLog('handleSend: ' + (error && error.stack || error));
      sendJson(response, 500, { ok: false, error: String(error && error.message || error) });
    }
  }

  function handleEvents(request, response, url) {
    if (!authorized(request, url)) {
      response.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('unauthorized');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    response.write('retry: 3000\n\n');
    response.write('event: ready\ndata: ' + JSON.stringify({ type: 'ready', time: Date.now() }) + '\n\n');
    state.sseClients.add(response);
    request.on('close', () => {
      state.sseClients.delete(response);
    });
  }

  async function handleRequest(request, response) {
    let url = null;
    try {
      url = new URL(request.url || '/', 'http://127.0.0.1:' + port);
    } catch (e) {
      sendJson(response, 400, { ok: false, error: 'bad url' });
      return;
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(state.html || '<!doctype html><meta charset="utf-8"><h1>console.html missing</h1>');
      return;
    }

    if (!authorized(request, url)) {
      sendJson(response, 401, { ok: false, error: 'unauthorized: missing or bad token' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/status') {
      const self = await ensureSelf();
      let friends = state.friends;
      if (!friends) {
        try { friends = await getFriends(false); } catch (e) { friends = null; }
      }
      sendJson(response, 200, {
        ok: true,
        self: self,
        port: port,
        uptime_ms: Date.now() - state.startedAt,
        listener_id: state.listenerId,
        friends: friends ? friends.length : null,
        bridge: globalThis.__qqhookBridge ? globalThis.__qqhookBridge.status() : null,
        console_log: logFile
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/friends') {
      try {
        const friends = await getFriends(url.searchParams.get('refresh') === '1');
        const self = await ensureSelf();
        sendJson(response, 200, { ok: true, self: self, friends: friends });
      } catch (error) {
        appendLog('friends: ' + (error && error.stack || error));
        sendJson(response, 500, { ok: false, error: String(error && error.message || error) });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/events') {
      handleEvents(request, response, url);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/send') {
      await handleSend(request, response);
      return;
    }

    sendJson(response, 404, { ok: false, error: 'not found' });
  }

  function start() {
    const server = http.createServer((request, response) => {
      handleRequest(request, response).catch((error) => {
        appendLog('request: ' + (error && error.stack || error));
        try {
          sendJson(response, 500, { ok: false, error: String(error && error.message || error) });
        } catch (e) { /* headers may already be sent */ }
      });
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.on('error', (error) => {
      appendLog('server error: ' + (error && error.stack || error));
    });
    server.listen(port, '127.0.0.1', () => {
      appendLog('console listening on 127.0.0.1:' + port);
    });
    state.server = server;
    state.heartbeat = setInterval(() => {
      for (const client of state.sseClients) {
        try { client.write(': ping\n\n'); } catch (e) { /* ignore */ }
      }
    }, 25000);

    const listenerId = installKernelListener();
    appendLog('kernel listener id=' + listenerId);

    const api = {
      port: port,
      token: token,
      server: server,
      get listenerId() { return state.listenerId; },
      setToken: (value) => { state.token = String(value || ''); },
      setHtml: (value) => { state.html = String(value || ''); },
      status: () => ({
        running: !!state.server, port: port, listener_id: state.listenerId,
        sse_clients: state.sseClients.size,
        friends: state.friends ? state.friends.length : null,
        uptime_ms: Date.now() - state.startedAt
      }),
      friends: (force) => getFriends(!!force),
      stop: () => {
        try { clearInterval(state.heartbeat); } catch (e) { /* ignore */ }
        for (const client of state.sseClients) {
          try { client.end(); } catch (e) { /* ignore */ }
        }
        state.sseClients.clear();
        if (state.listenerId) {
          try {
            const alive = session();
            alive.getMsgService().removeKernelMsgListener(state.listenerId);
          } catch (e) { /* ignore */ }
          state.listenerId = '';
        }
        for (const waiter of state.waiters.values()) {
          try { waiter.cancel(); } catch (e) { /* ignore */ }
        }
        state.waiters.clear();
        try { server.close(); } catch (e) { /* ignore */ }
        delete globalThis.__qqhookConsole;
        appendLog('console stopped');
      }
    };
    globalThis.__qqhookConsole = api;
    return 'console listening on http://127.0.0.1:' + port + '/?token=' + token +
      ' (listener id ' + listenerId + ')';
  }

  return start();
})()
