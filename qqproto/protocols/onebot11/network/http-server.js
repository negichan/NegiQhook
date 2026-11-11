'use strict';

// OneBot v11 HTTP server: the REST action surface most bots use, plus an
// optional WebSocket upgrade on the same port (NapCat's "HTTP 服务端 + 启用
// WebSocket" combination). Events go to the upgraded sockets; plain HTTP
// clients poll actions and never see events here.

const http = require('http');

const { NetworkAdapter } = require('./adapter');
const { WsServer } = require('../../../lib/ws');
const {
  WsSession,
  SessionSet,
  authorize,
  normalizeRole,
  ROLE_API,
  readJsonBody
} = require('./shared');
const { OB11Response, RC } = require('../actions');
const { str } = require('../segments');

const MAX_BODY = 4 * 1024 * 1024;

class HttpServerAdapter extends NetworkAdapter {
  constructor(name, config, protocol, logger) {
    super(name, 'http-server', config, protocol, logger);
    this.server = null;
    this.ws = null;
    this.sessions = new SessionSet();
    this.host = config.host || '127.0.0.1';
    this.port = Number(config.port) || 3000;
    this.token = str(config.token || protocol.token);
  }

  async onOpen() {
    const server = http.createServer((request, response) => {
      this._handleRequest(request, response).catch((error) => {
        this.log.error('onebot http handler failed:', error.message);
        if (!response.writableEnded) {
          this._json(response, 500, OB11Response.error('internal error', RC.INTERNAL, null));
        }
      });
    });
    this.server = server;
    server.on('error', (error) => {
      this.listening = false;
      this.log.error(`[${this.name}] http error: ${error.message}`);
    });

    if (this.config.enableWebSocket === true) {
      this.ws = new WsServer(server, {
        path: () => true,
        verifyClient: (request, url) => authorize(request, url, this.token)
      });
      this.ws.on('connection', (connection, request, url) => {
        // /api is the action-only role; every other path receives events, which
        // is what Koishi and NoneBot's universal clients expect.
        const isApi = url.pathname === '/api' || url.pathname === '/api/';
        const role = isApi ? ROLE_API : normalizeRole(this.config.wsRole || 'universal');
        const session = new WsSession(connection, {
          role,
          protocol: this.protocol,
          owner: this,
          log: this.log,
          heartbeatInterval: this.config.heartbeatInterval
        });
        this.sessions.add(session);
      });
    }

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, () => resolve());
    });
    this.listening = true;
    this.log.info(
      `[${this.name}] OneBot HTTP listening on http://${this.host}:${this.port}` +
      (this.ws ? ' (WebSocket enabled)' : '')
    );
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
    if (!this.ws) return;
    this.sessions.send(event);
  }

  forgetSession(session) {
    this.sessions.delete(session);
  }

  detail() {
    return `${this.host}:${this.port}${this.ws ? ` · WS ${this.sessions.size}` : ''}`;
  }

  async _handleRequest(request, response) {
    let url;
    try {
      url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    } catch (error) {
      this._json(response, 400, OB11Response.error('bad request', RC.BAD_PARAM, null));
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, this._cors());
      response.end();
      return;
    }
    if (!authorize(request, url, this.token)) {
      this._json(response, 401, OB11Response.error('unauthorized: bad access_token', RC.BAD_TOKEN, null));
      return;
    }

    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (pathname === '/' || pathname === '') {
      // Root accepts the {action, params} style used by some clients.
      if (request.method === 'POST') {
        const body = await this._body(request, response);
        if (body === null) return;
        await this._dispatch(str(body.action), body.params || body, body.echo, response);
        return;
      }
      this._json(response, 200, {
        ...OB11Response.ok({
          name: 'qq-hook onebot v11 endpoint',
          protocol: 'OneBot-v11',
          implement: 'qqproto',
          actions: this.protocol.implementedCount,
          unimplemented: this.protocol.unimplementedCount
        }, null),
        message: 'qq-hook is running'
      });
      return;
    }

    const action = decodeURIComponent(pathname.slice(1));
    let params = {};
    const fromQuery = () => {
      const out = {};
      for (const [key, value] of url.searchParams) {
        try {
          out[key] = JSON.parse(value);
        } catch (e) {
          out[key] = value;
        }
      }
      return out;
    };
    if (request.method === 'GET' || request.method === 'DELETE') {
      params = fromQuery();
    } else if (request.method === 'POST' || request.method === 'PUT') {
      const body = await this._body(request, response);
      if (body === null) return;
      // Query wins over the body: NapCat merges the same way, and it lets a
      // client keep the action name in the path while passing real parameters.
      params = { ...body, ...fromQuery() };
    } else {
      this._json(response, 405, OB11Response.error('method not allowed', RC.BAD_PARAM, null));
      return;
    }
    await this._dispatch(action, params, params.echo === undefined ? null : params.echo, response);
  }

  async _dispatch(action, params, echo, response) {
    const result = await this.protocol.handleAction(action, params, echo);
    this._json(response, 200, result);
  }

  _body(request, response) {
    return readJsonBody(request, MAX_BODY, () => {
      this._json(response, 400, OB11Response.error('invalid JSON body', RC.BAD_PARAM, null));
    }).catch((error) => {
      this._json(response, 400, OB11Response.error(error.message, RC.BAD_PARAM, null));
      return null;
    });
  }

  _cors() {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Signature',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    };
  }

  _json(response, status, value) {
    if (response.writableEnded) return;
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Self-ID': str(this.protocol.selfId),
      ...this._cors()
    });
    response.end(body);
  }
}

module.exports = { HttpServerAdapter, MAX_BODY };
