'use strict';

// OneBot v11 message_id is a number, but QQ's native msgId is a 64-bit decimal
// string (e.g. 7700889304421466889) that loses precision as a JS number, so it
// cannot be handed to clients directly. Same reason NapCat has MessageUnique
// and SnowLuma hashMessageIdInt32: the adapter needs its own id table.
//
// Unlike a hash, ids here are injective and reversible, which is what
// get_msg / delete_msg need.

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 20000;

class MessageUnique {
  constructor({ file, logger } = {}) {
    this.file = file || '';
    this.log = logger;
    this.next = 1;
    this.byId = new Map();       // int id -> { peerKey, nativeId }
    this.byNative = new Map();   // "peerKey|nativeId" -> int id
    this.order = [];
    this.saveTimer = null;
    this.loaded = false;
  }

  key(peerKey, nativeId) {
    return `${peerKey}|${nativeId}`;
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.next = Number(raw.next) || 1;
      for (const [id, entry] of Object.entries(raw.map || {})) {
        const numeric = Number(id);
        if (!Number.isSafeInteger(numeric) || !entry || entry.length < 2) continue;
        const record = { peerKey: String(entry[0]), nativeId: String(entry[1]) };
        this.byId.set(numeric, record);
        this.byNative.set(this.key(record.peerKey, record.nativeId), numeric);
        this.order.push(numeric);
      }
      if (this.log) this.log.debug(`message ids restored: ${this.byId.size}`);
    } catch (error) {
      if (this.log && error.code !== 'ENOENT') {
        this.log.warn('message id table unreadable, starting fresh:', error.message);
      }
    }
  }

  scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 2000);
    this.saveTimer.unref?.();
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const map = {};
      for (const [id, entry] of this.byId) {
        map[String(id)] = [entry.peerKey, entry.nativeId];
      }
      fs.writeFileSync(this.file, JSON.stringify({ next: this.next, map }));
    } catch (error) {
      if (this.log) this.log.warn('message id table save failed:', error.message);
    }
  }

  // Idempotent: the same (peer, native id) always maps back to the same number.
  createUniqueMsgId(peerKey, nativeId) {
    this.load();
    if (!nativeId) return 0;
    const existing = this.byNative.get(this.key(String(peerKey), String(nativeId)));
    if (existing !== undefined) return existing;

    const id = this.next++;
    this.byId.set(id, { peerKey: String(peerKey), nativeId: String(nativeId) });
    this.byNative.set(this.key(String(peerKey), String(nativeId)), id);
    this.order.push(id);
    while (this.order.length > MAX_ENTRIES) {
      const oldest = this.order.shift();
      const entry = this.byId.get(oldest);
      if (entry) this.byNative.delete(this.key(entry.peerKey, entry.nativeId));
      this.byId.delete(oldest);
    }
    this.scheduleSave();
    return id;
  }

  resolve(id) {
    this.load();
    return this.byId.get(Number(id)) || null;
  }

  findId(peerKey, nativeId) {
    this.load();
    const found = this.byNative.get(this.key(String(peerKey), String(nativeId)));
    return found === undefined ? 0 : found;
  }

  get size() {
    this.load();
    return this.byId.size;
  }
}

module.exports = { MessageUnique };
