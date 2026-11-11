'use strict';

// Minimal RFC 6455 server. QQ's Node runtime has no `ws` package, and the
// endpoint process deliberately has no npm dependencies either. This covers
// what a JSON gateway needs: upgrade, masked client frames, fragmentation,
// text/ping/pong/close. No extensions, no binary API, no compression.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 8 * 1024 * 1024;

function computeAccept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class WsConnection extends EventEmitter {
  constructor(socket, request, url, options = {}) {
    super();
    this.socket = socket;
    this.request = request;
    this.url = url;
    this.readyState = 1;
    // Clients must mask every frame they send (RFC 6455 5.1); servers must not.
    this.maskOutgoing = options.masked === true;
    // Servers use this to catch a peer that forgot to mask, which browsers and
    // most bot frameworks treat as a protocol error (close 1002).
    this.requireMasked = options.requireMasked === true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.lastActivity = Date.now();

    socket.on('data', (chunk) => {
      this.lastActivity = Date.now();
      this._onData(chunk);
    });
    socket.on('close', () => this._closed());
    socket.on('error', (error) => {
      this.emit('error', error);
      this._closed();
    });
  }

  send(text) {
    if (this.readyState !== 1) return false;
    return this._frame(0x1, Buffer.from(String(text), 'utf8'));
  }

  ping(payload = Buffer.alloc(0)) {
    if (this.readyState !== 1) return false;
    return this._frame(0x9, Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    const reasonBuffer = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    this._frame(0x8, payload);
    setTimeout(() => this.terminate(), 500).unref?.();
  }

  terminate() {
    this.readyState = 3;
    try { this.socket.destroy(); } catch (e) { /* already gone */ }
  }

  _closed() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  _frame(opcode, payload) {
    try {
      const length = payload.length;
      let header;
      if (length < 126) {
        header = Buffer.alloc(2);
        header[1] = length;
      } else if (length < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(length, 2);
      } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
      }
      header[0] = 0x80 | opcode;
      if (!this.maskOutgoing) {
        this.socket.write(Buffer.concat([header, payload]));
        return true;
      }
      // The mask bit lives in byte 1 regardless of how long the length field
      // is; setting it on the last header byte would corrupt the length.
      header[1] |= 0x80;
      const mask = crypto.randomBytes(4);
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      this.socket.write(Buffer.concat([header, mask, masked]));
      return true;
    } catch (error) {
      this.emit('error', error);
      return false;
    }
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) {
          this.close(1009, 'payload too large');
          return;
        }
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_PAYLOAD) {
        this.close(1009, 'payload too large');
        return;
      }

      let maskOffset = -1;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskOffset = offset;
        offset += 4;
      } else if (this.requireMasked) {
        this.close(1002, 'client frames must be masked');
        return;
      }
      if (this.buffer.length < offset + length) return;

      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (maskOffset >= 0) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= this.buffer[maskOffset + (i % 4)];
        }
      }
      this.buffer = this.buffer.subarray(offset + length);
      this._onFrame(fin, opcode, payload);
    }
  }

  _onFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      this.close(1000, '');
      return;
    }
    if (opcode === 0x9) {
      this._frame(0xA, payload);
      return;
    }
    if (opcode === 0xA) {
      this.emit('pong', payload);
      return;
    }
    if (opcode === 0x0) {
      this.fragments.push(payload);
      if (fin) {
        const joined = Buffer.concat(this.fragments);
        const op = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentOpcode = 0;
        this._onMessage(op, joined);
      }
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (!fin) {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        return;
      }
      this._onMessage(opcode, payload);
      return;
    }
    this.close(1003, 'unsupported opcode');
  }

  _onMessage(opcode, payload) {
    if (opcode !== 0x1) return;
    this.emit('message', payload.toString('utf8'));
  }
}

class WsServer extends EventEmitter {
  constructor(httpServer, options = {}) {
    super();
    this.httpServer = httpServer;
    this.path = options.path || '/';
    this.verifyClient = options.verifyClient || null;
    this.requireMasked = options.requireMasked === true;
    this.clients = new Set();
    this._onUpgrade = (request, socket, head) => this._handleUpgrade(request, socket, head);
    httpServer.on('upgrade', this._onUpgrade);
  }

  // path accepts a string, an array of strings, or a predicate, because OneBot
  // serves the action role on /api and the event role on everything else from
  // the same listener.
  _matches(url) {
    const path = url.pathname;
    if (typeof this.path === 'function') return Boolean(this.path(url));
    if (Array.isArray(this.path)) return this.path.some((item) => {
      return typeof item === 'function' ? Boolean(item(url)) : item === path;
    });
    return path === this.path;
  }

  _handleUpgrade(request, socket, head) {
    let url;
    try {
      url = new URL(request.url || '/', 'http://127.0.0.1');
    } catch (error) {
      this._reject(socket, 400, 'Bad Request');
      return;
    }
    if (!this._matches(url)) {
      this._reject(socket, 404, 'Not Found');
      return;
    }
    if (request.headers.upgrade === undefined ||
        String(request.headers.upgrade).toLowerCase() !== 'websocket') {
      this._reject(socket, 400, 'Not a WebSocket upgrade');
      return;
    }
    if (this.verifyClient && !this.verifyClient(request, url)) {
      this._reject(socket, 401, 'Unauthorized');
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (!key) {
      this._reject(socket, 400, 'Missing Sec-WebSocket-Key');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    try {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
    } catch (error) {
      this._reject(socket, 500, 'Handshake failed');
      return;
    }

    const connection = new WsConnection(socket, request, url, {
      requireMasked: this.requireMasked
    });
    this.clients.add(connection);
    connection.on('close', () => this.clients.delete(connection));
    this.emit('connection', connection, request, url);
    if (head && head.length) connection._onData(head);
  }

  _reject(socket, status, text) {
    try {
      const body = text || '';
      socket.write(
        `HTTP/1.1 ${status} ${text || 'Error'}\r\n` +
        'Connection: close\r\n' +
        `Content-Type: text/plain\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
      );
    } catch (error) { /* ignore */ }
    try { socket.destroy(); } catch (error) { /* ignore */ }
  }

  broadcast(text) {
    for (const client of this.clients) {
      if (client.readyState === 1) client.send(text);
    }
  }

  close() {
    try { this.httpServer.off('upgrade', this._onUpgrade); } catch (e) { /* ignore */ }
    for (const client of this.clients) client.close(1001, 'server shutdown');
    this.clients.clear();
  }
}

// Client side, used by the OneBot reverse-WebSocket adapter. Node's built-in
// WebSocket cannot attach handshake headers, and bot frameworks commonly check
// Authorization / X-Self-ID there, so the handshake is written by hand.
function connectClient(target, options = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(target);
    } catch (error) {
      reject(error);
      return;
    }
    const secure = url.protocol === 'wss:';
    if (url.protocol !== 'ws:' && !secure) {
      reject(new Error(`unsupported WebSocket protocol: ${url.protocol}`));
      return;
    }
    const port = Number(url.port) || (secure ? 443 : 80);
    const transport = secure ? require('tls') : require('net');
    const socket = transport.connect({
      host: url.hostname,
      port,
      noDelay: true,
      ...(secure ? { servername: url.hostname, rejectUnauthorized: options.rejectUnauthorized !== false } : {})
    });

    const key = crypto.randomBytes(16).toString('base64');
    const expectedAccept = computeAccept(key);
    let handshake = Buffer.alloc(0);
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', fail);
      try { socket.destroy(); } catch (e) { /* ignore */ }
      reject(error);
    };

    const onData = (chunk) => {
      if (settled) return;
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf('\r\n\r\n');
      if (end === -1) {
        if (handshake.length > 64 * 1024) fail(new Error('handshake response too large'));
        return;
      }
      const head = handshake.subarray(0, end).toString('latin1');
      const statusLine = head.split('\r\n')[0] || '';
      if (!/^HTTP\/1\.[01] 101\b/i.test(statusLine)) {
        fail(new Error(`handshake rejected: ${statusLine || 'no status line'}`));
        return;
      }
      const acceptMatch = /sec-websocket-accept:\s*([^\r\n]+)/i.exec(head);
      if (!acceptMatch || acceptMatch[1].trim() !== expectedAccept) {
        fail(new Error('invalid Sec-WebSocket-Accept'));
        return;
      }
      settled = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', fail);
      socket.setTimeout(0);
      const connection = new WsConnection(socket, { headers: {} }, url, { masked: true });
      connection.on('error', (error) => connection.emit('close', error));
      const rest = handshake.subarray(end + 4);
      if (rest.length) {
        // A server that writes its first frames right after the 101 response
        // gets them coalesced into the same segment. Queuing the bytes ahead of
        // anything that lands later, and parsing on the next tick, lets the
        // caller attach its listeners before the frames are emitted.
        connection.buffer = Buffer.concat([rest, connection.buffer]);
        setImmediate(() => {
          try { connection._onData(Buffer.alloc(0)); } catch (e) { /* reported by error */ }
        });
      }
      resolve(connection);
    };

    socket.on('data', onData);
    socket.on('error', (error) => fail(new Error(`connect failed: ${error.message}`)));
    socket.setTimeout(options.handshakeTimeout || 10000, () => fail(new Error('handshake timeout')));
    socket.on('connect', () => {
      const pathname = url.pathname + (url.search || '');
      const lines = [
        `GET ${pathname} HTTP/1.1`,
        `Host: ${url.hostname}${url.port ? ':' + url.port : ''}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13'
      ];
      for (const [name, value] of Object.entries(options.headers || {})) {
        if (value === undefined || value === null || value === '') continue;
        lines.push(`${name}: ${value}`);
      }
      try {
        socket.write(lines.join('\r\n') + '\r\n\r\n');
      } catch (error) {
        fail(error);
      }
    });
  });
}

module.exports = { WsServer, WsConnection, connectClient, computeAccept, GUID };
