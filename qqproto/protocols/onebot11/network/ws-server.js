'use strict';

// Standalone OneBot WebSocket server. This is what NoneBot (`~ONEBOT_WS_URL`),
// koishi-adapter-onebot and most "WebSocket 服务端" setups expect: one port,
// event frames out, optional action frames in.

const http = require('http');

const { NetworkAdapter } = require('./adapter');
const { WsServer } = require('../../../lib/ws');
const {
  WsSession,
  SessionSet,
  authorize,
  normalizeRole,
  ROLE_API,
  ROLE_UNIVERSAL
} = require('./shared');
const { OB11Response, RC } = require('../actions');
const { str } = require('../segments');

class WsServerAdapter extends NetworkAdapter {
  constructor(name, config, protocol, logger) {
    super(name, 'ws-server', config, protocol, logger);
    this.server = null;
    this.ws = null;
    this.sessions = new SessionSet();
    this.host = config.host || '127.0.0.1';
    this.port = Number(config.port) || 3001;
    this.token = str(config.token || protocol.token);
    this.role = normalizeRole(config.role || 'universal');
  }

  async onOpen() {
    const server = http.createServer((request, response) => {
      // A plain GET on a WS-only port is a health probe, not an action call.
      let url;
      try {
        url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
      } catch (error) {
        url = null;
      }
      if (url && authorize(request, url, this.token)) {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(OB11Response.ok({
          name: 'qq-hook onebot v11 websocket server',
          clients: this.sessions.size,
          role: this.role
        }, null)));
        return;
      }
      response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(OB11Response.error('unauthorized', RC.BAD_TOKEN, null)));
    });
    this.server = server;
    server.on('error', (error) => {
      this.listening = false;
      this.log.error(`[${this.name}] ws server error: ${error.message}`);
    });

    this.ws = new WsServer(server, {
      path: () => true,
      verifyClient: (request, url) => authorize(request, url, this.token)
    });
    this.ws.on('connection', (connection, request, url) => {
      // With an explicit universal role the path still picks the role, so a
      // client can open one event socket and one API socket on the same port.
      let role = this.role;
      if (role === ROLE_UNIVERSAL) {
        const isApi = url.pathname === '/api' || url.pathname === '/api/';
        if (isApi) role = ROLE_API;
      }
      const session = new WsSession(connection, {
        role,
        protocol: this.protocol,
        owner: this,
        log: this.log,
        heartbeatInterval: this.config.heartbeatInterval
      });
      this.sessions.add(session);
      this.log.info(`[${this.name}] client connected (${role}) from ${connection.socket.remoteAddress}`);
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, () => resolve());
    });
    this.listening = true;
    this.log.info(`[${this.name}] OneBot WebSocket listening on ws://${this.host}:${this.port}/`);
  }

  async onClose() {
    for (const session of [...this.sessions.sessions]) {
      session.connection.close(1001, 'server shutdown');
      session.dispose();
    }
    if (this.ws) this.ws.close();
    this.ws = null;
    if (this.server) {
      try { this.server.closeAllConnections(); } catch (e) { /* ignore */ }
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
    this.listening = false;
  }

  onEvent(event) {
    this.sessions.send(event);
  }

  forgetSession(session) {
    this.sessions.delete(session);
  }

  detail() {
    return `ws://${this.host}:${this.port} · ${this.sessions.size} 个客户端`;
  }
}

module.exports = { WsServerAdapter };
