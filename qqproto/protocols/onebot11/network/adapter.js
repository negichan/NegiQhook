'use strict';

// Adapter lifecycle contract, mirroring the role SnowLuma's
// IOneBotNetworkAdapter and NapCat's IOB11NetworkAdapter play: open, close,
// receive converted events, and describe themselves for the status page.

class NetworkAdapter {
  constructor(name, kind, config, protocol, logger) {
    this.name = name;
    this.kind = kind;
    this.config = config || {};
    this.protocol = protocol;
    this.log = logger;
    this.enabled = false;
    this.listening = false;
    this.startedAt = 0;
    // Per-transport message format, the way NapCat exposes it per network.
    this.messagePostFormat = this.config.messagePostFormat === 'string' ? 'string' : 'array';
  }

  get wantsOpen() {
    return this.config.enable !== false && this.config.enabled !== false;
  }

  async open() {
    if (this.enabled) return;
    if (!this.wantsOpen) return;
    await this.onOpen();
    this.enabled = true;
    this.startedAt = Date.now();
  }

  async close() {
    if (!this.enabled) return;
    this.enabled = false;
    await this.onClose();
  }

  // Default: adapters with no event sink (pure action servers) ignore events.
  onEvent() {
  }

  describeStatus() {
    return {
      name: this.name,
      kind: this.kind,
      // wantsOpen but not enabled means open() threw (e.g. the port was taken):
      // that is a failure the config page must show, not a deliberate "disabled".
      status: this.enabled ? (this.listening ? 'ok' : 'down') : (this.wantsOpen ? 'failed' : 'disabled'),
      detail: this.detail ? this.detail() : ''
    };
  }
}

module.exports = { NetworkAdapter };
