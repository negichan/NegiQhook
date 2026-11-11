'use strict';

// Reverse WebSocket client (WebSocket 客户端 / 转发). The endpoint dials the bot
// framework, which is how NoneBot and koishi are usually run in server mode.
// Handshake headers follow NapCat because several frameworks check them.

const { NetworkAdapter } = require('./adapter');
const { connectClient } = require('../../../lib/ws');
const { WsSession, normalizeRole, ROLE_UNIVERSAL } = require('./shared');
const { num, str } = require('../segments');

class WsClientAdapter extends NetworkAdapter {
  constructor(name, config, protocol, logger) {
    super(name, 'ws-client', config, protocol, logger);
    this.url = str(config.url);
    this.token = str(config.token || protocol.token);
    this.role = normalizeRole(config.role || ROLE_UNIVERSAL);
    this.reconnectInterval = Math.max(1000, num(config.reconnectInterval) || 5000);
    this.connection = null;
    this.session = null;
    this.timer = null;
    this.stopping = false;
    this.attempts = 0;
  }

  async onOpen() {
    if (!this.url) throw new Error(`${this.name}: reverse WebSocket needs a url`);
    this.stopping = false;
    // Do not make the whole endpoint wait for the framework to answer: the
    // first dial runs in the background and keeps retrying like any other.
    this._connect().catch((error) => {
      this.log.warn(`[${this.name}] reverse connect attempt threw: ${error.message}`);
      this._scheduleReconnect();
    });
  }

  async onClose() {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.session) this.session.dispose();
    if (this.connection) this.connection.close(1001, 'adapter closed');
    this.connection = null;
    this.session = null;
    this.listening = false;
  }

  async _connect() {
    if (this.stopping) return;
    const headers = {
      'X-Self-ID': str(this.protocol.selfId),
      'x-client-role': this.role === 'api' ? 'API' : this.role === 'event' ? 'Event' : 'Universal',
      'User-Agent': 'OneBot/11'
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    // Koishi and NoneBot also read the token from the query string.
    const target = this._urlWithToken();

    let connection;
    try {
      connection = await connectClient(target, { headers, handshakeTimeout: 10000 });
    } catch (error) {
      this.attempts++;
      this.listening = false;
      const line =
        `[${this.name}] reverse connect failed (${this.attempts}): ${error.message}; ` +
        `retry in ${Math.round(this.reconnectInterval / 1000)}s`;
      // A framework that is not running would otherwise fill the log every five
      // seconds forever: shout for the first few, then once a minute.
      if (this.attempts <= 3 || this.attempts % 12 === 0) this.log.warn(line);
      else this.log.debug(line);
      this._scheduleReconnect();
      return;
    }

    this.attempts = 0;
    this.connection = connection;
    this.listening = true;
    this.session = new WsSession(connection, {
      role: this.role,
      protocol: this.protocol,
      owner: this,
      log: this.log,
      heartbeatInterval: this.config.heartbeatInterval
    });
    this.log.info(`[${this.name}] reverse WebSocket connected to ${this.url} (${this.role})`);

    connection.on('close', () => {
      if (this.connection === connection) {
        this.connection = null;
        this.listening = false;
        this.session = null;
        this.log.warn(`[${this.name}] reverse WebSocket disconnected`);
        this._scheduleReconnect();
      }
    });
  }

  _scheduleReconnect() {
    if (this.stopping || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._connect();
    }, this.reconnectInterval);
    this.timer.unref?.();
  }

  _urlWithToken() {
    if (!this.token) return this.url;
    try {
      const url = new URL(this.url);
      if (!url.searchParams.get('access_token')) {
        url.searchParams.set('access_token', this.token);
      }
      return url.toString();
    } catch (error) {
      return this.url;
    }
  }

  onEvent(event) {
    if (this.role === 'api') return;
    if (this.session) this.session.send(event);
  }

  forgetSession(session) {
    if (this.session === session) this.session = null;
  }

  detail() {
    return `${this.url} · ${this.listening ? '已连接' : `重连中（间隔 ${Math.round(this.reconnectInterval / 1000)}s）`}`;
  }
}

module.exports = { WsClientAdapter };
