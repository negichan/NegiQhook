'use strict';

// Protocol-neutral actions over the QQ bridge. Satori (and later OneBot) only
// translate their wire format to these calls; they never touch the bridge.

const { Store } = require('./store');
const { assessBridge, assertActionAllowed } = require('../lib/compat');
const { createImageSource } = require('../lib/image-source');

class Core {
  constructor({ rpc, store, logger, allowUntested = false, imageSource = null }) {
    this.rpc = rpc;
    this.store = store || new Store();
    this.log = logger;
    this.allowUntested = !!allowUntested;
    this.friendsAt = 0;
    this.groupsAt = 0;
    this.groupsFetched = false;
    this.membersAt = new Map();
    // Turns base64/data/file/http image references into local files before the
    // bridge sees them; injectable so offline tests can use a temp directory.
    this.images = imageSource || createImageSource({
      logger: this.log && this.log.child ? this.log.child('media') : this.log
    });
  }

  // Recomputed per call: the bridge can reconnect with a different build (a QQ
  // update between restarts) without the endpoint being restarted.
  compatibility() {
    return assessBridge(this.rpc.bridgeInfo, { allowUntested: this.allowUntested });
  }

  async call(action, params, timeoutMs) {
    assertActionAllowed(action, this.compatibility());
    return this.rpc.call(action, params, timeoutMs);
  }

  async ensureSelf(force = false) {
    if (!force && this.store.self.uin) return this.store.self;
    const self = await this.call('get_self', {}, 5000);
    this.store.setSelf(self);
    return this.store.self;
  }

  async friends(force = false) {
    if (!force && this.friendsAt && Date.now() - this.friendsAt < 30000) {
      return [...this.store.friends.values()];
    }
    const result = await this.call('get_friends', { force: !!force }, 20000);
    this.store.setFriends(result.friends || []);
    this.friendsAt = Date.now();
    return [...this.store.friends.values()];
  }

  async groups(force = false) {
    // An empty cache is retried immediately: a group-list fetch can lose the
    // native callback while the account still has groups.
    if (!force && this.groupsAt && Date.now() - this.groupsAt < 30000 &&
        this.store.groups.size > 0) {
      return [...this.store.groups.values()];
    }
    const result = await this.call('get_groups', { force: !!force }, 20000);
    this.store.setGroups(result.groups || []);
    this.groupsAt = Date.now();
    this.groupsFetched = true;
    return [...this.store.groups.values()];
  }

  async members(groupId, force = false) {
    const key = String(groupId);
    const at = this.membersAt.get(key) || 0;
    if (!force && at && Date.now() - at < 30000) {
      return [...(this.store.members.get(key) || new Map()).values()];
    }
    const result = await this.call('get_group_members', {
      group_id: key,
      force: !!force
    }, 20000);
    const list = result.members || [];
    this.store.setMembers(key, list);
    this.membersAt.set(key, Date.now());
    return list;
  }

  async user(id, groupId) {
    const key = String(id || '');
    if (!key) return null;
    if (groupId) {
      const member = this.store.members.get(String(groupId));
      if (member) {
        for (const item of member.values()) {
          if (String(item.uin) === key || item.uid === key) return item;
        }
      }
    }
    const friend = this.store.friendByUin(key) || this.store.friendByUid(key);
    if (friend) return friend;
    if (key === String(this.store.self.uin)) {
      return { uid: this.store.self.uid, uin: this.store.self.uin, nick: this.store.self.nick };
    }
    try {
      const result = await this.call('get_user', {
        uin: /^\d+$/.test(key) ? Number(key) : 0,
        uid: /^\d+$/.test(key) ? '' : key
      }, 8000);
      return result.user || null;
    } catch (error) {
      this.log.debug('user lookup failed:', error.message);
      return null;
    }
  }

  async resolveChannel(channelId) {
    const key = String(channelId);
    if (this.store.hasGroup(key)) {
      return { scene: 'group', group_id: key, peer_uid: key };
    }
    const friend = this.store.friendByUin(key) || this.store.friendByUid(key);
    if (friend) {
      return { scene: 'private', user_id: key, peer_uid: friend.uid };
    }
    // Neither cache knows the id. A numeric id that has never been matched
    // against a group could still be one, so fetch the group list once and
    // retry. After that, treat unknown ids as private.
    if (!this.groupsFetched && /^\d+$/.test(key)) {
      try {
        await this.groups();
      } catch (e) {
        this.log.debug('group resolve failed:', e.message);
      }
      if (this.store.hasGroup(key)) {
        return { scene: 'group', group_id: key, peer_uid: key };
      }
    }
    return { scene: 'private', user_id: key, peer_uid: '' };
  }

  async prepareSegments(segments, channel) {
    const prepared = [];
    for (const segment of segments || []) {
      if (segment.type === 'text') {
        prepared.push(segment);
        continue;
      }
      if (segment.type === 'at') {
        const target = String(segment.data && (segment.data.id || segment.data.qq) || '');
        if (!target || target === 'all') {
          prepared.push({ type: 'at', data: { qq: 'all', name: '全体成员' } });
          continue;
        }
        let uid = '';
        if (channel.scene === 'group') {
          uid = this.store.memberUid(channel.group_id, target);
          if (!uid) {
            try {
              await this.members(channel.group_id);
              uid = this.store.memberUid(channel.group_id, target);
            } catch (e) { /* best effort */ }
          }
        } else {
          const friend = this.store.friendByUin(target);
          uid = friend ? friend.uid : '';
        }
        prepared.push({
          type: 'at',
          data: {
            qq: target,
            uid: uid,
            name: (segment.data && segment.data.name) || target
          }
        });
        continue;
      }
      if (segment.type === 'image') {
        // A picture may arrive as a local path, a file:// URI, a base64://
        // payload, a data: URL or an http(s) URL - the spellings NapCat accepts.
        // The bridge and the kernel only read local files, so every other
        // spelling is decoded or downloaded into the image cache first and the
        // bridge still receives exactly one path.
        const data = segment.data || {};
        const raw = String(data.file || data.path || data.url || data.base64 || '');
        if (!raw) {
          const error = new Error('image needs a file that exists on this machine');
          error.code = 'bad_param';
          throw error;
        }
        let file;
        try {
          file = await this.images.resolve(raw);
        } catch (error) {
          if (!error.code) error.code = 'bad_param';
          throw error;
        }
        prepared.push({
          type: 'image',
          data: { file: file, summary: String(data.summary || '') }
        });
        continue;
      }
      if (segment.type === 'file') {
        // Same rule as pictures: the bytes must already be on this machine. The
        // bridge stages a copy under the client's own media tree and hands the
        // kernel a file element; the upload is the client's job.
        const data = segment.data || {};
        const file = String(data.file || data.path || '');
        if (!file) {
          const error = new Error('file needs a path that exists on this machine');
          error.code = 'bad_param';
          throw error;
        }
        prepared.push({
          type: 'file',
          data: { file: file, name: String(data.name || '') }
        });
        continue;
      }
      if (segment.type === 'reply') {
        // Only the id travels: the bridge looks the quoted message up in its own
        // cache because QQ addresses a reply by seq + msgId + sender, not by id.
        const id = String((segment.data && segment.data.id) || '');
        if (!id) {
          const error = new Error('reply needs the id of a message the bridge has seen');
          error.code = 'bad_param';
          throw error;
        }
        prepared.push({ type: 'reply', data: { id: id } });
        continue;
      }
      if (segment.type === 'face') {
        const id = String((segment.data && segment.data.id) || '');
        if (!id) {
          const error = new Error('face needs an id (the QQ face index)');
          error.code = 'bad_param';
          throw error;
        }
        prepared.push({
          type: 'face',
          data: { id: id, text: String((segment.data && segment.data.text) || '') }
        });
        continue;
      }
      const error = new Error(`sending "${segment.type}" segments is not implemented yet`);
      error.code = 'unsupported_segment';
      throw error;
    }
    return prepared;
  }

  async send(channelId, segments) {
    await this.ensureSelf();
    const channel = await this.resolveChannel(channelId);
    const prepared = await this.prepareSegments(segments, channel);
    const params = {
      elements: prepared
    };
    if (channel.scene === 'group') {
      params.scene = 'group';
      params.group_id = channel.group_id;
    } else {
      params.scene = 'private';
      params.user_id = channel.user_id;
      if (channel.peer_uid) params.peer_uid = channel.peer_uid;
    }
    const result = await this.call('send_message', params, 30000);
    return {
      channel: channel,
      message_id: result.message_id,
      client_id: result.client_id,
      time: result.time,
      confirmed: !!result.confirmed,
      // What QQ actually addressed. OneBot needs it to build the same message
      // id key the resulting outgoing event will produce.
      peer: result.peer || null,
      self: this.store.self
    };
  }

  async recall(channelId, messageId) {
    const key = String(messageId);
    const cached = this.store.message(key);
    let chatType = 0;
    let peerUid = '';
    if (cached) {
      chatType = Number(cached.chat_type) || 0;
      peerUid = String(cached.peer_uid || '');
    }
    if (!chatType || !peerUid) {
      const channel = await this.resolveChannel(channelId);
      chatType = channel.scene === 'group' ? 2 : 1;
      peerUid = channel.scene === 'group'
        ? channel.group_id
        : (channel.peer_uid || '');
    }
    if (!peerUid) throw new Error('cannot resolve the peer for this message');
    return this.call('recall', {
      message_id: key,
      chat_type: chatType,
      peer_uid: peerUid
    }, 15000);
  }

  // Recall addressed only by native message id, for protocols that keep their
  // own id table. The cached event wins because it carries QQ's real peer.
  async recallDirect({ messageId, chatType, peerUid }) {
    const key = String(messageId);
    const cached = this.store.message(key);
    if (cached) {
      return this.call('recall', {
        message_id: key,
        chat_type: Number(cached.chat_type) || chatType || 0,
        peer_uid: String(cached.peer_uid || peerUid || '')
      }, 15000);
    }
    if (!chatType || !peerUid) {
      throw new Error(`cannot resolve the peer for message ${key}`);
    }
    return this.call('recall', { message_id: key, chat_type: chatType, peer_uid: peerUid }, 15000);
  }

  message(id) {
    return this.store.message(id);
  }

  messages(channelId, limit = 50) {
    return this.store.messagesForChannel(channelId, Math.max(1, Math.min(limit, 100)));
  }
}

module.exports = { Core, Store };
