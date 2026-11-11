// QQ -> local TCP event bridge (runs inside QQ's Node main process).
//
// Installed by: qqinject.exe --listen (sent as base64 to the `jseval` command).
// Design notes:
//   * wrapper.node is already mapped into QQ; process.dlopen() only gives us a
//     second NAPI view of the same module (same trick NapCat uses).
//   * NodeIQQNTWrapperSession.getNTWrapperSession('nt_1') returns the session
//     QQ itself created, so we never read the message database.
//   * Callbacks arrive on the thread that owns Node's loop; we keep the socket
//     write asynchronous and never block the loop.
(() => {
  'use strict';
  const main = process.mainModule;
  const req = main && main.require ? main.require.bind(main) :
    (process.getBuiltinModule ? process.getBuiltinModule.bind(process) : null);
  if (!req) throw new Error('no require available');
  const fs = req('fs');
  const path = req('path');
  const net = req('net');

  const requestedPort = Number(globalThis.__qqhookEventPort || 47821) || 47821;
  const logFile = path.join(process.env.TEMP || 'C:/Windows/Temp', 'qqhook_events.log');

  const previous = globalThis.__qqhookBridge;
  if (previous) {
    previous.setPort(requestedPort);
    return 'bridge already installed; port=' + requestedPort +
      ' connected=' + previous.connected() + ' status=' + JSON.stringify(previous.status());
  }

  let currentPort = requestedPort;
  let sock = null;
  let sockReady = false;
  let buffered = [];
  let reconnectTimer = null;
  let lastError = '';
  let lastEventAt = 0;
  const counters = { recv: 0, send: 0, recvFile: 0, synthetic: 0, errors: 0, dropped: 0 };

  function appendLog(line) {
    try {
      const st = fs.statSync(logFile);
      if (st.size > 8 * 1024 * 1024) fs.renameSync(logFile, logFile + '.1');
    } catch (e) { /* first write */ }
    try { fs.appendFileSync(logFile, line + '\n'); } catch (e) { /* best effort */ }
  }

  function sendLine(line) {
    if (sock && sockReady) {
      try {
        sock.write(line + '\n');
        return;
      } catch (e) {
        lastError = 'write: ' + (e && e.message || e);
        counters.errors++;
      }
    }
    if (buffered.length < 500) buffered.push(line); else counters.dropped++;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 2000);
  }

  function connect() {
    if (sock) return;
    let socket = null;
    try {
      socket = net.connect({ host: '127.0.0.1', port: currentPort });
      sock = socket;
      socket.setNoDelay(true);
      socket.on('connect', () => {
        if (sock !== socket) {
          try { socket.destroy(); } catch (e) { /* ignore */ }
          return;
        }
        sockReady = true;
        lastError = '';
        const pending = buffered;
        buffered = [];
        for (const line of pending) {
          try { socket.write(line + '\n'); } catch (e) { /* ignore */ }
        }
      });
      socket.on('error', (e) => {
        if (sock === socket) {
          lastError = String(e && e.message || e);
        }
      });
      socket.on('close', () => {
        // A forced reconnect already replaced `sock`; ignore stale close events.
        if (sock !== socket) return;
        sockReady = false;
        sock = null;
        scheduleReconnect();
      });
    } catch (e) {
      lastError = String(e && e.message || e);
      sock = null;
      sockReady = false;
      scheduleReconnect();
    }
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

  function applyLoginList(result) {
    const list = (result && result.LocalLoginInfoList) || [];
    const self = list.find(item => item && item.isUserLogin) ||
      list.find(item => item && item.isAutoLogin) || list[0];
    if (self && self.uin) {
      globalThis.__qqhookSelfUin = Number(self.uin) || 0;
      globalThis.__qqhookSelfUid = self.uid || '';
      globalThis.__qqhookSelfNick = self.nickName || '';
    }
  }

  // self_id is not part of RawMessage; resolve it once from the login list.
  function resolveSelf() {
    try {
      const wrapper = wrapperModule();
      const cls = wrapper.NodeIKernelLoginService;
      const service = cls && typeof cls.get === 'function' ? cls.get() : null;
      if (!service || typeof service.getLoginList !== 'function') return;
      const result = service.getLoginList();
      if (result && typeof result.then === 'function') {
        result.then(applyLoginList).catch(() => { /* not logged in yet */ });
      } else {
        applyLoginList(result);
      }
    } catch (e) { /* best effort */ }
  }

  const PRIVATE_CHAT_TYPES = new Set([1, 99, 100, 101, 102, 103, 104, 106, 107, 108, 109, 110, 111, 112, 117, 118, 119, 131, 132, 201]);

  function text(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  function emptyId(value) {
    const s = text(value);
    return s === '' || /^0+$/.test(s);
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
      return { type: 'at', data: { qq: all ? 'all' : (atUin || atUid), name: name } };
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
        return { type: 'image', data: {
          file: text(pic.fileName), url: text(pic.originImageUrl),
          file_size: Number(pic.fileSize) || 0, md5: text(pic.md5HexStr),
          file_uuid: text(pic.fileUuid), width: Number(pic.picWidth) || 0,
          height: Number(pic.picHeight) || 0, summary: text(pic.summary)
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
      case 8:
        return { type: 'gray_tip', data: {} };
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

  function buildEvent(raw, kind) {
    const message = raw || {};
    const elements = Array.isArray(message.elements) ? message.elements : [];
    const segments = elements.map(convertElement);
    const chatType = Number(message.chatType) || 0;
    const isGroup = chatType === 2;
    const messageType = isGroup ? 'group' : (PRIVATE_CHAT_TYPES.has(chatType) ? 'private' : 'other');
    const user = Number(message.senderUin || 0) || 0;
    const event = {
      post_type: kind === 'send' ? 'message_sent' : 'message',
      message_type: messageType,
      sub_type: kind === 'send' ? 'self' : 'normal',
      message_id: text(message.msgId),
      time: Number(message.msgTime) || Math.floor(Date.now() / 1000),
      self_id: Number(globalThis.__qqhookSelfUin || 0) || 0,
      user_id: user,
      chat_type: chatType,
      peer_uin: text(message.peerUin),
      peer_name: text(message.peerName),
      sender: {
        user_id: user,
        nickname: text(message.sendNickName),
        card: text(message.sendMemberName),
        remark: text(message.sendRemarkName),
        uid: text(message.senderUid)
      },
      message: segments,
      raw_message: segments.map(segmentText).join(''),
      synthetic: false
    };
    if (isGroup) event.group_id = Number(message.peerUin || 0) || 0;
    if (message.sourceType !== undefined) event.source_type = message.sourceType;
    const who = event.sender.card || event.sender.nickname || String(user);
    event.display = '[' + (isGroup ? '群 ' + event.group_id : '私聊') + '] ' +
      who + '(' + user + '): ' + event.raw_message;
    return event;
  }

  function emitEvent(event) {
    lastEventAt = Date.now();
    const line = JSON.stringify(event);
    appendLog(line);
    sendLine(line);
    return event;
  }

  function handle(kind, payload) {
    try {
      const list = Array.isArray(payload) ? payload : (payload ? [payload] : []);
      for (const raw of list) {
        if (kind === 'recv') counters.recv++;
        else if (kind === 'send') counters.send++;
        else if (kind === 'recvFile') counters.recvFile++;
        emitEvent(buildEvent(raw, kind === 'send' ? 'send' : 'recv'));
      }
    } catch (e) {
      counters.errors++;
      lastError = String(e && e.stack || e);
      appendLog(JSON.stringify({ t: new Date().toISOString(), error: lastError }));
    }
  }

  function ensureListener() {
    const alive = session();
    const service = alive.getMsgService();
    if (!service) throw new Error('getMsgService returned nothing');
    globalThis.__qqhookMsgService = service;
    if (globalThis.__qqhookBridgeListenerRegistered) {
      return 'already registered id=' + (globalThis.__qqhookBridgeListenerId || '?');
    }

    const listener = new Proxy({}, {
      get: (target, prop) => {
        const key = String(prop);
        if (key === 'onRecvMsg') return (msgs) => handle('recv', msgs);
        if (key === 'onAddSendMsg') return (msg) => handle('send', msg);
        if (key === 'onRecvOnlineFileMsg') return (msgs) => handle('recvFile', msgs);
        if (key === 'onKickedOffLine') return (info) => emitEvent({
          post_type: 'notice', notice_type: 'offline', payload: info || {},
          display: '[系统] 账号被踢下线', synthetic: false, time: Math.floor(Date.now() / 1000)
        });
        if (typeof target[key] !== 'undefined') return target[key];
        return function () { /* native may probe optional callbacks */ };
      }
    });
    const id = service.addKernelMsgListener(listener);
    globalThis.__qqhookBridgeListener = listener;
    globalThis.__qqhookBridgeListenerId = id === undefined || id === null ? '' : String(id);
    globalThis.__qqhookBridgeListenerRegistered = true;
    return 'registered id=' + (globalThis.__qqhookBridgeListenerId || '?');
  }

  // Removes the listener we registered last time and registers this closure
  // again. Useful after updating the parsing code without restarting QQ.
  function reinstallListener() {
    try {
      const service = session().getMsgService();
      const id = globalThis.__qqhookBridgeListenerId;
      if (service && id) service.removeKernelMsgListener(id);
    } catch (e) { /* old id may already be gone */ }
    globalThis.__qqhookBridgeListenerRegistered = false;
    globalThis.__qqhookBridgeListenerId = '';
    return ensureListener();
  }

  function selfTest() {
    const now = Math.floor(Date.now() / 1000);
    const base = {
      chatType: 1, peerUin: '10001', peerName: 'TestFriend',
      senderUin: '10001', sendNickName: 'TestFriend', sendMemberName: '',
      sendRemarkName: '', senderUid: 'u_test_friend',
      msgTime: String(now), msgId: 'synthetic-' + Date.now(), msgSeq: '0'
    };
    const cases = [
      Object.assign({}, base, {
        elements: [{ elementType: 1, textElement: { content: 'hello from a synthetic private text message', atType: 0, atUid: '', atNtUid: '' } }]
      }),
      Object.assign({}, base, {
        chatType: 2, peerUin: '20002', peerName: 'TestGroup',
        senderUin: '30003', sendNickName: 'GroupMate', sendMemberName: 'GroupCard',
        elements: [
          { elementType: 7, replyElement: { replyMsgId: '999', senderUin: '30003', sourceMsgText: 'original' } },
          { elementType: 1, textElement: { content: 'got it ', atType: 0, atUid: '', atNtUid: '' } },
          { elementType: 1, textElement: { content: '@GroupMate', atType: 1, atUid: '30003', atNtUid: 'u_group_mate' } },
          { elementType: 1, textElement: { content: ' look', atType: 0, atUid: '', atNtUid: '' } },
          { elementType: 2, picElement: { fileName: 'demo.png', fileSize: 12345, md5HexStr: 'd41d8cd98f00b204e9800998ecf8427e', fileUuid: 'uuid-demo', picWidth: 640, picHeight: 480, summary: '[image]' } },
          { elementType: 6, faceElement: { faceIndex: 14, faceText: '/smile' } }
        ]
      }),
      Object.assign({}, base, {
        chatType: 2, peerUin: '20002', peerName: 'TestGroup',
        senderUin: '40004', sendNickName: 'VoiceGuy',
        elements: [
          { elementType: 1, textElement: { content: '@all', atType: 2, atUid: 'all', atNtUid: 'all' } },
          { elementType: 1, textElement: { content: ' meeting now', atType: 0, atUid: '', atNtUid: '' } },
          { elementType: 4, pttElement: { fileName: 'voice.amr', duration: 3, text: '' } }
        ]
      })
    ];
    for (const raw of cases) {
      const event = buildEvent(raw, 'recv');
      event.synthetic = true;
      counters.synthetic++;
      emitEvent(event);
    }
    return 'self-test emitted ' + cases.length + ' synthetic events; port=' + currentPort + ' connected=' + sockReady;
  }

  connect();
  const registration = ensureListener();
  resolveSelf();
  const bridge = {
    setPort: (value) => {
      const next = Number(value) || 47821;
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
    },
    port: currentPort,
    logFile: logFile,
    connected: () => sockReady,
    status: () => ({
      installed: true, port: currentPort, connected: sockReady,
      buffered: buffered.length, listener: !!globalThis.__qqhookBridgeListenerRegistered,
      listener_id: globalThis.__qqhookBridgeListenerId || '',
      lastError: lastError, lastEventAt: lastEventAt,
      counters: Object.assign({}, counters),
      wrapper: globalThis.__qqhookWrapperPath || '',
      session: !!globalThis.__qqhookSession,
      self_id: Number(globalThis.__qqhookSelfUin || 0) || 0,
      self_nick: globalThis.__qqhookSelfNick || ''
    }),
    selfTest: selfTest,
    reinstallListener: reinstallListener,
    emit: (event) => emitEvent(event),
    reconnect: () => {
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
  };
  globalThis.__qqhookBridge = bridge;
  return 'bridge installed: ' + registration + ' port=' + currentPort +
    ' connected=' + sockReady + ' wrapper=' + (globalThis.__qqhookWrapperPath || '?');
})()
