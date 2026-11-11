'use strict';

// OneBot v11 protocol front end. It owns the transports a bot framework can
// attach to and nothing else: actions run through core, events come from the
// kernel bridge, and each transport decides its own message format.
//
//   config = {
//     token, messagePostFormat, reportSelfMessage, heartbeatInterval,
//     networks: [{ name, type, enable, ... }]   // the persistent config shape
//   }
//
// The legacy shape (http / wsServer / reports / reverseWs) is still accepted
// and converted, so older callers keep working. reload() diffs networks by
// name: an unchanged network keeps its live connections, a changed one is
// rebuilt, a removed one is closed - that is what makes the config page's
// "save" hot-apply without dropping every framework attached to us.

const { createActions, handleAction, UNIMPLEMENTED, REFUSED, RC } = require('./actions');
const { toOneBotEvents, heartbeatEvent } = require('./events');
const { toCqString, num, str } = require('./segments');
const { HttpServerAdapter } = require('./network/http-server');
const { WsServerAdapter } = require('./network/ws-server');
const { HttpPostAdapter } = require('./network/http-post');
const { WsClientAdapter } = require('./network/ws-client');

const DEFAULT_HEARTBEAT = 30000;

// The pre-config-page shape, kept so older callers (and the CLI fallback path)
// still build the same transports. Names match what the seeder writes, so a
// legacy instance and a file-driven one diff cleanly against each other.
function legacyToNetworks(config) {
  const networks = [];
  const base = { token: '', messagePostFormat: '', heartbeatInterval: 0, reportSelfMessage: false };
  if (config.http) {
    networks.push({
      ...base, name: 'http', type: 'httpServer', enable: config.http.enable !== false,
      host: config.http.host || '127.0.0.1', port: num(config.http.port) || 3000,
      enableWebSocket: config.http.enableWebSocket === true
    });
  }
  if (config.wsServer) {
    networks.push({
      ...base, name: 'ws', type: 'wsServer', enable: config.wsServer.enable !== false,
      host: config.wsServer.host || '127.0.0.1', port: num(config.wsServer.port) || 3001,
      role: config.wsServer.role || 'universal'
    });
  }
  (config.reports || []).forEach((report, index) => {
    networks.push({
      ...base, name: `report${index + 1}`, type: 'httpClient', enable: report.enable !== false,
      url: str(report.url), secret: str(report.secret), timeout: num(report.timeout) || 10000
    });
  });
  (config.reverseWs || []).forEach((reverse, index) => {
    networks.push({
      ...base, name: `reverse${index + 1}`, type: 'wsClient', enable: reverse.enable !== false,
      url: str(reverse.url), reconnectInterval: num(reverse.reconnectInterval) || 5000,
      role: reverse.role || 'universal'
    });
  });
  return networks;
}

class OneBotProtocol {
  constructor({ core, store, unique, logger, config }) {
    this.core = core;
    this.store = store;
    this.unique = unique;
    this.log = logger;
    const given = config || {};
    this.config = Array.isArray(given.networks) ? given : { ...given, networks: legacyToNetworks(given) };
    this.token = this.config.token || '';
    this.heartbeatInterval = num(this.config.heartbeatInterval) || DEFAULT_HEARTBEAT;
    this.actionContext = createActions({
      core,
      store,
      unique,
      logger: this.log.child ? this.log.child('action') : this.log
    });
    this.adapters = [];
    this.heartbeatTimer = null;
    this.adapters = this._adaptersFor(this.config);
  }

  get selfId() {
    return num(this.store.self.uin);
  }

  get online() {
    return this.core.rpc.connected && !this.store.offline && this.selfId > 0;
  }

  get implementedCount() {
    return Object.keys(this.actionContext.actions).length;
  }

  get unimplementedCount() {
    return UNIMPLEMENTED.length;
  }

  _adaptersFor(config) {
    const adapters = [];
    const globalFormat = config.messagePostFormat === 'string' ? 'string' : 'array';
    const globalHeartbeat = num(config.heartbeatInterval) || DEFAULT_HEARTBEAT;
    for (const entry of config.networks || []) {
      // Fixed key order: reload() compares these objects with JSON.stringify,
      // so two equal configs must serialise identically.
      const effective = {
        enable: entry.enable !== false,
        token: str(entry.token) || this.token,
        messagePostFormat: entry.messagePostFormat === 'string' || entry.messagePostFormat === 'array'
          ? entry.messagePostFormat : globalFormat,
        heartbeatInterval: num(entry.heartbeatInterval) || globalHeartbeat,
        reportSelfMessage: entry.reportSelfMessage === true
      };
      const name = str(entry.name) || entry.type;
      switch (entry.type) {
        case 'httpServer':
          adapters.push(new HttpServerAdapter(name, {
            ...effective,
            host: str(entry.host) || '127.0.0.1',
            port: num(entry.port) || 3000,
            enableWebSocket: entry.enableWebSocket === true
          }, this, this.log));
          break;
        case 'wsServer':
          adapters.push(new WsServerAdapter(name, {
            ...effective,
            host: str(entry.host) || '127.0.0.1',
            port: num(entry.port) || 3001,
            role: str(entry.role) || 'universal'
          }, this, this.log));
          break;
        case 'httpClient':
          adapters.push(new HttpPostAdapter(name, {
            ...effective,
            url: str(entry.url),
            secret: str(entry.secret),
            timeout: num(entry.timeout) || 10000
          }, this, this.log));
          break;
        case 'wsClient':
          adapters.push(new WsClientAdapter(name, {
            ...effective,
            url: str(entry.url),
            reconnectInterval: num(entry.reconnectInterval) || 5000,
            role: str(entry.role) || 'universal'
          }, this, this.log));
          break;
        default:
          this.log.warn(`onebot network 「${name}」 has unknown type ${entry.type}; skipped`);
      }
    }
    return adapters;
  }

  _startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    // Report sinks have no per-connection heartbeat, so the protocol drives it.
    this.heartbeatTimer = setInterval(() => {
      const event = heartbeatEvent(this.selfId, this.heartbeatInterval, this.online);
      for (const adapter of this.adapters) {
        if (adapter instanceof HttpPostAdapter && adapter.enabled) this._deliver(adapter, event);
      }
    }, this.heartbeatInterval);
    this.heartbeatTimer.unref?.();
  }

  async start() {
    const failures = [];
    for (const adapter of this.adapters) {
      try {
        await adapter.open();
      } catch (error) {
        failures.push(`${adapter.name}: ${error.message}`);
        this.log.error(`onebot adapter ${adapter.name} failed to open: ${error.message}`);
      }
    }
    this._startHeartbeat();
    return { opened: this.adapters.filter((a) => a.enabled).map((a) => a.name), failures };
  }

  // Hot-apply a new config (the config page's save). Networks are matched by
  // name: identical effective config keeps the live adapter (and its connected
  // frameworks), anything else is closed and rebuilt, leftovers are closed.
  async reload(config) {
    const given = config || {};
    this.config = Array.isArray(given.networks) ? given : { ...given, networks: legacyToNetworks(given) };
    this.token = this.config.token || '';
    this.heartbeatInterval = num(this.config.heartbeatInterval) || DEFAULT_HEARTBEAT;
    const report = { kept: [], opened: [], closed: [], failures: [] };
    const desired = this._adaptersFor(this.config);
    const oldByName = new Map(this.adapters.map((adapter) => [adapter.name, adapter]));
    const next = [];
    for (const adapter of desired) {
      const old = oldByName.get(adapter.name);
      if (old && old.constructor === adapter.constructor &&
          JSON.stringify(old.config) === JSON.stringify(adapter.config)) {
        oldByName.delete(adapter.name);
        next.push(old);
        report.kept.push(adapter.name);
        continue;
      }
      if (old) {
        oldByName.delete(adapter.name);
        try {
          await old.close();
          report.closed.push(old.name);
        } catch (error) {
          this.log.warn(`onebot adapter ${old.name} close failed: ${error.message}`);
        }
      }
      try {
        await adapter.open();
        report.opened.push(adapter.name);
      } catch (error) {
        report.failures.push(`${adapter.name}: ${error.message}`);
        this.log.error(`onebot adapter ${adapter.name} failed to open: ${error.message}`);
      }
      next.push(adapter);
    }
    for (const old of oldByName.values()) {
      try {
        await old.close();
        report.closed.push(old.name);
      } catch (error) {
        this.log.warn(`onebot adapter ${old.name} close failed: ${error.message}`);
      }
    }
    this.adapters = next;
    this._startHeartbeat();
    return report;
  }

  close() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const adapter of this.adapters) {
      try {
        Promise.resolve(adapter.close()).catch((error) => {
          this.log.debug(`onebot adapter ${adapter.name} close failed: ${error.message}`);
        });
      } catch (error) {
        this.log.debug(`onebot adapter ${adapter.name} close threw: ${error.message}`);
      }
    }
  }

  status() {
    return this.adapters.map((adapter) => adapter.describeStatus());
  }

  // Called by a bridge connect/disconnect so attached clients see enable /
  // disable lifecycle events, the way NapCat reports them.
  lifecycle(subType) {
    const event = {
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: subType,
      self_id: this.selfId,
      time: Math.floor(Date.now() / 1000),
      interval: this.heartbeatInterval
    };
    for (const adapter of this.adapters) {
      if (adapter.enabled) this._deliver(adapter, event);
    }
  }

  onEvent(kernelEvent) {
    if (!kernelEvent || !kernelEvent.type) return;
    const ctx = { store: this.store, unique: this.unique, protocol: this };
    let events;
    try {
      events = toOneBotEvents(kernelEvent, ctx);
    } catch (error) {
      this.log.error('onebot event conversion failed:', error.message);
      return;
    }
    for (const event of events) {
      for (const adapter of this.adapters) {
        if (!adapter.enabled) continue;
        // Outgoing echoes are opt-in: a bot that replies to everything would
        // otherwise loop on its own messages. Either the global flag or the
        // network's own flag turns them on for that transport.
        if (event.post_type === 'message_sent' &&
            !this.config.reportSelfMessage && !adapter.config.reportSelfMessage) {
          continue;
        }
        this._deliver(adapter, event);
      }
    }
  }

  _deliver(adapter, event) {
    const format = adapter.messagePostFormat || 'array';
    let payload = event;
    if (format === 'string' && Array.isArray(event.message)) {
      payload = { ...event, message: toCqString(event.message) };
    }
    try {
      if (typeof this.onActivity === 'function') {
        this.onActivity(adapter.name, payload, !!adapter.enabled);
      }
    } catch (e) { /* the debug page never breaks a delivery */ }
    try {
      adapter.onEvent(payload);
    } catch (error) {
      this.log.debug(`onebot ${adapter.name} delivery failed: ${error.message}`);
    }
  }

  async handleAction(name, params, echo) {
    const started = Date.now();
    const result = await handleAction(name, params, {
      actions: this.actionContext.actions,
      logger: this.log,
      protocol: this,
      echo
    });
    // One line per action, at a level the console keeps quiet and the debug page
    // still shows: this is the only trace of what a connected framework asked for.
    const detail = `${name} -> ${result.status} ${Date.now() - started}ms`;
    if (result.retcode === RC.OK) this.log.debug('onebot ' + detail);
    else this.log.warn(`onebot ${detail} ${result.message || ''}`.trim());
    if (result.retcode === RC.OK && result.data) {
      if (this.config.messagePostFormat === 'string' && Array.isArray(result.data.message)) {
        result.data = { ...result.data, message: toCqString(result.data.message) };
      }
      if (this.config.messagePostFormat === 'string' && Array.isArray(result.data.messages)) {
        result.data = {
          ...result.data,
          messages: result.data.messages.map((item) => (
            Array.isArray(item.message)
              ? { ...item, message: toCqString(item.message) }
              : item
          ))
        };
      }
    }
    return result;
  }
}

module.exports = { OneBotProtocol, UNIMPLEMENTED, REFUSED, DEFAULT_HEARTBEAT };
