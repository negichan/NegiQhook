'use strict';

const { toOneBotSegments, toCqString, peerKeyOf, str, num } = require('./segments');

function roleOf(store, groupId, uid, uin) {
  const members = store.members.get(String(groupId));
  if (!members) return 'member';
  let member = (uid && members.get(uid)) || null;
  if (!member && uin) {
    for (const item of members.values()) {
      if (String(item.uin) === String(uin)) {
        member = item;
        break;
      }
    }
  }
  const role = member ? num(member.role) : 0;
  // QQ stores memberRole as 2=member, 3=admin, 4=owner (same table NapCat uses).
  if (role === 4) return 'owner';
  if (role === 3) return 'admin';
  return 'member';
}

function toMessageEvent(event, ctx) {
  const { store, unique } = ctx;
  const peerKey = peerKeyOf(event);
  const messageId = unique.createUniqueMsgId(peerKey, event.message_id);
  const selfUin = num(store.self.uin);
  const senderUin = num(event.sender && event.sender.uin);
  const isGroup = !!event.is_group;
  const segments = toOneBotSegments(event.elements, {
    unique,
    peerKey,
    store,
    groupId: isGroup ? event.group_id : ''
  });
  // The bridge preview ("[图片]", "@张三") is for humans; OneBot clients parse
  // raw_message as CQ codes, so build it from the converted segments.
  const rawMessage = toCqString(segments);

  const sender = {
    user_id: senderUin,
    nickname: str(event.sender && event.sender.nick),
    card: str(event.sender && event.sender.card),
    role: isGroup ? roleOf(store, event.group_id, event.sender && event.sender.uid, senderUin) : 'friend',
    title: '',
    uid: str(event.sender && event.sender.uid)
  };

  const base = {
    time: num(event.time) || Math.floor(Date.now() / 1000),
    self_id: selfUin,
    message_id: messageId,
    message: segments,
    raw_message: rawMessage,
    font: 0,
    sender
  };

  if (isGroup) {
    return {
      ...base,
      post_type: 'message',
      message_type: 'group',
      sub_type: 'group',
      group_id: num(event.group_id),
      user_id: senderUin
    };
  }
  const friend = store.friendByUin(senderUin) || store.friendByUid(event.sender && event.sender.uid);
  // Contacts the bridge only ever saw talk to us are provisional: replying
  // works, but claiming they are in the friend list would be wrong.
  const isFriend = !!friend && !friend.provisional;
  const isSelf = senderUin && senderUin === selfUin;
  return {
    ...base,
    post_type: 'message',
    message_type: 'private',
    sub_type: isSelf ? 'self' : (isFriend ? 'friend' : 'other'),
    group_id: 0,
    user_id: senderUin,
    target_id: num(event.peer_uin) || senderUin,
    sender: { ...sender, role: isSelf ? 'self' : (isFriend ? 'friend' : 'unknown') }
  };
}

function toMessageSentEvent(event, ctx) {
  const message = toMessageEvent(event, ctx);
  message.post_type = 'message_sent';
  message.message_type = event.is_group ? 'group' : 'private';
  message.sub_type = event.is_group ? 'group' : 'friend';
  return message;
}

function toRecallNotice(event, ctx) {
  const { store, unique } = ctx;
  const peerKey = peerKeyOf(event);
  const messageId = unique.createUniqueMsgId(peerKey, event.message_id);
  const selfUin = num(store.self.uin);
  const operator = num(event.operator_uin) || selfUin;
  if (event.is_group) {
    return {
      post_type: 'notice',
      notice_type: 'group_recall',
      group_id: num(event.group_id),
      user_id: num(event.cached && event.cached.sender && event.cached.sender.uin) || operator,
      operator_id: operator,
      message_id: messageId,
      time: num(event.time) || Math.floor(Date.now() / 1000),
      self_id: selfUin
    };
  }
  return {
    post_type: 'notice',
    notice_type: 'friend_recall',
    user_id: num(event.peer_uin) || operator,
    group_id: 0,
    message_id: messageId,
    time: num(event.time) || Math.floor(Date.now() / 1000),
    self_id: selfUin
  };
}

// Add/join applications are "inspect"; being pulled in by someone else is
// "invite" - the two sub_type values OneBot v11 defines for group requests.
function groupRequestSubType(event) {
  const type = num(event.notify_type);
  if (type === 7) return 'add';
  if (type === 1 || type === 5) return 'invite';
  return str(event.request_type) === 'invite' ? 'invite' : 'add';
}

function toRequestEvent(event) {
  const base = {
    post_type: 'request',
    time: num(event.time) || Math.floor(Date.now() / 1000),
    self_id: num(event.self_id),
    comment: str(event.comment),
    flag: str(event.flag),
    user_id: num(event.user_id),
    user_uid: str(event.user_uid),
    user_nick: str(event.user_nick),
    create_time: num(event.created_time) || num(event.time)
  };
  if (event.kind === 'friend') {
    return {
      ...base,
      request_type: 'friend',
      group_id: 0,
      req_type: num(event.req_type),
      doubt: !!event.doubt
    };
  }
  return {
    ...base,
    request_type: 'group',
    sub_type: groupRequestSubType(event),
    group_id: num(event.group_id),
    group_name: str(event.group_name),
    seq: str(event.seq),
    notify_type: num(event.notify_type),
    doubt: !!event.doubt,
    // The flag of a group request is its seq; some clients echo it back under
    // either name, so both are present.
    toast: str(event.comment)
  };
}

function lifecycleEvent(selfId, subType) {
  return {
    post_type: 'meta_event',
    meta_event_type: 'lifecycle',
    sub_type: subType,
    self_id: num(selfId),
    time: Math.floor(Date.now() / 1000),
    interval: 30000
  };
}

function heartbeatEvent(selfId, intervalMs, online) {
  return {
    post_type: 'meta_event',
    meta_event_type: 'heartbeat',
    status: { online: !!online, good: !!online },
    self_id: num(selfId),
    time: Math.floor(Date.now() / 1000),
    interval: num(intervalMs) || 30000
  };
}

// Group membership changes come from the bridge as their own event (the kernel
// only ships them as gray tips inside a message). OneBot names them notices.
function toMemberNotice(event) {
  const left = event.action === 'quit';
  return {
    post_type: 'notice',
    notice_type: left ? 'group_decrease' : 'group_increase',
    sub_type: left ? 'leave' : 'approve',
    group_id: num(event.group_id),
    user_id: num(event.user_uin) || 0,
    operator_id: num(event.operator_uin) || 0,
    time: num(event.time) || Math.floor(Date.now() / 1000),
    self_id: num(event.self_id)
  };
}

// One kernel event may produce zero or one OneBot event; filtering decisions
// (self echo, message format) stay with the adapter that owns the option.
function toOneBotEvents(event, ctx) {
  if (!event || !event.type) return [];
  if (event.type === 'message') {
    if (event.direction === 'outgoing') {
      return [toMessageSentEvent(event, ctx)];
    }
    return [toMessageEvent(event, ctx)];
  }
  if (event.type === 'message_deleted') {
    return [toRecallNotice(event, ctx)];
  }
  if (event.type === 'request') {
    return [toRequestEvent(event)];
  }
  if (event.type === 'group_member') {
    return [toMemberNotice(event)];
  }
  if (event.type === 'offline') {
    return [{
      post_type: 'notice',
      notice_type: 'offline',
      self_id: num(ctx.store.self.uin),
      time: Math.floor(Date.now() / 1000),
      info: str(event.payload && (event.payload.tipsTitle || event.payload.title))
    }];
  }
  return [];
}

module.exports = {
  toOneBotEvents,
  toMessageEvent,
  toMessageSentEvent,
  toRecallNotice,
  toRequestEvent,
  lifecycleEvent,
  heartbeatEvent,
  roleOf
};
