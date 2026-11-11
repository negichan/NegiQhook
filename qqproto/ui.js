'use strict';

// Debug page for the protocol endpoint. It lives in the endpoint process on
// purpose: the logs, the kernel events, what each protocol actually delivered to
// its clients, and the API calls are all already here, so the page needs no
// second port to poll and no token juggling.
//
//   createDebugUi({ host, port, logger, getState, getCatalog, invoke })
//
//     GET  /              the page (ui.html, cached at start)
//     GET  /api/snapshot  live state for the header cards
//     GET  /api/catalog   every known method, grouped by protocol
//     POST /api/call      { protocol, method, params, via } -> invoke()
//     POST /api/emit-test { text, uin, uid, group_id } -> synthetic inbound message
//     GET  /api/stream    SSE: log lines, kernel events, deliveries, calls
//
// Bind is loopback unless the caller passed --allow-public. POSTs additionally
// require the x-debug-call header: a cross-site page cannot set it without a
// CORS preflight, and this server does not grant one.

const fs = require('fs');
const http = require('http');
const path = require('path');

const MAX_LOG = 600;
const MAX_EVENT = 300;
const MAX_CALL = 120;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
const CALL_HEADER = 'x-debug-call';

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        const value = JSON.parse(text);
        resolve(value && typeof value === 'object' ? value : {});
      } catch (error) {
        reject(new Error('invalid JSON body: ' + error.message));
      }
    });
    request.on('error', reject);
  });
}

function push(list, item, max) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
  return item;
}

// One JSON call over loopback, used by index.js to reach the endpoint's own
// public HTTP surface (so the page exercises the same path a bot framework does).
function httpJson(url, { method = 'GET', headers = {}, body, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const started = Date.now();
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: { ...headers }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = text;
        try { data = text ? JSON.parse(text) : null; } catch (e) { /* plain text */ }
        const ok = response.statusCode >= 200 && response.statusCode < 400;
        resolve({
          ok,
          status: response.statusCode,
          ms: Date.now() - started,
          // the protocol's own error text, so the page does not show a bare 500
          error: ok ? undefined : (data && typeof data === 'object' && data.message) || undefined,
          data
        });
      });
    });
    request.on('error', (error) => resolve({
      ok: false, status: 0, ms: Date.now() - started, error: error.message, data: null
    }));
    request.setTimeout(timeout, () => {
      request.destroy(new Error(`timed out after ${timeout}ms`));
    });
    if (body !== undefined && body !== null) request.write(typeof body === 'string' ? body : JSON.stringify(body));
    request.end();
  });
}

function createDebugUi({ host, port, logger, getState, getCatalog, getHealth, invoke, chat, emitTest, configApi }) {
  const log = logger || console;
  const page = (file) => {
    try {
      return fs.readFileSync(path.join(__dirname, file), 'utf8');
    } catch (error) {
      log.error(`debug ui: ${file} is missing, the page will not render:`, error.message);
      return `<!doctype html><meta charset=utf-8><h1>${file} missing</h1>`;
    }
  };
  const html = page('ui.html');
  const chatHtml = page('chat.html');
  const configHtml = page('config.html');

  const logs = [];
  const events = [];
  const calls = [];
  const clients = new Set();
  let seq = 0;
  let counters = { kernelEvents: 0, delivered: 0, apiCalls: 0, chatSends: 0, chatRecalls: 0 };

  const send = (client, kind, data) => {
    if (client.writableEnded) return;
    try {
      client.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) { /* the browser is already gone; the next write will clean up */ }
  };

  const broadcast = (kind, data) => {
    for (const client of clients) send(client, kind, data);
  };

  const contentTypeOf = (file) => {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.bmp') return 'image/bmp';
    if (ext === '.mp4') return 'video/mp4';
    if (ext === '.slk' || ext === '.amr' || ext === '.wav' || ext === '.silk') return 'audio/wav';
    return 'application/octet-stream';
  };

  // Received pictures only exist as files on this machine, so previewing them
  // means serving one local path back. It is limited to real files under the
  // allowed roots (the repo and the user profile by default, extended with
  // --ui-allow-dir) - the page can never ask for an arbitrary file.
  const serveLocalFile = (filePath, response) => {
    const reply = (status, value) => {
      const body = Buffer.from(JSON.stringify(value), 'utf8');
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
      });
      response.end(body);
    };
    if (!filePath || !path.isAbsolute(filePath)) {
      reply(400, { ok: false, error: '需要一个绝对路径' });
      return;
    }
    let real = '';
    let stat = null;
    try {
      real = fs.realpathSync(filePath);
      stat = fs.statSync(real);
    } catch (error) {
      reply(404, { ok: false, error: '文件不存在' });
      return;
    }
    if (!stat.isFile()) {
      reply(404, { ok: false, error: '不是文件' });
      return;
    }
    const roots = (chat && chat.mediaRoots) || [];
    const inside = roots.some((root) => {
      let resolved = '';
      try { resolved = fs.realpathSync(root); } catch (e) { resolved = path.resolve(root); }
      const lower = real.toLowerCase();
      const prefix = resolved.toLowerCase().endsWith(path.sep)
        ? resolved.toLowerCase() : resolved.toLowerCase() + path.sep.toLowerCase();
      return lower.startsWith(prefix);
    });
    if (!inside) {
      reply(403, { ok: false, error: '不在允许预览的目录里（可用 --ui-allow-dir 增加）', roots });
      return;
    }
    if (stat.size > MAX_FILE) {
      reply(413, { ok: false, error: `文件太大（${stat.size} 字节，上限 ${MAX_FILE}）` });
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentTypeOf(real),
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    const stream = fs.createReadStream(real);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  };

  const route = async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    const done = (status, type, body) => {
      const buffer = Buffer.from(body || '', 'utf8');
      response.writeHead(status, {
        'Content-Type': type,
        'Content-Length': buffer.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(buffer);
    };
    const json = (status, value) => done(status, 'application/json; charset=utf-8', JSON.stringify(value));

    if (request.method === 'OPTIONS') {
      // Deliberately no Access-Control-Allow-* : a cross-site page cannot reach
      // the call endpoint, see the header comment.
      done(405, 'text/plain; charset=utf-8', 'method not allowed\n');
      return;
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      done(200, 'text/html; charset=utf-8', html);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      // 200 only when the account is connected and not kicked; a supervisor can
      // poll this locally, and a browser visiting it sees the same JSON.
      const health = getHealth ? getHealth() : { ok: false, error: 'no health provider' };
      json(health && health.ok ? 200 : 503, health);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/snapshot') {
      json(200, {
        ...(getState ? getState() : {}),
        counters,
        at: new Date().toISOString()
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/catalog') {
      json(200, getCatalog ? getCatalog() : { satori: [], onebot: [] });
      return;
    }

    // ------------------------------------------------------------ network config
    // The /config page reads the persistent config and saves it back. Saving is
    // a state change like a chat send: same-origin header plus allow_write in
    // the body, so neither a stray POST nor a cross-site page can rebind ports.
    if (request.method === 'GET' && (url.pathname === '/config' || url.pathname === '/config/')) {
      done(200, 'text/html; charset=utf-8', configHtml);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/network-config') {
      if (!configApi) {
        json(503, { ok: false, error: 'no config provider' });
        return;
      }
      json(200, configApi.get());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/network-config') {
      if (request.headers[CALL_HEADER] !== '1') {
        json(403, { ok: false, error: 'missing ' + CALL_HEADER + ': 1 header (this page is same-origin only)' });
        return;
      }
      if (!configApi) {
        json(503, { ok: false, error: 'no config provider' });
        return;
      }
      let payload;
      try {
        payload = await readJson(request);
      } catch (error) {
        json(/too large/.test(error.message) ? 413 : 400, { ok: false, error: error.message });
        return;
      }
      if (payload.allow_write !== true) {
        json(403, { ok: false, error: '需要 allow_write: true（页面上的「允许修改」开关）' });
        return;
      }
      try {
        const result = await configApi.save(payload.config, payload.revision);
        broadcast('config', { at: new Date().toISOString(), ...result });
        json(200, { ok: true, data: result, view: configApi.get() });
      } catch (error) {
        log.warn('network config save rejected:', error.message);
        json(error.status === 409 ? 409 : 400, { ok: false, error: error.message });
      }
      return;
    }

    // ------------------------------------------------------------ chat surface
    // The chat page is a local tool, so it goes straight through the same core
    // both protocols use, rather than pretending to be a bot framework.
    if (request.method === 'GET' && (url.pathname === '/chat' || url.pathname === '/chat/')) {
      done(200, 'text/html; charset=utf-8', chatHtml);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/chats') {
      try {
        json(200, chat && chat.getChats ? await chat.getChats() : { error: 'no chat provider' });
      } catch (error) {
        json(500, { error: error.message });
      }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/conversation') {
      try {
        const messages = chat && chat.getConversation
          ? await chat.getConversation(url.searchParams.get('channel') || '',
            Number(url.searchParams.get('limit')) || 50)
          : { error: 'no chat provider' };
        json(200, messages);
      } catch (error) {
        json(500, { error: error.message });
      }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/file') {
      serveLocalFile(url.searchParams.get('path') || '', response);
      return;
    }
    if (request.method === 'POST' &&
        (url.pathname === '/api/chat/send' || url.pathname === '/api/chat/recall')) {
      if (request.headers[CALL_HEADER] !== '1') {
        json(403, { ok: false, error: 'missing ' + CALL_HEADER + ': 1 header' });
        return;
      }
      let payload;
      try {
        payload = await readJson(request);
      } catch (error) {
        json(400, { ok: false, error: error.message });
        return;
      }
      // Writes are opt-in on the wire, not just in the page: the body has to say
      // allow_write, so a stray POST or a script cannot put a message into QQ.
      if (payload.allow_write !== true) {
        json(403, { ok: false, error: '需要 allow_write: true（页面上的「允许写操作」开关）' });
        return;
      }
      const isSend = url.pathname.endsWith('/send');
      const kind = isSend ? 'send' : 'recall';
      let result;
      try {
        result = isSend ? await chat.send(payload) : await chat.recall(payload);
      } catch (error) {
        log.warn(`chat ${kind} failed:`, error.message);
        json(400, { ok: false, error: error.message });
        return;
      }
      counters[isSend ? 'chatSends' : 'chatRecalls']++;
      // Same record shape as a protocol call, so the debug page's stream shows it
      // without a special case.
      const record = {
        id: ++seq,
        protocol: 'chat',
        via: 'core',
        method: kind,
        params: payload,
        kind,
        channel: payload.channel || payload.target || '',
        at: new Date().toISOString(),
        ok: true,
        status: 200,
        data: result
      };
      push(calls, record, MAX_CALL);
      broadcast('call', record);
      json(200, { ok: true, data: result });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/emit-test') {
      // Debug helper: feeds a synthetic inbound message through the bridge so a
      // framework can be tested without a second phone/account. It never sends
      // by itself - if a bot answers, the answer is a real message and the
      // caller is responsible for it.
      if (request.headers[CALL_HEADER] !== '1') {
        json(403, { ok: false, error: 'missing ' + CALL_HEADER + ': 1 header (this page is same-origin only)' });
        return;
      }
      if (typeof emitTest !== 'function') {
        json(503, { ok: false, error: 'no bridge connected' });
        return;
      }
      let payload;
      try {
        payload = await readJson(request);
      } catch (error) {
        json(/too large/.test(error.message) ? 413 : 400, { ok: false, error: error.message });
        return;
      }
      try {
        const event = await emitTest({
          text: payload.text || 'synthetic event',
          uin: payload.uin,
          uid: payload.uid,
          group_id: payload.group_id,
          at_self: !!payload.at_self
        });
        const record = {
          id: ++seq,
          protocol: 'bridge',
          via: 'emit_test',
          method: 'emit_test',
          params: payload,
          at: new Date().toISOString(),
          ok: true,
          status: 200,
          data: event
        };
        push(calls, record, MAX_CALL);
        broadcast('call', record);
        json(200, { ok: true, data: event });
      } catch (error) {
        json(500, { ok: false, error: error.message });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/call') {
      if (request.headers[CALL_HEADER] !== '1') {
        json(403, { ok: false, error: 'missing ' + CALL_HEADER + ': 1 header (this page is same-origin only)' });
        return;
      }
      let payload;
      try {
        payload = await readJson(request);
      } catch (error) {
        json(/too large/.test(error.message) ? 413 : 400, { ok: false, error: error.message });
        return;
      }
      const { protocol = 'satori', method = '', params = {}, via = 'http' } = payload || {};
      if (!method) {
        json(400, { ok: false, error: 'method is required' });
        return;
      }
      const record = {
        id: ++seq,
        protocol,
        via,
        method,
        params,
        at: new Date().toISOString()
      };
      counters.apiCalls++;
      let result;
      try {
        result = await invoke({ protocol, method, params, via });
      } catch (error) {
        result = { ok: false, status: 0, error: error.message, data: null, ms: 0 };
      }
      Object.assign(record, result);
      push(calls, record, MAX_CALL);
      broadcast('call', record);
      log.debug(`ui ${protocol}${via === 'internal' ? ' (internal)' : ''} ${method} -> ` +
        `${record.status || 'no status'} ${record.ok ? 'ok' : 'failed'} ${record.ms || 0}ms`);
      json(200, record);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/stream') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      response.write(': connected\n\n');
      clients.add(response);
      send(response, 'hello', {
        ...(getState ? getState() : {}),
        counters,
        logLevel: 'taps see every level; the console may be filtered'
      });
      for (const item of logs) send(response, 'log', item);
      for (const item of events) send(response, 'ev', { kind: 'kernel', ...item });
      for (const item of calls) send(response, 'call', item);
      const ping = setInterval(() => {
        try { response.write(': ping\n\n'); } catch (e) { /* closed */ }
      }, 20000);
      request.on('close', () => {
        clearInterval(ping);
        clients.delete(response);
      });
      return;
    }
    json(404, { message: 'not found' });
  };

  const server = http.createServer((request, response) => {
    // One await per route, so a throw has to land somewhere useful instead of
    // becoming an unhandled rejection in the endpoint process.
    route(request, response).catch((error) => {
      log.error('debug ui request failed:', request.method, request.url, error.message);
      if (!response.headersSent) {
        try {
          response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        } catch (e) { /* ignore */ }
      }
      response.end(JSON.stringify({ ok: false, error: error.message }));
    });
  });

  server.on('error', (error) => {
    log.error('debug ui server error:', error.message);
  });

  const keepAlive = setInterval(() => broadcast('beat', { at: Date.now() }), 25000);
  keepAlive.unref?.();

  return {
    server,
    // Every log line lands here, including debug lines the console threshold hid.
    onLog(level, text, line, source) {
      push(logs, { at: line.slice(0, 19), level, source: source || '', text }, MAX_LOG);
      broadcast('log', logs[logs.length - 1]);
    },
    onKernelEvent(event) {
      counters.kernelEvents++;
      // The chat page wants the same normalised shape the conversation API
      // returns, so the endpoint's describe() rides along in the record.
      let chatMessage = null;
      if (chat && typeof chat.describe === 'function' && event && event.type === 'message') {
        try { chatMessage = chat.describe(event); } catch (e) { /* rendering must not break the log */ }
      }
      const item = {
        id: ++seq,
        at: new Date().toISOString().slice(11, 23),
        type: event && event.type,
        brief: describeEvent(event),
        chatMessage,
        data: event
      };
      push(events, item, MAX_EVENT);
      broadcast('ev', { kind: 'kernel', ...item });
      return item;
    },
    onDelivery({ protocol, channel, body }) {
      counters.delivered++;
      broadcast('ev', {
        kind: 'delivery',
        id: ++seq,
        at: new Date().toISOString().slice(11, 23),
        protocol,
        channel,
        brief: describeDelivery(protocol, body),
        data: body
      });
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve(`http://${host}:${port}/`);
        });
      });
    },
    close() {
      clearInterval(keepAlive);
      for (const client of clients) {
        try { client.end(); } catch (e) { /* ignore */ }
      }
      clients.clear();
      try { server.close(); } catch (e) { /* ignore */ }
    }
  };
}

function describeEvent(event) {
  if (!event || !event.type) return '';
  if (event.type === 'message') {
    const who = event.sender ? (event.sender.card || event.sender.nick || event.sender.uin) : '';
    const out = String(event.direction || '').startsWith('out');
    const where = event.is_group ? '群 ' + event.group_id : '私聊 ' + (event.user_id || event.peer_uin || '');
    return `${out ? '发' : '收'} ${where} ${who ? who + ': ' : ''}` +
      String(event.raw_message || '').slice(0, 80);
  }
  if (event.type === 'offline') return 'QQ 侧离线';
  return event.sub_type ? `${event.type} / ${event.sub_type}` : event.type;
}

function describeDelivery(protocol, body) {
  if (!body) return '';
  if (protocol === 'onebot') {
    const post = body.post_type || '';
    if (post === 'message' || post === 'message_sent') {
      return `${post === 'message_sent' ? '自发 ' : ''}${body.message_type === 'group' ? '群 ' + body.group_id : '私聊 ' + (body.user_id || '')} ` +
        String(body.raw_message || '').slice(0, 80);
    }
    return `${post} ${body.meta_event_type || body.notice_type || body.request_type || ''}`.trim();
  }
  return `${body.type || ''} ${body.sub_type || ''}`.trim();
}

module.exports = { createDebugUi, httpJson, CALL_HEADER };
