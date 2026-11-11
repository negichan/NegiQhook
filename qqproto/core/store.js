'use strict';

// Protocol-neutral cache. The bridge sends normalised QQ events; the store
// keeps just enough state for protocol methods (lists, lookups, message ids)
// without ever reading QQ's databases or history.

class Store {
  constructor() {
    this.self = { uin: 0, uid: '', nick: '' };
    this.friends = new Map();          // uid -> friend
    this.friendsByUin = new Map();     // uin(string) -> friend
    this.groups = new Map();           // group_id(string) -> group
    this.members = new Map();          // group_id -> Map(uid -> member)
    this.messages = new Map();         // message_id -> event
    this.messageOrder = [];
    this.offline = false;
    this.lastEventAt = 0;
    this.startedAt = Date.now();
  }

  setSelf(self) {
    if (!self) return;
    if (self.uin) this.self.uin = Number(self.uin) || this.self.uin;
    if (self.uid) this.self.uid = self.uid;
    if (self.nick) this.self.nick = self.nick;
  }

  // A bridge hello means the account is usable again; `offline` is what a kick
  // sets, and only a fresh connection can clear it.
  markOnline() {
    this.offline = false;
  }

  setFriends(list) {
    this.friends.clear();
    this.friendsByUin.clear();
    for (const friend of list || []) {
      if (!friend || !friend.uid) continue;
      this.friends.set(friend.uid, friend);
      if (friend.uin) this.friendsByUin.set(String(friend.uin), friend);
    }
  }

  setGroups(list) {
    this.groups.clear();
    for (const group of list || []) {
      if (!group || !group.group_id) continue;
      this.groups.set(String(group.group_id), group);
    }
  }

  setMembers(groupId, list) {
    const key = String(groupId);
    const map = new Map();
    for (const member of list || []) {
      if (!member || !member.uid) continue;
      map.set(member.uid, member);
    }
    this.members.set(key, map);
  }

  hasGroup(id) {
    return this.groups.has(String(id));
  }

  group(id) {
    return this.groups.get(String(id)) || null;
  }

  friendByUin(uin) {
    return this.friendsByUin.get(String(uin)) || null;
  }

  friendByUid(uid) {
    return this.friends.get(String(uid)) || null;
  }

  memberUid(groupId, uin) {
    const map = this.members.get(String(groupId));
    if (!map) return '';
    for (const member of map.values()) {
      if (String(member.uin) === String(uin)) return member.uid;
    }
    return '';
  }

  applyEvent(event) {
    if (!event || typeof event !== 'object') return;
    this.lastEventAt = Date.now();
    if (event.self_id) this.self.uin = Number(event.self_id) || this.self.uin;

    if (event.type === 'message') {
      const sender = event.sender || {};
      if (sender.uin && sender.uid && String(sender.uin) !== String(this.self.uin)) {
        const known = this.friends.get(sender.uid);
        if (!known) {
          const friend = {
            uid: sender.uid,
            uin: String(sender.uin),
            nick: sender.nick || '',
            remark: sender.remark || '',
            display: sender.remark || sender.nick || String(sender.uin),
            // Someone we have only ever seen talk to us. It is enough to send
            // a reply back, but not enough to claim they are a contact.
            provisional: true
          };
          this.friends.set(friend.uid, friend);
          this.friendsByUin.set(friend.uin, friend);
        }
      }
      if (event.is_group && event.group_id) {
        const groupId = String(event.group_id);
        const group = this.groups.get(groupId);
        if (!group) {
          this.groups.set(groupId, {
            group_id: Number(event.group_id) || event.group_id,
            group_code: groupId,
            name: event.peer_name || '',
            member_count: 0,
            max_member_count: 0
          });
        } else if (!group.name && event.peer_name) {
          group.name = event.peer_name;
        }
        if (sender.uid) {
          let map = this.members.get(groupId);
          if (!map) {
            map = new Map();
            this.members.set(groupId, map);
          }
          const existing = map.get(sender.uid) || {};
          map.set(sender.uid, {
            ...existing,
            uid: sender.uid,
            uin: Number(sender.uin) || existing.uin || 0,
            nick: sender.nick || existing.nick || '',
            card: sender.card || existing.card || '',
            remark: sender.remark || existing.remark || ''
          });
        }
      }
      if (event.message_id) {
        this.messages.set(String(event.message_id), event);
        this.messageOrder.push(String(event.message_id));
        while (this.messageOrder.length > 2000) {
          const oldest = this.messageOrder.shift();
          this.messages.delete(oldest);
        }
      }
    }

    if (event.type === 'message_deleted' && event.message_id) {
      const existing = this.messages.get(String(event.message_id));
      if (existing) existing.deleted = true;
    }

    if (event.type === 'offline') {
      this.offline = true;
    }
  }

  message(id) {
    return this.messages.get(String(id)) || null;
  }

  messagesForChannel(channelId, limit) {
    const key = String(channelId);
    const out = [];
    for (let i = this.messageOrder.length - 1; i >= 0; i--) {
      const event = this.messages.get(this.messageOrder[i]);
      if (!event) continue;
      const candidate = event.is_group
        ? String(event.group_id)
        : String(event.peer_uin || (event.sender && event.sender.uin) || '');
      if (candidate !== key) continue;
      out.push(event);
      if (out.length >= limit) break;
    }
    return out;
  }
}

module.exports = { Store };
