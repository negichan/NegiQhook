'use strict';

// TCP server side of the injected bridge. The bridge is the client: it can sit
// inside QQ behind any network setup, while the endpoint owns a stable listener.
//
// One bridge is active at a time. Re-evaluating proto_bridge.js bumps its
// `generation`; lower generations stay open but inert so they cannot supersede
// the active one, and they are promoted back if the active bridge disappears.

const net = require('net');
const { EventEmitter } = require('events');

class BridgeRpc extends EventEmitter {
  constructor({ host = '127.0.0.1', port, token = '', logger }) {
    super();
    this.host = host;
    this.port = port;
    this.token = String(token || '');
    this.log = logger;
    this.server = null;
    this.socket = null;
    this.self = { uin: 0, uid: '', nick: '' };
    this.connected = false;
    this.peer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.counters = { events: 0, actions: 0, actionErrors: 0 };
    this.activeGeneration = -1;
    this.stale = new Map();
    this.bridgeInfo = null;
    this.connectedAt = 0;
    this.lastHelloAt = 0;
    this.lastEventAt = 0;
    this.lastHeartbeatAt = 0;
    this.bridgeHeartbeat = null;
  }

  stats() {
    return {
      connected: this.connected,
      peer: this.peer,
      generation: this.activeGeneration,
      connectedAt: this.connectedAt,
      lastHelloAt: this.lastHelloAt,
      lastEventAt: this.lastEventAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      pending: this.pending.size,
      staleBridges: this.stale.size,
      counters: Object.assign({}, this.counters),
      bridgeInfo: this.bridgeInfo || null,
      heartbeat: this.bridgeHeartbeat || null
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this._accept(socket));
      server.once('error', (error) => {
        if (!this.server) reject(error);
        else this.log.error('bridge server error:', error);
      });
      server.listen(this.port, this.host, () => {
        this.server = server;
        resolve();
      });
    });
  }

  stop() {
    this._rejectAll(new Error('bridge endpoint stopped'));
    if (this.socket) {
      try { this.socket.destroy(); } catch (e) { /* ignore */ }
      this.socket = null;
    }
    for (const socket of this.stale.keys()) {
      try { socket.destroy(); } catch (e) { /* ignore */ }
    }
    this.stale.clear();
    this.connected = false;
    this.bridgeInfo = null;
    if (this.server) {
      try { this.server.close(); } catch (e) { /* ignore */ }
      this.server = null;
    }
  }

  call(action, params = {}, timeoutMs = 20000) {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error('QQ bridge is not connected'));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ type: 'action', id, action, params }) + '\n';
    this.counters.actions++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`action timeout: ${action}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, action });
      try {
        this.socket.write(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _accept(socket) {
    const state = { buffer: '', promoted: false, stale: false, hello: null };
    socket.__qqbridge = state;
    socket.setNoDelay(true);

    socket.on('data', (chunk) => {
      if (state.stale) return;
      state.buffer += chunk.toString('utf8');
      let index;
      while ((index = state.buffer.indexOf('\n')) !== -1) {
        const line = state.buffer.slice(0, index).replace(/\r$/, '');
        state.buffer = state.buffer.slice(index + 1);
        if (line) this._frame(socket, state, line);
      }
      if (state.buffer.length > 8 * 1024 * 1024) {
        this.log.warn('bridge frame buffer overflow; resetting');
        state.buffer = '';
      }
    });

    socket.on('close', () => this._closed(socket, state));
    socket.on('error', (error) => {
      if (state.promoted) this.log.warn('QQ bridge socket error:', error.message);
      else if (!state.stale) this.log.debug('bridge socket error:', error.message);
    });
  }

  _frame(socket, state, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.log.warn('bad bridge frame:', line.slice(0, 160));
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (!state.promoted) {
      if (this.token && message.type !== 'hello') {
        this.log.warn('rejecting unauthenticated bridge frame before hello');
        try { socket.destroy(); } catch (e) { /* ignore */ }
        return;
      }
      if (message.type === 'hello') {
        if (this.token && message.token !== this.token) {
          this.log.warn(
            `rejecting bridge hello with a bad token from ${socket.remoteAddress}:${socket.remotePort}`
          );
          try { socket.destroy(); } catch (e) { /* ignore */ }
          return;
        }
        const generation = Number(message.generation) || 0;
        if (generation < this.activeGeneration) {
          // Hold it open but inert. Destroying it would make an old bridge
          // reconnect every two seconds forever; one parked socket is cheaper.
          state.stale = true;
          state.hello = message;
          this.stale.set(socket, { generation, hello: message });
          this.log.debug(
            `holding stale bridge generation ${generation} (active ${this.activeGeneration})`
          );
          return;
        }
        this._promote(socket, message);
        return;
      }
      // A bridge from before generation numbers: promote on its first frame.
      this._promote(socket, null);
    }

    this._line(message);
  }

  _promote(socket, hello) {
    const state = socket.__qqbridge;
    if (!state || state.promoted) return;
    state.promoted = true;
    state.stale = false;
    this.stale.delete(socket);

    if (this.socket && this.socket !== socket) {
      const previous = this.socket;
      if (previous.__qqbridge) previous.__qqbridge.promoted = false;
      try { previous.destroy(); } catch (e) { /* ignore */ }
      this._rejectAll(new Error('QQ bridge superseded by a newer instance'));
    }

    this.socket = socket;
    this.connected = true;
    this.connectedAt = Date.now();
    this.activeGeneration = hello ? Number(hello.generation) || 0 : 0;
    this.bridgeInfo = hello || null;
    if (hello) this.lastHelloAt = Date.now();
    this.peer = `${socket.remoteAddress}:${socket.remotePort}`;
    if (hello && hello.self) this.self = hello.self;
    this.log.info(
      `QQ bridge connected from ${socket.remoteAddress}:${socket.remotePort} ` +
      `(generation ${this.activeGeneration})`
    );
    if (hello && (hello.bridge_version || hello.qq_version)) {
      this.log.info(
        `QQ bridge info: version=${hello.bridge_version || '?'} ` +
        `qq=${hello.qq_version || '?'} headless=${hello.headless ? 1 : 0} ` +
        `capabilities=${hello.capabilities ? JSON.stringify(hello.capabilities) : '{}'}`
      );
    }
    if (hello && hello.limits && hello.limits.budget) {
      this.log.info('QQ bridge write budget: ' + JSON.stringify(hello.limits.budget));
    }
    this.emit('connect');
    if (hello) this.emit('hello', hello);
  }

  _closed(socket, state) {
    this.stale.delete(socket);
    if (!state.promoted || this.socket !== socket) return;
    this.socket = null;
    this.connected = false;
    this.connectedAt = 0;
    this.bridgeInfo = null;
    this.bridgeHeartbeat = null;
    this.peer = '';
    this.log.warn('QQ bridge disconnected');
    this._rejectAll(new Error('QQ bridge disconnected'));
    this.emit('disconnect');
    this._promoteFallback();
  }

  // If the active bridge dies while an older instance is still parked (a failed
  // hot update, for example), hand the endpoint to the newest parked bridge
  // instead of waiting for a process that may never reconnect.
  _promoteFallback() {
    if (this.socket || this.stale.size === 0) return;
    let best = null;
    for (const [socket, entry] of this.stale) {
      if (!socket.writable) {
        this.stale.delete(socket);
        continue;
      }
      if (!best || entry.generation > best.entry.generation) best = { socket, entry };
    }
    if (!best) return;
    this.log.warn(`falling back to parked bridge generation ${best.entry.generation}`);
    this._promote(best.socket, best.entry.hello);
  }

  _line(message) {
    if (message.type === 'result') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) {
        pending.resolve(message.data === undefined ? null : message.data);
      } else {
        this.counters.actionErrors++;
        const error = new Error(message.error || 'action failed');
        // A budget/circuit refusal is not a kernel failure; adapters map the
        // code to 403/429 instead of reporting an internal error.
        if (message.code) error.code = message.code;
        if (message.retry_after) error.retry_after = message.retry_after;
        pending.reject(error);
      }
      return;
    }

    if (message.type === 'hello') {
      if (this.token && message.token !== this.token) {
        this.log.warn('ignoring bridge hello with a bad token');
        return;
      }
      this.bridgeInfo = message;
      this.lastHelloAt = Date.now();
      if (message.self && message.self.uin) this.self = message.self;
      this.emit('hello', message);
      return;
    }

    if (message.type === 'event') {
      this.counters.events++;
      this.lastEventAt = Date.now();
      if (message.event && message.event.self_id) {
        this.self = {
          uin: Number(message.event.self_id) || this.self.uin,
          uid: this.self.uid,
          nick: this.self.nick
        };
      }
      this.emit('event', message.event);
      return;
    }

    if (message.type === 'heartbeat') {
      this.lastHeartbeatAt = Date.now();
      this.bridgeHeartbeat = message;
      if (message.self && message.self.uin) this.self = message.self;
      return;
    }

    if (message.type === 'log') {
      const level = message.level === 'warn' || message.level === 'error'
        ? message.level : 'debug';
      this.log[level]('bridge:', message.message);
    }
  }

  _rejectAll(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

module.exports = { BridgeRpc };
