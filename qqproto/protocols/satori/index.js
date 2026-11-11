'use strict';

const path = require('path');
const { WsServer } = require('../../lib/ws');
const { createHandlers, MethodError } = require('./methods');
const { saveUploads } = require('./upload');
const {
  PLATFORM,
  selfDto,
  messageCreated,
  messageDeleted,
  requestEvent,
  memberChanged,
  sendEvent
} = require('./convert');

const WS_PATH = '/v1/events';
const MAX_BODY = 2 * 1024 * 1024;
// Enough history for a client that drops for a few seconds; a longer outage
// gets a fresh READY and whatever arrived since, not a guarantee of no gaps.
const HISTORY = 200;

class SatoriProtocol {
  constructor({ token, core, store, logger, uploadDir, getHealth }) {
    this.token = token || '';
    this.core = core;
    this.store = store;
    this.getHealth = getHealth || null;
    this.log = logger;
    this.sn = 0;
    this.ws = null;
    this.history = [];
    // 'new' before the bridge ever connects, 'up' while it is connected, 'down'
    // after it dropped - that difference is what Status reports.
    this.link = 'new';
    this.uploadDir = uploadDir || path.resolve(__dirname, '..', '..', 'data', 'upload');
    const { handlers, features } = createHandlers({ core, store, protocol: this });
    this.methods = handlers;
    this.features = features;
  }

  statusOf() {
    if (this.store.offline) return 3; // DISCONNECT: QQ kicked us off
    if (this.link === 'up') return 1; // ONLINE
    if (this.link === 'down') return 4; // RECONNECT: the bridge is coming back
    return 2; // CONNECT: waiting for the first hello
  }

  login() {
    return {
      sn: 1,
      adapter: 'qq-hook',
      platform: PLATFORM,
      status: this.statusOf(),
      features: this.features,
      user: selfDto(this.store)
    };
  }

  setLink(state) {
    this.link = state;
  }

  // Called when the bridge comes or goes: clients see a login-updated with the
  // new status instead of having to poll login.get.
  loginUpdated() {
    this._broadcast({ type: 'login-updated', login: this.login() });
  }

  attach(httpServer) {
    this.ws = new WsServer(httpServer, {
      path: WS_PATH,
      // Satori clients authenticate in IDENTIFY, not on the handshake: NoneBot's
      // adapter opens the socket with no headers and sends the token in the
      // IDENTIFY body. Only an explicitly wrong credential is refused here;
      // the token itself is checked below.
      verifyClient: (request, url) => this.upgradeAuthorized(request, url)
    });
    this.ws.on('connection', (connection, request, url) => this._accept(connection, request, url));
    return this;
  }

  close() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  onEvent(event) {
    if (!event || !event.type) return;
    if (event.type === 'message') {
      // Our own sends echo back from the kernel; Satori calls that `send`. If it
      // were broadcast as message-created a bot would answer itself.
      if (event.direction === 'outgoing') {
        this._broadcast(sendEvent(event, this.store));
        return;
      }
      this._broadcast(messageCreated(event, this.store));
      return;
    }
    if (event.type === 'message_deleted') {
      const deleted = messageDeleted(event, this.store);
      // Without a cached author or an operator there is no valid MessageEvent
      // for the official adapters; dropping a broken frame is cleaner than
      // handing them one that fails their schema.
      if (deleted) this._broadcast(deleted);
      return;
    }
    if (event.type === 'request') {
      this._broadcast(requestEvent(event));
      return;
    }
    if (event.type === 'group_member') {
      this._broadcast(memberChanged(event, this.store));
      return;
    }
    if (event.type === 'offline') {
      this.loginUpdated();
      return;
    }
  }

  _broadcast(fields) {
    const clients = this.ws ? this.ws.clients.size : 0;
    const body = {
      type: fields.type,
      login: this.login(),
      selfId: String(this.store.self.uin || ''),
      platform: PLATFORM,
      timestamp: Date.now(),
      ...fields
    };
    // sn stays assigned at broadcast time: a sequence number must not be spent on
    // a frame nobody received.
    if (typeof this.onActivity === 'function') {
      try {
        this.onActivity(clients ? { sn: this.sn + 1, ...body } : body, clients);
      } catch (e) { /* the debug page never breaks a broadcast */ }
    }
    if (!this.ws || clients === 0) return;
    const frame = { op: 0, body: { sn: ++this.sn, ...body } };
    // Kept for IDENTIFY-then-replay: a client that reconnects with its last sn
    // gets the frames it missed instead of silently starting a new stream.
    this.history.push(frame);
    while (this.history.length > HISTORY) this.history.shift();
    this.ws.broadcast(JSON.stringify(frame));
  }

  _accept(connection, request, url) {
    let identified = false;
    const authorizedByUpgrade = this.authorized(request, url);
    const identifyTimer = setTimeout(() => {
      if (!identified) connection.close(1008, 'identify timeout');
    }, 10000);

    connection.on('message', (text) => {
      let frame;
      try {
        frame = JSON.parse(text);
      } catch (error) {
        connection.close(1003, 'invalid json');
        return;
      }
      if (!frame || typeof frame.op !== 'number') {
        connection.close(1003, 'invalid payload');
        return;
      }
      if (frame.op === 3) { // IDENTIFY
        const token = frame.body && frame.body.token;
        if (this.token && !authorizedByUpgrade && token !== this.token) {
          this.log.warn('satori ws IDENTIFY rejected: token does not match');
          connection.close(1008, 'invalid token');
          return;
        }
        identified = true;
        clearTimeout(identifyTimer);
        // Whether a framework actually got in is the first question the debug
        // page answers, so say it out loud instead of only moving a counter.
        this.log.info(`satori ws client identified from ${request.socket ? request.socket.remoteAddress : '?'} ` +
          `(${this.ws ? this.ws.clients.size : 0} attached)`);
        connection.on('close', () => {
          this.log.info(`satori ws client left (${this.ws ? this.ws.clients.size : 0} attached)`);
        });
        connection.send(JSON.stringify({
          op: 4, // READY
          body: {
            logins: [this.login()],
            // snake_case is what @satorijs/protocol and the NoneBot adapter read
            proxy_urls: []
          }
        }));
        // A client that still has its last sequence number gets the frames it
        // missed, in order, right after READY.
        const resumeFrom = Number(frame.body && frame.body.sn);
        if (Number.isFinite(resumeFrom) && resumeFrom >= 0) {
          const missed = this.history.filter((item) => item.body.sn > resumeFrom);
          for (const item of missed) connection.send(JSON.stringify(item));
          if (missed.length) {
            this.log.info(`satori ws resumed after sn ${resumeFrom}: ${missed.length} event(s) replayed`);
          }
        }
        return;
      }
      if (frame.op === 1) { // PING
        connection.send(JSON.stringify({ op: 2, body: {} })); // PONG
        return;
      }
      if (frame.op === 2) return; // client PONG
      // Other client opcodes are not part of the v1 client surface.
    });

    connection.on('close', () => clearTimeout(identifyTimer));
    connection.on('error', (error) => {
      this.log.debug('satori ws error:', error.message);
    });
  }

  authorized(request, url) {
    if (!this.token) return true;
    const header = request.headers.authorization || '';
    if (header === `Bearer ${this.token}`) return true;
    try {
      return url.searchParams.get('access_token') === this.token;
    } catch (error) {
      return false;
    }
  }

  // The handshake may carry nothing at all (that is what NoneBot does), so an
  // absent credential is "ask again in IDENTIFY", not a refusal. A credential
  // that is present and wrong is refused right away.
  upgradeAuthorized(request, url) {
    if (!this.token) return true;
    const header = request.headers.authorization || '';
    let query = null;
    try { query = url.searchParams.get('access_token'); } catch (error) { query = null; }
    if (!header && query === null) return true;
    return header === `Bearer ${this.token}` || query === this.token;
  }

  async handleHttp(request, response, url) {
    const pathname = url.pathname;
    // Browsers put no credentials on a preflight, so this has to answer before
    // the token check or a browser-based client can never reach /v1.
    if (request.method === 'OPTIONS') {
      this._json(response, 204, undefined);
      return;
    }
    if (pathname === '/health') {
      if (this.getHealth) {
        const health = this.getHealth();
        this._json(response, health.ok ? 200 : 503, health);
        return;
      }
      this._json(response, 200, {
        ok: true,
        bridge: this.core.rpc.connected,
        self: this.store.self,
        sn: this.sn,
        clients: this.ws ? this.ws.clients.size : 0,
        uptime_ms: Date.now() - this.store.startedAt
      });
      return;
    }
    if (pathname === '/' || pathname === '/v1') {
      this._json(response, 200, {
        name: 'qq-hook satori endpoint',
        platform: PLATFORM,
        ws: WS_PATH,
        http: '/v1/{method}',
        features: this.features
      });
      return;
    }
    if (!pathname.startsWith('/v1/')) {
      this._json(response, 404, { message: 'not found' });
      return;
    }
    if (!this.authorized(request, url)) {
      this._json(response, 401, { message: 'unauthorized' });
      return;
    }

    const method = decodeURIComponent(pathname.slice('/v1/'.length));
    const handler = this.methods[method];
    if (!handler) {
      this._json(response, 404, { message: `unknown method: ${method}` });
      return;
    }

    let params = {};
    const started = Date.now();
    try {
      // The one method whose body is not JSON: files land in qqproto/data/upload
      // and come back as file:// urls, which <img src> reads as a local path.
      if (method === 'upload.create' && request.method === 'POST' &&
          /multipart\/form-data/i.test(String(request.headers['content-type'] || ''))) {
        const urls = await saveUploads(request, this.uploadDir);
        this.log.debug(`satori upload.create -> ${urls.length} file(s) ${Date.now() - started}ms`);
        this._json(response, 200, urls);
        return;
      }
      if (request.method === 'GET') {
        for (const [key, value] of url.searchParams) {
          params[key] = value;
        }
      } else if (request.method === 'POST') {
        params = await this._readBody(request);
      } else {
        this._json(response, 405, { message: 'method not allowed' });
        return;
      }
      const data = await handler(params);
      this.log.debug(`satori ${method} -> ok ${Date.now() - started}ms`);
      this._json(response, 200, data === undefined ? null : data);
    } catch (error) {
      let status = error.status;
      if (!status) {
        if (error.code === 'unsupported_segment') status = 501;
        else if (error.code === 'not_found') status = 404;
        else if (error.code === 'untested_version') status = 403;
        else if (error.code === 'rate_limited' || error.code === 'circuit_open') status = 429;
        // The bridge words its refusals in prose ("only the owner can ban an
        // admin", "result=120101005 ... ERR_NOT_GROUP_ADMIN").
        else if (/not.?group.?admin|no.?permission|insufficient|privilege|only the owner|权限/i
          .test(String(error.message || ''))) status = 403;
        else status = 500;
      }
      if (status >= 500) this.log.error(`satori ${method} failed:`, error.message);
      else this.log.debug(`satori ${method} rejected:`, error.message);
      this._json(response, status, { message: error.message });
    }
  }

  _readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new MethodError(413, 'request body too large'));
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
        const type = String(request.headers['content-type'] || '');
        try {
          if (type.includes('application/x-www-form-urlencoded')) {
            const out = {};
            for (const [key, value] of new URLSearchParams(text)) {
              try { out[key] = JSON.parse(value); } catch (e) { out[key] = value; }
            }
            resolve(out);
            return;
          }
          const value = JSON.parse(text);
          resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
        } catch (error) {
          reject(new MethodError(400, 'invalid JSON body'));
        }
      });
      request.on('error', reject);
    });
  }

  _json(response, status, value) {
    if (response.writableEnded) return;
    const headers = {
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    };
    if (status === 204) {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    const body = Buffer.from(JSON.stringify(value === undefined ? null : value), 'utf8');
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Length'] = body.length;
    response.writeHead(status, headers);
    response.end(body);
  }
}

module.exports = { SatoriProtocol, WS_PATH, PLATFORM };
