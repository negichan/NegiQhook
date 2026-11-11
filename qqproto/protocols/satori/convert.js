'use strict';

const { encode } = require('./elements');

const PLATFORM = 'qq';

// QQ stores an @ as a uid, but Satori user ids on this platform are uins.
// Resolve through the local caches when possible, otherwise keep the uid so
// the mention is still visible.
function normalizeAtSegments(segments, store) {
  if (!store) return segments;
  return (segments || []).map((segment) => {
    if (!segment || segment.type !== 'at') return segment;
    const data = segment.data || {};
    const current = String(data.qq || '');
    if (/^\d+$/.test(current) || current === 'all') return segment;
    const uid = String(data.uid || current || '');
    if (!uid) return segment;
    const friend = store.friendByUid(uid);
    if (friend && friend.uin) {
      return { type: 'at', data: { ...data, qq: String(friend.uin) } };
    }
    for (const members of store.members.values()) {
      const member = members.get(uid);
      if (member && member.uin) {
        return { type: 'at', data: { ...data, qq: String(member.uin) } };
      }
    }
    return segment;
  });
}

function avatarUrl(uin) {
  if (!uin) return undefined;
  return `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640`;
}

function userDto(sender) {
  if (!sender) return null;
  const uin = sender.uin || sender.user_id || 0;
  const id = String(uin || sender.uid || '');
  if (!id) return null;
  const nick = sender.nick || sender.nickname || '';
  const card = sender.card || '';
  return {
    id: id,
    name: card || nick || id,
    nick: nick || undefined,
    avatar: avatarUrl(uin)
  };
}

function selfDto(store) {
  const self = store.self;
  return {
    id: String(self.uin || ''),
    name: self.nick || String(self.uin || ''),
    nick: self.nick || undefined,
    avatar: avatarUrl(self.uin)
  };
}

function guildDto(group) {
  if (!group) return undefined;
  const id = String(group.group_id || group.group_code || '');
  if (!id) return undefined;
  return {
    id: id,
    name: group.name || '',
    avatar: undefined
  };
}

function channelDto(event, group) {
  if (event.is_group) {
    return {
      id: String(event.group_id),
      type: 0, // TEXT
      name: (group && group.name) || event.peer_name || ''
    };
  }
  const id = String(event.peer_uin || (event.sender && event.sender.uin) || '');
  return { id, type: 1 }; // DIRECT
}

function messageDto(event, store) {
  const group = event.is_group ? store.group(event.group_id) : null;
  const user = userDto(event.sender) || selfDto(store);
  // createdAt (ms) is what @satorijs/protocol and the NoneBot adapter read;
  // timestamp stays for older clients that still look at the deprecated field.
  const created = (Number(event.time) || Math.floor(Date.now() / 1000)) * 1000;
  return {
    id: String(event.message_id || ''),
    channel: channelDto(event, group),
    guild: event.is_group ? guildDto(group) : undefined,
    user: user,
    member: event.is_group ? {
      user: user,
      name: (event.sender && (event.sender.card || event.sender.nick)) || user.name,
      nick: (event.sender && event.sender.nick) || user.nick,
      avatar: user.avatar
    } : undefined,
    content: encode(normalizeAtSegments(event.elements, store)),
    timestamp: created,
    created_at: created
  };
}

function messageCreated(event, store) {
  const message = messageDto(event, store);
  return {
    type: 'message-created',
    channel: message.channel,
    guild: message.guild,
    user: message.user,
    member: message.member,
    message: message,
    message_id: message.id
  };
}

function messageDeleted(event, store) {
  const group = event.is_group ? store.group(event.group_id) : null;
  const channel = channelDto(event, group);
  const original = event.cached || store.message(event.message_id);
  // MessageEvent in the official adapters requires a top-level user, even on a
  // delete notice. The cached author is exact; the operator who recalled it is
  // the only other name on the event, and saying nothing beats inventing one.
  const user = (original && userDto(original.sender)) ||
    (Number(event.operator_uin)
      ? { id: String(event.operator_uin), name: event.operator_nick || String(event.operator_uin) }
      : null);
  if (!user) return null;
  return {
    type: 'message-deleted',
    channel: channel,
    guild: event.is_group ? guildDto(group) : undefined,
    user: user,
    message: {
      id: String(event.message_id || ''),
      channel: channel,
      guild: event.is_group ? guildDto(group) : undefined,
      user: user
    },
    message_id: String(event.message_id || '')
  };
}

// A Satori request event carries the flag of the application in `message.id`,
// which is what friend.approve / guild.member.approve take back. QQ groups are
// the guild, so a join request is a guild-member request; there is no separate
// "join the server" step to report as guild-request.
function requestEvent(event) {
  const isFriend = event.kind !== 'group';
  const flag = String(event.flag || event.seq || '');
  const uin = Number(event.user_id) || 0;
  const id = String(uin || event.user_uid || '');
  const user = {
    id: id,
    name: event.user_nick || id,
    nick: event.user_nick || undefined,
    avatar: avatarUrl(uin)
  };
  const when = (Number(event.time) || Math.floor(Date.now() / 1000)) * 1000;
  const channel = isFriend
    ? { id: id, type: 1 } // DIRECT
    : { id: String(event.group_id || ''), type: 0, name: event.group_name || '' };
  const guild = isFriend ? undefined : { id: String(event.group_id || ''), name: event.group_name || '' };
  const member = { user: user, name: user.name, nick: user.nick, avatar: user.avatar };
  return {
    type: isFriend ? 'friend-request' : 'guild-member-request',
    user: user,
    channel: channel,
    guild: guild,
    // GuildMemberRequestEvent requires a member in the official adapters.
    member: isFriend ? undefined : member,
    message: {
      id: flag,
      content: String(event.comment || ''),
      user: user,
      channel: channel,
      guild: guild,
      timestamp: when
    }
  };
}

// "someone joined / left" comes from the bridge as its own event because the
// kernel only ever ships it as a gray tip inside a message.
function memberChanged(event, store) {
  const group = store.group(event.group_id);
  const guild = guildDto(group) ||
    (event.group_id ? { id: String(event.group_id), name: event.group_name || '' } : undefined);
  const uin = Number(event.user_uin) || 0;
  const id = String(uin || event.user_uid || '');
  const user = {
    id: id,
    name: event.user_nick || id,
    nick: event.user_nick || undefined,
    avatar: avatarUrl(uin)
  };
  const operatorUin = Number(event.operator_uin) || 0;
  return {
    type: event.action === 'quit' ? 'guild-member-removed' : 'guild-member-added',
    guild: guild,
    channel: event.group_id
      ? { id: String(event.group_id), type: 0, name: (guild && guild.name) || event.group_name || '' }
      : undefined,
    user: user,
    member: { user: user, name: user.name, nick: user.nick, avatar: user.avatar },
    operator: (operatorUin || event.operator_uid)
      ? { id: String(operatorUin || event.operator_uid), name: event.operator_nick || '' }
      : undefined
  };
}

// Echo of a message this account sent, from onAddSendMsg. Satori's name for it
// is `send`; broadcasting it as message-created would make a bot answer itself.
function sendEvent(event, store) {
  const message = messageDto(event, store);
  return {
    type: 'send',
    channel: message.channel,
    guild: message.guild,
    user: message.user,
    member: message.member,
    message: message
  };
}

module.exports = {
  PLATFORM,
  avatarUrl,
  userDto,
  selfDto,
  guildDto,
  channelDto,
  messageDto,
  messageCreated,
  messageDeleted,
  requestEvent,
  memberChanged,
  sendEvent
};
