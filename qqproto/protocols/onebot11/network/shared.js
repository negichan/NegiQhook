'use strict';

// Pieces shared by the OneBot transports: token checks, the WebSocket action
// session (role split, lifecycle, heartbeat) and JSON body reading. NapCat
// keeps these per-adapter; with only one process and four transports, sharing
// them keeps the behaviour identical across them.

const { OB11Response, RC } = require('../actions');
const { lifecycleEvent, heartbeatEvent } = require('../events');
const { num, str } = require('../segments');

const ROLE_API = 'api';
const ROLE_EVENT = 'event';
const ROLE_UNIVERSAL = 'universal';

function normalizeRole(value) {
  const role = str(value).toLowerCase();
  if (role === 'api' || role === 'action') return ROLE_API;
  if (role === 'event') return ROLE_EVENT;
  return ROLE_UNIVERSAL;
}

function tokenFrom(request, url) {
  const query = url && url.searchParams ? (url.searchParams.get('access_token') || '') : '';
  if (query) return query;
  const header = str(request.headers.authorization || request.headers.Authorization);
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return header ? header.trim() : '';
}

// NapCat answers a bad token with HTTP 403 on the REST side and with a closed
// socket plus retcode 1403 on the WebSocket side.
function authorize(request, url, token) {
  if (!token) return true;
  return tokenFrom(request, url) === token;
}

function readJsonBody(request, maxBytes, onError) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('request body too large'));
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
      const type = str(request.headers['content-type']);
      const looksJson = text.startsWith('{') || text.startsWith('[');
      // curl and a few frameworks send JSON with a form content-type, so the
      // body's shape wins over the header (NapCat normalises this by force).
      if (!looksJson && type.includes('application/x-www-form-urlencoded')) {
        const out = {};
        for (const [key, value] of new URLSearchParams(text)) {
          try {
            out[key] = JSON.parse(value);
          } catch (e) {
            out[key] = value;
          }
        }
        resolve(out);
        return;
      }
      try {
        const value = JSON.parse(text);
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      } catch (error) {
        if (onError) onError();
        reject(new Error('invalid JSON body'));
      }
    });
    request.on('error', reject);
  });
}

class WsSession {
  constructor(connection, options) {
    this.connection = connection;
    this.role = options.role;
    this.protocol = options.protocol;
    this.owner = options.owner || null;
    this.log = options.log;
    this.heartbeatInterval = num(options.heartbeatInterval) || 30000;
    this.sendsPing = options.sendsPing !== false;
    this.timers = [];
    this.closed = false;

    connection.on('message', (text) => this.onMessage(text));
    connection.on('close', () => this.dispose());
    connection.on('error', (error) => {
      this.log.debug(`ws error: ${error.message}`);
      this.dispose();
    });
    this.start();
  }

  get acceptsEvents() {
    return this.role !== ROLE_API;
  }

  get acceptsActions() {
    return this.role !== ROLE_EVENT;
  }

  start() {
    const selfId = num(this.protocol.selfId);
    if (this.acceptsEvents) {
      // Frameworks key their reconnect logic off the connect lifecycle.
      this.send(lifecycleEvent(selfId, 'connect'));
      this.send(lifecycleEvent(selfId, 'enable'));
      this.send(heartbeatEvent(selfId, this.heartbeatInterval, this.protocol.online));
      this.timers.push(setInterval(() => {
        this.send(heartbeatEvent(this.protocol.selfId, this.heartbeatInterval, this.protocol.online));
      }, this.heartbeatInterval));
    }
    if (this.sendsPing) {
      // Keeps intermediaries from dropping an idle event socket, detects a peer
      // that vanished without sending FIN (a killed framework process), and
      // gives the RFC6455 peer a chance to answer.
      this.timers.push(setInterval(() => {
        if (this.connection.readyState !== 1) return;
        const idle = Date.now() - (this.connection.lastActivity || Date.now());
        if (idle > Math.max(60000, this.heartbeatInterval * 2)) {
          this.log.warn(`websocket peer silent for ${Math.round(idle / 1000)}s; dropping it`);
          this.connection.terminate();
          return;
        }
        this.connection.ping();
      }, 30000));
    }
    for (const timer of this.timers) timer.unref?.();
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.owner) this.owner.forgetSession(this);
  }

  send(value) {
    if (this.closed || this.connection.readyState !== 1) return false;
    return this.connection.send(JSON.stringify(value));
  }

  async onMessage(text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch (error) {
      this.send(OB11Response.error('json parse failed', RC.BAD_PARAM, null));
      return;
    }
    if (!frame || typeof frame !== 'object') {
      this.send(OB11Response.error('invalid payload', RC.BAD_PARAM, null));
      return;
    }
    if (!this.acceptsActions) {
      this.log.debug('event-role socket sent an action; ignored');
      return;
    }
    const action = str(frame.action);
    if (!action) {
      this.send(OB11Response.error('missing action', RC.BAD_PARAM, frame.echo));
      return;
    }
    const params = frame.params && typeof frame.params === 'object' ? frame.params : {};
    const result = await this.protocol.handleAction(action, params, frame.echo);
    this.send(result);
  }
}

// Broadcast helper shared by the transports that hold event sockets.
class SessionSet {
  constructor() {
    this.sessions = new Set();
  }

  add(session) {
    this.sessions.add(session);
  }

  delete(session) {
    this.sessions.delete(session);
  }

  get size() {
    return this.sessions.size;
  }

  send(event) {
    const text = JSON.stringify(event);
    for (const session of this.sessions) {
      if (!session.acceptsEvents) continue;
      session.send(event);
    }
  }
}

module.exports = {
  ROLE_API,
  ROLE_EVENT,
  ROLE_UNIVERSAL,
  WsSession,
  SessionSet,
  normalizeRole,
  authorize,
  tokenFrom,
  readJsonBody
};
