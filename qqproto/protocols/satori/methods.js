'use strict';

const { parse } = require('./elements');
const {
  userDto,
  selfDto,
  guildDto,
  messageDto,
  channelDto
} = require('./convert');

class MethodError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The exact method table of @satorijs/protocol 1.7.0 (`Methods`). Anything here
// that this adapter cannot back is still routed, so a client gets 501 with a
// reason instead of a 404 that looks like a typo.
const KNOWN_METHODS = [
  'login.get', 'user.get',
  'friend.list', 'friend.delete', 'friend.approve',
  'guild.get', 'guild.list',
  'guild.member.get', 'guild.member.list', 'guild.member.kick', 'guild.member.mute',
  'guild.member.role.set', 'guild.member.role.unset', 'guild.member.role.list',
  'guild.role.list', 'guild.role.create', 'guild.role.update', 'guild.role.delete',
  'channel.get', 'channel.list', 'channel.create', 'channel.update', 'channel.delete', 'channel.mute',
  'user.channel.create',
  'message.get', 'message.list', 'message.create', 'message.update', 'message.delete',
  'reaction.create', 'reaction.delete', 'reaction.clear', 'reaction.list',
  'guild.approve', 'guild.member.approve',
  'upload.create'
];

// QQ has exactly three roles, and they are numbers on the member, not a table.
const QQ_ROLES = [
  { id: 'owner', name: '群主', color: 0 },
  { id: 'admin', name: '管理员', color: 0 },
  { id: 'member', name: '成员', color: 0 }
];

function nextPage(value) {
  return value === undefined || value === null || value === ''
    ? undefined
    : String(value);
}

function paginate(list, next, size = 100) {
  const start = Number(next) || 0;
  const page = list.slice(start, start + size);
  const more = start + page.length < list.length ? String(start + page.length) : undefined;
  return { data: page, next: nextPage(more) };
}

function str(value) {
  return value === undefined || value === null ? '' : String(value);
}

function id(value) {
  return str(value).trim();
}

function requireIds(params, ...names) {
  const missing = names.filter((name) => !id(params[name]));
  if (missing.length) throw new MethodError(400, missing.join(' and ') + ' is required');
}

// Satori sends booleans as real booleans, but a form-encoded body arrives as a
// string, so "false" must not read as true.
function boolOf(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') return !(value === 'false' || value === '0');
  return !!value;
}

function approveOf(params) {
  return boolOf(params.approve, true);
}

function roleIdOf(role) {
  if (Number(role) === 4) return 'owner';
  if (Number(role) === 3) return 'admin';
  return 'member';
}

function friendDto(friend) {
  const user = userDto({
    uin: friend.uin,
    uid: friend.uid,
    nick: friend.nick,
    card: ''
  });
  return {
    user: user,
    nick: friend.display || friend.remark || friend.nick || String(friend.uin)
  };
}

function memberDto(member) {
  const user = userDto(member);
  return {
    user: user,
    name: member.card || member.nick || (user && user.name) || '',
    nick: member.nick || (user && user.nick),
    avatar: user && user.avatar,
    roles: Number(member.role) === 4 || Number(member.role) === 3
      ? [{ id: roleIdOf(member.role), name: roleIdOf(member.role) === 'owner' ? '群主' : '管理员' }]
      : []
  };
}

function groupChannelDto(groupId, name) {
  return { id: String(groupId), type: 0, name: name || '' };
}

function directChannelDto(userId) {
  return { id: String(userId), type: 1 };
}

async function ensureGroups(core, store, groupId) {
  if (!groupId) return null;
  if (store.hasGroup(groupId)) return store.group(groupId);
  try {
    await core.groups(true);
  } catch (error) {
    return null;
  }
  return store.group(groupId);
}

async function ensureMembers(core, store, groupId, force = false) {
  // Core owns the cache TTL; this only adapts the Map shape for callers.
  await core.members(groupId, force);
  return store.members.get(String(groupId)) || new Map();
}

function findMember(map, userId) {
  const target = String(userId);
  for (const member of map.values()) {
    if (String(member.uin) === target || member.uid === target) return member;
  }
  return null;
}

function createHandlers({ core, store, protocol }) {
  // Every action below is a name scripts/proto_bridge.js already exposes; QQ
  // work stays there and this layer only renames fields.
  const kernel = (action, params, timeoutMs) => core.call(action, params, timeoutMs || 30000);

  const approveGroup = async (params) => {
    const flag = id(params.message_id);
    if (!flag) throw new MethodError(400, 'message_id is the flag of the join request');
    await kernel('handle_group_request', {
      seq: flag,
      approve: approveOf(params),
      reason: str(params.comment)
    });
    return null;
  };

  const setRole = (isSet) => async (params) => {
    requireIds(params, 'guild_id', 'user_id');
    const roleId = id(params.role_id).toLowerCase();
    if (!['admin', 'member', '3', '2'].includes(roleId)) {
      throw new MethodError(400,
        'QQ only has owner/admin/member; role_id must be "admin" or "member"');
    }
    const wantsAdmin = roleId === 'admin' || roleId === '3';
    await kernel('set_group_admin', {
      group_id: params.guild_id,
      user_id: params.user_id,
      enable: wantsAdmin && isSet
    });
    return null;
  };

  // QQ's "reaction" is one emoji-like per message per account: setting it adds
  // the like, clearing it takes that emoji away. There is no per-user removal.
  const reaction = (set) => async (params) => {
    requireIds(params, 'message_id');
    if (!id(params.emoji_id)) {
      throw new MethodError(400, 'emoji_id is required: QQ reacts with one emoji at a time');
    }
    await kernel('set_msg_reaction', {
      message_id: params.message_id,
      emoji_id: params.emoji_id,
      set: set
    }, 20000);
    return null;
  };

  const handlers = {
    'login.get': async () => protocol.login(),

    'user.get': async (params) => {
      const user = await core.user(params.user_id, params.guild_id);
      if (!user) throw new MethodError(404, 'user not found');
      return userDto(user);
    },

    'friend.list': async (params) => paginate((await core.friends(false)).map(friendDto), params.next),

    'friend.delete': async (params) => {
      const target = id(params.user_id);
      if (!target) throw new MethodError(400, 'user_id is required');
      await kernel('delete_friend', { user_id: target });
      return null;
    },

    'friend.approve': async (params) => {
      const flag = id(params.message_id);
      if (!flag) throw new MethodError(400, 'message_id is the flag of the friend request');
      await kernel('handle_friend_request', {
        req_time: flag,
        approve: approveOf(params),
        reason: str(params.comment)
      });
      return null;
    },

    'guild.list': async (params) =>
      paginate((await core.groups(false)).map(guildDto).filter(Boolean), params.next),

    'guild.get': async (params) => {
      const group = await ensureGroups(core, store, params.guild_id);
      if (!group) throw new MethodError(404, 'guild not found');
      return guildDto(group);
    },

    'guild.member.list': async (params) => {
      if (!id(params.guild_id)) throw new MethodError(400, 'guild_id is required');
      const map = await ensureMembers(core, store, params.guild_id, false);
      return paginate([...map.values()].map(memberDto), params.next);
    },

    'guild.member.get': async (params) => {
      requireIds(params, 'guild_id', 'user_id');
      const map = await ensureMembers(core, store, params.guild_id, false);
      const member = findMember(map, params.user_id);
      if (!member) throw new MethodError(404, 'member not found');
      return memberDto(member);
    },

    'guild.member.kick': async (params) => {
      requireIds(params, 'guild_id', 'user_id');
      await kernel('set_group_kick', {
        group_id: params.guild_id,
        user_id: params.user_id,
        reject_add_request: !!params.permanent
      });
      return null;
    },

    'guild.member.mute': async (params) => {
      requireIds(params, 'guild_id', 'user_id');
      const duration = Math.max(0, Number(params.duration) || 0);
      // QQ counts seconds and treats 0 as "lift the mute", same as Satori.
      await kernel('set_group_ban', {
        group_id: params.guild_id,
        user_id: params.user_id,
        duration: duration
      });
      return null;
    },

    'guild.member.role.set': setRole(true),
    'guild.member.role.unset': setRole(false),

    'guild.member.role.list': async (params) => {
      requireIds(params, 'guild_id', 'user_id');
      const map = await ensureMembers(core, store, params.guild_id, false);
      const member = findMember(map, params.user_id);
      if (!member) throw new MethodError(404, 'member not found');
      return { data: [{ id: roleIdOf(member.role) }] };
    },

    // QQ keeps no role table; these three entries are what its numbers mean.
    'guild.role.list': async (params) => {
      if (!id(params.guild_id)) throw new MethodError(400, 'guild_id is required');
      return { data: QQ_ROLES.map((role) => ({ ...role })) };
    },

    'channel.get': async (params) => {
      const channelId = id(params.channel_id);
      if (!channelId) throw new MethodError(400, 'channel_id is required');
      const group = store.group(channelId) ||
        await ensureGroups(core, store, params.guild_id || channelId);
      if (group) return groupChannelDto(channelId, group.name);
      return directChannelDto(channelId);
    },

    'channel.list': async (params) => {
      if (!id(params.guild_id)) return { data: [] };
      const group = await ensureGroups(core, store, params.guild_id);
      if (!group) return { data: [] };
      return { data: [groupChannelDto(group.group_id, group.name)] };
    },

    // QQ has no "create a group/channel" surface here; a direct channel is
    // simply the peer's uin.
    'user.channel.create': async (params) => {
      if (!id(params.user_id)) throw new MethodError(400, 'user_id is required');
      return directChannelDto(params.user_id);
    },

    'channel.update': async (params) => {
      const channelId = id(params.channel_id);
      if (!channelId) throw new MethodError(400, 'channel_id is required');
      const data = params.data && typeof params.data === 'object' ? params.data : {};
      const name = str(data.name || params.name);
      if (!name) throw new MethodError(400, 'only the group name can be updated; data.name is required');
      await kernel('set_group_name', { group_id: channelId, group_name: name });
      return null;
    },

    'channel.mute': async (params) => {
      const channelId = id(params.channel_id || params.guild_id);
      if (!channelId) throw new MethodError(400, 'channel_id is required');
      // Spec: enable (boolean). NoneBot's adapter sends { duration } instead,
      // where 0 means "unmute"; respect it so a duration of 0 never mutes.
      const enable = params.enable === undefined && params.duration !== undefined
        ? Number(params.duration) > 0
        : boolOf(params.enable, true);
      await kernel('set_group_whole_ban', { group_id: channelId, enable: enable });
      return null;
    },

    'message.create': async (params) => {
      if (!id(params.channel_id)) throw new MethodError(400, 'channel_id is required');
      const segments = parse(params.content);
      if (segments.length === 0) throw new MethodError(400, 'message content is empty');
      // Satori's way of replying is `referrer` (usually the quoted Message). The
      // bridge can only quote a message it has seen, and it addresses the quote
      // by seq/msgId/sender, so pass the id through and let it resolve.
      if (params.referrer !== undefined && params.referrer !== null) {
        const quoted = typeof params.referrer === 'object'
          ? id(params.referrer.id || (params.referrer.message && params.referrer.message.id))
          : id(params.referrer);
        if (!quoted) {
          throw new MethodError(400, 'referrer needs the id of a message the bridge has seen');
        }
        segments.unshift({ type: 'reply', data: { id: quoted } });
      }
      return sendSegments(params, segments);
    },

    'message.get': async (params) => {
      if (!id(params.channel_id)) throw new MethodError(400, 'channel_id is required');
      if (!id(params.message_id)) throw new MethodError(400, 'message_id is required');
      const event = store.message(params.message_id);
      if (!event) throw new MethodError(404, 'message not found in the local cache');
      return messageDto(event, store);
    },

    'message.list': async (params) => {
      if (!id(params.channel_id)) throw new MethodError(400, 'channel_id is required');
      const size = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
      const start = Math.max(0, Number(params.next) || 0);
      const direction = str(params.direction).toLowerCase();
      let order = str(params.order).toLowerCase();
      // `direction` is about where the page sits relative to `next`; with no
      // explicit order it is the same question as asc/desc for our flat cache.
      if (!order) order = direction === 'after' ? 'asc' : 'desc';
      const events = core.messages(params.channel_id, start + size + 1);
      const list = events.map((event) => messageDto(event, store));
      if (order === 'asc') list.reverse();
      const page = list.slice(start, start + size);
      return {
        data: page,
        prev: start > 0 ? String(Math.max(0, start - size)) : undefined,
        next: start + page.length < list.length ? String(start + page.length) : undefined
      };
    },

    'message.delete': async (params) => {
      requireIds(params, 'channel_id', 'message_id');
      await core.recall(params.channel_id, params.message_id);
      return null;
    },

    'reaction.create': reaction(true),
    'reaction.delete': reaction(false),
    'reaction.clear': reaction(false),

    // upload.create is multipart/form-data, so index.js takes the request before
    // it is parsed as JSON; this entry only makes the method show up in
    // login.features and gives a reason when it is called the wrong way.
    'upload.create': async () => {
      throw new MethodError(400,
        'upload.create needs a multipart/form-data body with one or more files');
    },

    'guild.approve': approveGroup,
    'guild.member.approve': approveGroup
  };

  async function sendSegments(params, segments) {
    const result = await core.send(params.channel_id, segments);
    const group = result.channel.scene === 'group'
      ? store.group(result.channel.group_id)
      : null;
    return [{
      id: String(result.message_id),
      channel: group
        ? groupChannelDto(group.group_id, group.name)
        : directChannelDto(params.channel_id),
      guild: group ? guildDto(group) : undefined,
      user: selfDto(store),
      content: params.content,
      timestamp: (Number(result.time) || Math.floor(Date.now() / 1000)) * 1000
    }];
  }

  const features = Object.keys(handlers);
  for (const name of KNOWN_METHODS) {
    if (handlers[name]) continue;
    // Keep the reason honest per method instead of one blanket sentence.
    const why = {
      'message.update': 'QQ has no edit-message API in this kernel build',
      'reaction.list': 'QQ can set a reaction but not list who reacted',
      'channel.create': 'creating a group is not exposed by the kernel services this project uses',
      'channel.delete': 'leaving or dissolving a group is deliberately manual',
      'guild.role.create': 'QQ roles are fixed (owner/admin/member), not a table',
      'guild.role.update': 'QQ roles are fixed (owner/admin/member), not a table',
      'guild.role.delete': 'QQ roles are fixed (owner/admin/member), not a table',
      'upload.create': 'uploads are handled by the endpoint itself'
    }[name];
    handlers[name] = async () => {
      throw new MethodError(501, `${name} is not supported by the QQ adapter` + (why ? `: ${why}` : ''));
    };
  }

  return { handlers, features };
}

module.exports = {
  MethodError,
  KNOWN_METHODS,
  createHandlers,
  groupChannelDto,
  directChannelDto,
  memberDto,
  friendDto
};
