'use strict';

// HTTP event report client (HTTP 报告 / 事件上报). Fire-and-forget with a short
// timeout: a bot server that is down must never stall the QQ bridge.

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const { NetworkAdapter } = require('./adapter');
const { num, str } = require('../segments');

class HttpPostAdapter extends NetworkAdapter {
  constructor(name, config, protocol, logger) {
    super(name, 'http-post', config, protocol, logger);
    this.url = str(config.url);
    this.secret = str(config.secret);
    this.token = str(config.token || protocol.token);
    this.timeout = Math.max(500, num(config.timeout) || 10000);
    this.succeeded = 0;
    this.failed = 0;
    this.lastError = '';
  }

  async onOpen() {
    if (!this.url) throw new Error(`${this.name}: HTTP report needs a url`);
    try {
      this.parsed = new URL(this.url);
    } catch (error) {
      throw new Error(`${this.name}: invalid report url ${this.url}`);
    }
    this.listening = true;
    this.log.info(`[${this.name}] OneBot HTTP report -> ${this.url}`);
  }

  async onClose() {
    this.listening = false;
  }

  onEvent(event) {
    if (event && event.meta_event_type === 'heartbeat' && this.config.heartbeat === false) return;
    this._post(event);
  }

  _post(event) {
    const body = Buffer.from(JSON.stringify(event), 'utf8');
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'User-Agent': 'OneBot/11',
      'X-Self-ID': str(this.protocol.selfId)
    };
    if (this.secret) {
      headers['X-Signature'] = `sha1=${crypto.createHmac('sha1', this.secret).update(body).digest('hex')}`;
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const transport = this.parsed.protocol === 'https:' ? https : http;
    const request = transport.request(this.parsed, {
      method: 'POST',
      headers,
      timeout: this.timeout
    }, (response) => {
      // The body is irrelevant; draining keeps keep-alive sockets reusable.
      response.resume();
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          this.succeeded++;
        } else {
          this.failed++;
          this.lastError = `status ${response.statusCode}`;
          this.log.warn(`[${this.name}] report rejected with ${response.statusCode}`);
        }
      });
    });
    request.on('timeout', () => {
      this.lastError = 'timeout';
      request.destroy(new Error('report timeout'));
    });
    request.on('error', (error) => {
      this.failed++;
      this.lastError = error.message;
      this.log.debug(`[${this.name}] report failed: ${error.message}`);
    });
    request.end(body);
  }

  detail() {
    return `${this.url} · 成功 ${this.succeeded} / 失败 ${this.failed}` +
      (this.lastError ? `（${this.lastError}）` : '');
  }
}

module.exports = { HttpPostAdapter };
