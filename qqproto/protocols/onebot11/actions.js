'use strict';

// OneBot v11 action registry. Every transport (HTTP POST, HTTP GET, WebSocket
// server, reverse WebSocket) routes through handleAction(), so the response
// envelope is built in exactly one place - the same role OneBotAction.handle()
// plays in NapCat.

const {
  SendError,
  parseMessage,
  peerKeyFromSend,
  peerFromKey,
  toBridgeSegments,
  str,
  num
} = require('./segments');
const { toMessageEvent } = require('./events');

// Retcodes follow NapCat's published table so clients that special-case them
// keep working: 0 ok, 1200 internal, 1400 bad params / unimplemented,
// 1401 no permission, 1403 bad token, 1404 not found.
const RC = {
  OK: 0,
  ASYNC: 100,
  INTERNAL: 1200,
  BAD_PARAM: 1400,
  NO_PERMISSION: 1401,
  BAD_TOKEN: 1403,
  NOT_FOUND: 1404
};

const OB11Response = {
  create(data, status, retcode, message, echo) {
    return {
      status,
      retcode,
      data: data === undefined ? null : data,
      message: message || '',
      wording: message || '',
      echo: echo === undefined ? null : echo
    };
  },
  ok(data, echo) {
    return OB11Response.create(data, 'ok', RC.OK, '', echo);
  },
  error(message, retcode, echo) {
    return OB11Response.create(null, 'failed', retcode || RC.INTERNAL, message, echo);
  }
};

function fail(retcode, message) {
  throw new SendError(retcode, message);
}

function pick(params, ...names) {
  for (const name of names) {
    const value = params ? params[name] : undefined;
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function required(params, ...names) {
  const value = pick(params, ...names);
  if (value === undefined) fail(RC.BAD_PARAM, `missing required parameter: ${names[0]}`);
  return value;
}

// force/no_cache are the two spellings clients use for "skip the cache".
function wantsForce(params) {
  if (!params) return false;
  if (params.force === true || params.force === 1 || num(params.force) === 1) return true;
  return !!num(pick(params, 'no_cache'));
}

function avatarUrl(uin) {
  const id = str(uin);
  return id ? `https://qq.qpic.cn/qq-pic/get?t=qlogo&fm=200&id=${id}&att=1` : '';
}

// OneBot clients send booleans as the strings "true"/"false" over HTTP.
function boolParam(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') return !(value === 'false' || value === '0');
  return !!value;
}

// "60s" / "3600s" / "d" are the spellings some frameworks use for a mute
// length instead of a number of seconds.
function durationOf(params, fallback) {
  const quick = str(pick(params, 'quick'));
  if (quick === '60s') return 60;
  if (quick === '3600s') return 3600;
  if (quick === 'd') return 86400;
  const duration = pick(params, 'duration');
  if (duration !== undefined) return num(duration);
  if (params && params.enable === false) return 0;
  return fallback;
}

// QQ reports its own refusal codes in the bridge error text (for example
// result=120101005 with ERR_NOT_GROUP_ADMIN when the account is not an admin),
// and the endpoint has to turn that into the retcode OneBot clients expect.
const PERMISSION_PATTERN = /result=(5|120101005|120101042|120101046|120101102)\b|not.?group.?admin|no.?permission|insufficient|privilege|权限/i;
const UNAVAILABLE_PATTERN = /not available on this qq build|no such method|unsupported/i;
const NOT_CACHED_PATTERN = /not in the bridge cache|no kernel sequence|is not cached|unknown message/i;

function kernelRetcode(message) {
  const text = str(message);
  if (PERMISSION_PATTERN.test(text)) return RC.NO_PERMISSION;
  if (NOT_CACHED_PATTERN.test(text)) return RC.NOT_FOUND;
  if (UNAVAILABLE_PATTERN.test(text)) return RC.BAD_PARAM;
  return RC.INTERNAL;
}

function friendDto(friend) {
  const uin = num(friend.uin);
  return {
    user_id: uin,
    uid: str(friend.uid),
    nickname: str(friend.nick),
    remark: str(friend.remark || friend.nick),
    displayname: str(friend.display || friend.remark || friend.nick),
    sex: 0,
    age: 0,
    level: 0,
    category_id: 0,
    join_time: 0,
    group_id: 0,
    avatar: avatarUrl(uin)
  };
}

function groupDto(group) {
  return {
    group_id: num(group.group_id),
    group_code: str(group.group_code || group.group_id),
    group_name: str(group.name),
    // Not part of the v11 list, but the kernel does carry the own remark the
    // user put on the group, and a caller that is about to overwrite it needs to
    // read the old value back.
    remark: str(group.remark),
    member_count: num(group.member_count),
    max_member_count: num(group.max_member_count),
    active_member_count: 0,
    type: '',
    info: ''
  };
}

function memberDto(groupId, member, selfUin) {
  const role = num(member.role);
  const shutUp = num(member.shut_up_time);
  return {
    group_id: num(groupId),
    user_id: num(member.uin),
    uid: str(member.uid),
    nickname: str(member.nick),
    card: str(member.card),
    remark: str(member.remark),
    sex: 0,
    age: 0,
    area: '',
    level: str(member.level),
    qq_level: 0,
    join_time: num(member.join_time),
    last_sent_time: num(member.last_sent_time),
    title_expire_time: num(member.title_expire_time),
    unfriendly: false,
    card_changeable: String(member.uin) !== String(selfUin),
    is_robot: !!member.is_robot,
    // The kernel reports the remaining mute seconds rather than an end time.
    shut_up_timestamp: shutUp,
    shut_up_remaining: shutUp,
    role: role === 4 ? 'owner' : role === 3 ? 'admin' : 'member',
    title: str(member.special_title)
  };
}

function messageDto(event, ctx) {
  const dto = toMessageEvent(event, ctx);
  dto.real_id = str(event.message_id);
  dto.sender_id = num(event.sender && event.sender.uin);
  dto.sender_nick = str(event.sender && event.sender.nick);
  dto.sender_card = str(event.sender && event.sender.card);
  dto.sender_time = num(event.time);
  dto.target_id = dto.message_type === 'group' ? num(event.group_id) : dto.user_id;
  dto.recalled = !!event.deleted;
  return dto;
}

function createActions({ core, store, unique, logger }) {
  const ctx = () => ({ store, unique });

  function toSendSegments(params) {
    const message = pick(params, 'message', 'msg');
    if (message === undefined) fail(RC.BAD_PARAM, 'missing required parameter: message');
    const autoEscape = message !== undefined &&
      (params.auto_escape === true || num(params.auto_escape) === 1);
    const segments = parseMessage(message, autoEscape);
    // Fail before the bridge is involved so the retcode and message stay ours.
    toBridgeSegments(segments);
    return segments;
  }

  async function sendTo(target, segments) {
    const result = await core.send(String(target), segments);
    const peerKey = peerKeyFromSend(result.peer) ||
      (result.channel.scene === 'group'
        ? `2:${result.channel.group_id}`
        : `1:${result.channel.peer_uid || result.channel.user_id}`);
    const messageId = unique.createUniqueMsgId(peerKey, result.message_id);
    return {
      message_id: messageId,
      real_id: str(result.message_id),
      time: num(result.time)
    };
  }

  // Cache-backed history only: the endpoint must never ask QQ to page through
  // scrollback, so a restart empties it.
  function history(channelId, count) {
    const limit = Math.max(1, Math.min(num(count) || 20, 100));
    return core.messages(channelId, limit).map((event) => messageDto(event, ctx()));
  }

  function resolveMessageId(params) {
    const raw = str(required(params, 'message_id'));
    const record = unique.resolve(raw);
    if (record) return record;
    // Accept a native msgId directly: QQ ids are long decimal strings, the
    // table ids are small counters.
    if (/^\d{13,}$/.test(raw)) return { peerKey: '', nativeId: raw };
    fail(RC.NOT_FOUND, `unknown message_id: ${raw}`);
    return null;
  }

  // One bridge call, with QQ's failure text translated into an OneBot retcode.
  // undefined parameters are dropped: the kernel reads absent keys as "use the
  // default", while an explicit undefined can reach it as a value.
  async function kernel(action, params, timeoutMs) {
    const payload = {};
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== '') payload[key] = value;
    }
    let result;
    try {
      result = await core.call(action, payload, timeoutMs || 20000);
    } catch (error) {
      const message = (error && error.message) || `${action} failed`;
      if (error && error.retcode) fail(error.retcode, message);
      // The version gate and the write budget happen before the kernel; their
      // codes must survive the local retcode translation.
      if (error && error.code === 'untested_version') fail(RC.NO_PERMISSION, message);
      fail(kernelRetcode(message), message);
    }
    return result || {};
  }

  // Read markers: a message id is the usual handle, a chat id works too.
  async function markRead(params) {
    const payload = {};
    if (params && params.message_id !== undefined) {
      payload.message_id = resolveMessageId(params).nativeId;
    } else if (params && params.group_id !== undefined) {
      payload.group_id = String(params.group_id);
    } else if (params && params.user_id !== undefined) {
      payload.user_id = String(params.user_id);
    } else {
      fail(RC.BAD_PARAM, 'missing required parameter: message_id, group_id or user_id');
    }
    return await kernel('mark_read', payload);
  }

  // An emoji reaction is addressed by the kernel sequence of a message the
  // bridge saw live, so the cache lookup happens on the injection side.
  async function reaction(params, set) {
    const record = resolveMessageId(params);
    const cached = store.message(record.nativeId) || {};
    const reactionValue = params && params.reaction;
    const emojiId = str(pick(params, 'emoji_id', 'key', 'name') ||
      (reactionValue && (reactionValue.type !== undefined ? reactionValue.id : reactionValue)));
    if (!emojiId) fail(RC.BAD_PARAM, 'missing required parameter: emoji_id');
    return kernel('set_msg_reaction', {
      message_id: record.nativeId,
      sequence: str(pick(params, 'sequence') || cached.sequence || ''),
      emoji_id: emojiId,
      emoji_type: str(pick(params, 'emoji_type')),
      set: set
    });
  }

  function essenceArgs(params, set) {
    const record = resolveMessageId(params);
    return {
      message_id: record.nativeId,
      group_id: str(pick(params, 'group_id') || ''),
      sequence: str(pick(params, 'sequence') || ''),
      random: str(pick(params, 'random') || ''),
      set: set
    };
  }

  // Forwarded messages arrive either as one id or as a node list, whose items
  // carry the message_id of a message we reported earlier.
  function nodeIds(params) {
    const ids = [];
    const single = pick(params, 'message_id');
    if (single !== undefined) ids.push(str(resolveMessageId({ message_id: single }).nativeId));
    const nodes = params && params.messages;
    for (const node of (Array.isArray(nodes) ? nodes : [])) {
      const value = node && (node.message_id !== undefined ? node.message_id :
        (node.data && node.data.id));
      if (value === undefined || value === null) continue;
      ids.push(str(resolveMessageId({ message_id: value }).nativeId));
    }
    return ids.filter(Boolean);
  }

  async function forward(params, targetKey) {
    const ids = nodeIds(params);
    if (!ids.length) fail(RC.BAD_PARAM, 'missing required parameter: messages or message_id');
    const payload = { message_id: ids[0] };
    if (ids.length > 1) payload.message_ids = ids;
    if (targetKey === 'group_id') payload.group_id = String(required(params, 'group_id'));
    else payload.user_id = String(required(params, 'user_id'));
    const result = await kernel('forward_message', payload, 30000);
    // The kernel does not always report the new message before forwardMsg
    // answers; message_id is then 0 and only the outgoing event carries it.
    const peerKey = peerKeyFromSend(result.to);
    return {
      message_id: num(peerKey && result.message_id ?
        unique.createUniqueMsgId(peerKey, result.message_id) : 0),
      real_id: str(result.message_id),
      forwarded: ids
    };
  }

  const actions = {
    // -- meta ---------------------------------------------------------------
    get_status: async () => {
      const online = core.rpc.connected && !store.offline && num(store.self.uin) > 0;
      return { online, good: online, checker: online, app_initialized: true };
    },
    get_version_info: async () => ({
      ver: '1.0.0',
      implement: 'qqproto',
      product: 'qq-hook-poc',
      version: '1.0.0',
      protocol: 11,
      official_url: 'local'
    }),
    get_login_info: async () => {
      await core.ensureSelf();
      return {
        user_id: num(store.self.uin),
        nickname: str(store.self.nick),
        uid: str(store.self.uid)
      };
    },
    can_send_msg: async () => ({ can_send: true, reason: '', status: 'available' }),
    can_send_image: async () => ({
      can_send: true, reason: '', status: 'available',
      // Local path / file:// / base64:// / data: / http(s); the endpoint
      // resolves the non-local spellings into its own image cache.
      detail: 'image accepts a local path, file://, base64://, data: or http(s) URL'
    }),
    can_send_record: async () => ({
      can_send: false, reason: 'voice upload is not implemented by this endpoint', status: 'unavailable'
    }),
    can_get_http_file: async () => ({
      can_get: false, reason: 'file download is not implemented by this endpoint', status: 'unavailable'
    }),
    can_handle_url_unsafe_tags: async () => ({
      can_handle: false, reason: 'not implemented by this endpoint', status: 'unavailable'
    }),

    // -- contacts -----------------------------------------------------------
    get_friend_list: async (params) => {
      const friends = await core.friends(wantsForce(params));
      return friends.map(friendDto);
    },
    get_group_list: async (params) => {
      const groups = await core.groups(wantsForce(params));
      return groups.map(groupDto);
    },
    get_group_info: async (params) => {
      const groupId = String(required(params, 'group_id'));
      if (wantsForce(params) || !store.group(groupId)) {
        try {
          await core.groups(true);
        } catch (error) {
          logger.debug('group refresh failed:', error.message);
        }
      }
      const group = store.group(groupId);
      if (!group) fail(RC.NOT_FOUND, `group not found: ${groupId}`);
      return groupDto(group);
    },
    get_group_member_list: async (params) => {
      const groupId = String(required(params, 'group_id'));
      const list = await core.members(groupId, wantsForce(params));
      if (list.length === 0 && !store.hasGroup(groupId)) {
        fail(RC.NOT_FOUND, `group not found: ${groupId}`);
      }
      return list.map((member) => memberDto(groupId, member, store.self.uin));
    },
    get_group_member_info: async (params) => {
      const groupId = String(required(params, 'group_id'));
      const userId = String(required(params, 'user_id'));
      const force = wantsForce(params);
      // OB11 has no per-member cache window: "not forced" means serve whatever
      // the member list already holds.
      let list = force ? [] : [...(store.members.get(groupId) || new Map()).values()];
      if (list.length === 0) list = await core.members(groupId, force);
      const matches = (item) => String(item.uin) === userId || item.uid === userId;
      let found = list.find(matches) || null;
      // A person known only from an event has no role/join_time; one forced
      // fetch upgrades the record when the group really contains them.
      if (found && found.role === undefined) {
        try {
          const fresh = await core.members(groupId, true);
          if (fresh.some(matches)) found = fresh.find(matches);
        } catch (error) {
          logger.debug('member refresh failed:', error.message);
        }
      }
      if (!found) fail(RC.NOT_FOUND, `user ${userId} is not a member of group ${groupId}`);
      return memberDto(groupId, found, store.self.uin);
    },
    get_stranger_info: async (params) => {
      const userId = required(params, 'user_id');
      const user = await core.user(userId);
      if (!user) fail(RC.NOT_FOUND, `stranger not found: ${userId}`);
      return {
        user_id: num(user.uin),
        uid: str(user.uid),
        nickname: str(user.nick),
        remark: str(user.remark || user.nick),
        sex: 0,
        age: 0,
        level: 0,
        login_days: 0,
        avatar: avatarUrl(user.uin)
      };
    },
    get_user_info: async (params) => actions.get_stranger_info(params),

    // -- messaging ----------------------------------------------------------
    send_private_msg: async (params) =>
      sendTo(required(params, 'user_id'), toSendSegments(params)),
    send_group_msg: async (params) =>
      sendTo(required(params, 'group_id'), toSendSegments(params)),
    send_msg: async (params) => {
      const type = str(pick(params, 'message_type')).toLowerCase();
      if (type === 'group' || (type === '' && pick(params, 'group_id') !== undefined)) {
        return sendTo(required(params, 'group_id'), toSendSegments(params));
      }
      return sendTo(required(params, 'user_id'), toSendSegments(params));
    },
    get_msg: async (params) => {
      const record = resolveMessageId(params);
      const event = store.message(record.nativeId);
      if (!event) {
        fail(
          RC.NOT_FOUND,
          `message ${record.nativeId} is not cached; only messages seen since this endpoint started are readable`
        );
      }
      return messageDto(event, ctx());
    },
    get_group_msg_history: async (params) => ({
      messages: history(required(params, 'group_id'), pick(params, 'count', 'message_seq'))
    }),
    get_friend_msg_history: async (params) => ({
      messages: history(required(params, 'user_id'), pick(params, 'count'))
    }),
    delete_msg: async (params) => {
      const record = resolveMessageId(params);
      const fallback = peerFromKey(record.peerKey);
      await core.recallDirect({
        messageId: record.nativeId,
        chatType: fallback.chat_type,
        peerUid: fallback.peer_uid
      });
      return null;
    },
    // Read markers go through QQ now, but a failure must not break a bot loop
    // that only wanted the chat to stop looking unread.
    set_msg_read: async (params) => markRead(params, ['message_id']),
    mark_msg_as_read: async (params) => markRead(params, ['user_id', 'group_id', 'message_id']),
    mark_group_msg_as_read: async (params) => markRead(params, ['group_id', 'user_id']),

    // -- group administration ------------------------------------------------
    set_group_name: (params) =>
      kernel('set_group_name', {
        group_id: required(params, 'group_id'),
        group_name: str(required(params, 'group_name'))
      }),
    set_group_remark: (params) =>
      kernel('set_group_remark', {
        group_id: required(params, 'group_id'),
        remark: str(pick(params, 'remark', 'group_remark'))
      }),
    set_group_card: (params) =>
      kernel('set_group_card', {
        group_id: required(params, 'group_id'),
        user_id: required(params, 'user_id'),
        card: str(pick(params, 'card') || '')
      }),
    set_group_special_title: (params) =>
      kernel('set_group_special_title', {
        group_id: required(params, 'group_id'),
        user_id: required(params, 'user_id'),
        special_title: str(pick(params, 'special_title', 'title') || ''),
        duration: num(pick(params, 'duration'))
      }),
    set_group_role: (params) => {
      const role = str(required(params, 'role')).toLowerCase();
      if (role === 'owner') {
        fail(RC.BAD_PARAM, 'transferring ownership is not implemented by this endpoint');
      }
      return kernel('set_group_admin', {
        group_id: required(params, 'group_id'),
        user_id: required(params, 'user_id'),
        enable: role === 'admin'
      });
    },
    set_group_admin: (params) =>
      kernel('set_group_admin', {
        group_id: required(params, 'group_id'),
        user_id: required(params, 'user_id'),
        enable: boolParam(pick(params, 'enable'), true)
      }),
    set_group_kick: (params) =>
      kernel('set_group_kick', {
        group_id: required(params, 'group_id'),
        user_id: required(params, 'user_id'),
        reason: str(pick(params, 'reason')),
        reject_add_request: boolParam(pick(params, 'reject_add_request'), false)
      }),
    set_group_ban: (params) =>
      kernel('set_group_ban', {
        group_id: required(params, 'group_id'),
        user_id: required(params, 'user_id'),
        duration: durationOf(params, 1200)
      }),
    set_group_whole_ban: (params) =>
      kernel('set_group_whole_ban', {
        group_id: required(params, 'group_id'),
        enable: boolParam(pick(params, 'enable'), true)
      }),
    set_group_leave: (params) =>
      kernel('set_group_leave', {
        group_id: required(params, 'group_id'),
        is_dismiss: boolParam(pick(params, 'is_dismiss', 'dismiss'), null)
      }),
    get_group_at_all_remain: (params) =>
      kernel('get_group_at_all_remain', { group_id: required(params, 'group_id') }),
    get_group_banned_list: (params) =>
      kernel('get_group_shut_list', { group_id: required(params, 'group_id') }),
    get_group_shut_list: (params) =>
      kernel('get_group_shut_list', { group_id: required(params, 'group_id') }),
    get_group_detail_info: (params) =>
      kernel('get_group_detail', { group_id: required(params, 'group_id') }),
    get_group_level_info: (params) =>
      kernel('get_group_level_info', { group_id: required(params, 'group_id') }),

    // -- requests ------------------------------------------------------------
    get_group_system_msg: async (params) => {
      const result = await kernel('get_group_system_notices', {
        doubt: boolParam(pick(params, 'doubt'), false),
        count: num(pick(params, 'count')) || 50
      });
      const join = [];
      const invited = [];
      const other = [];
      for (const item of result.requests || []) {
        const entry = {
          request_id: num(item.seq),
          seq: str(item.seq),
          flag: str(item.flag),
          type: num(item.type),
          group_id: num(item.group_id),
          group_name: str(item.group_name),
          user_id: num(item.user_id),
          user_uid: str(item.user_uid),
          user_nick: str(item.user_nick),
          invitor_uin: num(item.user_id),
          actor_uid: str(item.actor_uid),
          comment: str(item.comment),
          create_time: num(item.created_time),
          is_processed: !!item.checked,
          doubt: !!result.doubt
        };
        // Type 7 is the join application NapCat also filters on, 1 and 5 are
        // invitations. Everything else on that screen - measured: a 管理员变更
        // notice arrives as type 8 - is neither, so it gets its own list
        // instead of being offered to a bot as something to approve.
        if (entry.type === 7) join.push(entry);
        else if (entry.type === 1 || entry.type === 5) invited.push(entry);
        else other.push(entry);
      }
      // Both spellings are served: v11 clients read the snake_case key, some
      // frameworks still ask for the camelCase one NapCat also returns.
      return { join_requests: join, invited_requests: invited, InvitedRequest: invited, other_requests: other };
    },
    get_group_add_request: (params) => actions.get_group_system_msg(params),
    set_group_add_request: (params) =>
      kernel('handle_group_request', {
        seq: str(pick(params, 'seq', 'flag', 'request_id', 'notice_id') || ''),
        approve: boolParam(pick(params, 'approve'), true),
        reason: str(pick(params, 'reason')),
        doubt: boolParam(pick(params, 'doubt'), false),
        // OneBot's `type` for this action is the sub_type *string*
        // ('add'/'invite'), not the kernel's numeric notify type. Forward only a
        // genuinely numeric one; otherwise let the bridge look the notice up by
        // its flag, which is how the real type and the doubt screen get decided
        // (and what NapCat does). Guessing the number from the word is how a
        // valid request used to come back as "type 0".
        type: /^\d+$/.test(str(pick(params, 'type'))) ? num(pick(params, 'type')) : undefined,
        group_id: pick(params, 'group_id'),
        user_id: pick(params, 'user_id')
      }),
    get_friend_requests: async (params) => {
      const result = await kernel('get_friend_requests', {
        only_incoming: boolParam(pick(params, 'only_incoming'), true)
      });
      return {
        unread: num(result.unread),
        requests: (result.requests || []).map(item => ({
          flag: str(item.flag),
          req_time: str(item.req_time),
          req_type: num(item.req_type),
          user_id: num(item.user_id),
          user_uid: str(item.user_uid),
          user_nick: str(item.nick),
          comment: str(item.comment),
          source_id: num(item.source_id),
          create_time: num(item.created_time),
          unread: !!item.unread,
          doubt: !!item.doubt
        }))
      };
    },
    set_friend_add_request: (params) =>
      kernel('handle_friend_request', {
        flag: str(pick(params, 'flag', 'req_time', 'request_id', 'seq') || ''),
        approve: boolParam(pick(params, 'approve'), true),
        remark: str(pick(params, 'remark')),
        user_uid: str(pick(params, 'user_uid'))
      }),
    mark_group_notify_as_read: (params) =>
      kernel('clear_group_notice_unread', {
        doubt: boolParam(pick(params, 'doubt'), false),
        group_id: pick(params, 'group_id')
      }),
    clear_friend_notice: (params) => kernel('clear_friend_request_unread', {}),

    // -- contacts ------------------------------------------------------------
    set_friend_remark: (params) =>
      kernel('set_friend_remark', {
        user_id: required(params, 'user_id'),
        remark: str(pick(params, 'remark') || '')
      }),
    delete_friend: (params) =>
      kernel('delete_friend', {
        user_id: required(params, 'user_id'),
        block: boolParam(pick(params, 'block'), false),
        delete_both: boolParam(pick(params, 'delete_both'), true)
      }),
    get_buddy_list: (params) => actions.get_friend_list(params),

    // -- message level -------------------------------------------------------
    set_msg_reaction: (params) => reaction(params, true),
    del_msg_reaction: (params) => reaction(params, false),
    set_essence_msg: (params) =>
      kernel('set_essence', essenceArgs(params, true)),
    unset_essence_msg: (params) =>
      kernel('set_essence', essenceArgs(params, false)),
    // Reading the essence list is the one thing the kernel will not give us:
    // fetchGroupEssenceList neither settles its promise nor pushes a known
    // callback (measured on 9.9.36-53644), and NapCat gets the list from the
    // qun.qq.com web api instead. Setting and clearing essence still works.
    get_essence_msg_list: async () =>
      fail(RC.BAD_PARAM,
        'get_essence_msg_list is not implemented: the essence list needs the qun.qq.com web api, ' +
        'while set_essence_msg / unset_essence_msg work through the kernel'),
    get_group_essence: () => actions.get_essence_msg_list({}),
    send_like: (params) =>
      kernel('send_like', {
        user_id: required(params, 'user_id'),
        times: num(pick(params, 'times', 'count')) || 1,
        group_id: pick(params, 'group_id')
      }),
    // A forward is QQ's own: the kernel copies the message rather than the
    // endpoint rebuilding a node list, so get_forward_msg stays unread-only.
    send_group_forward_msg: (params) => forward(params, 'group_id'),
    send_private_forward_msg: (params) => forward(params, 'user_id'),
    get_forward_msg: async () =>
      fail(RC.BAD_PARAM,
        'get_forward_msg is not implemented: reading a merged forward needs the message database, which this endpoint never touches'),

    // -- notices -------------------------------------------------------------
    send_group_notice: async (params) => {
      const result = await kernel('send_group_notice', {
        group_id: required(params, 'group_id'),
        content: str(pick(params, 'content', 'text') || ''),
        image: str(pick(params, 'image', 'file', 'pic_info')),
        pinned: boolParam(pick(params, 'pinned', 'show_obvious'), false),
        confirm_required: boolParam(pick(params, 'confirm_required'), false),
        notice_id: str(pick(params, 'notice_id'))
      });
      return { notice_id: str(result.notice_id), group_id: num(result.group_id) };
    },
    get_group_notice: async (params) => {
      const result = await kernel('list_group_notices', {
        group_id: required(params, 'group_id'),
        start_index: params.start_index,
        count: params.count,
        arg_variant: params.arg_variant,
        // Asks the bridge to write the raw kernel push into %TEMP%\qqhook_proto.log
        // when a board comes back looking empty.
        debug: params.debug
      });
      if (result.answered === false) {
        // An unanswered read must not be dressed up as "no bulletins".
        return fail(RC.BAD_PARAM,
          'get_group_notice is not implemented: on this QQ build getGroupBulletinList ' +
          'only ever answers with an all-default envelope (srvCode 0, feeds/inst empty, ' +
          'server_time "0") even when a bulletin is really on the board - four argument ' +
          'layouts were measured. The board itself is read through the qun.qq.com web api, ' +
          'which this endpoint deliberately does not use; send_group_notice and ' +
          'delete_group_notice do work through the kernel.');
      }
      return (result.notices || []).map(notice => ({
        notice_id: str(notice.notice_id),
        group_id: num(notice.group_id),
        sender_id: num(notice.sender_id),
        sender_uid: str(notice.sender_uid),
        publish_time: num(notice.time),
        pinned: !!notice.pinned,
        send_to_new_member: !!notice.send_to_new_member,
        image: str(notice.image),
        text: { title: str(notice.title), content: str(notice.content) },
        // Some clients read the flat fields instead of the text object.
        title: str(notice.title),
        content: str(notice.content)
      }));
    },
    set_group_announcement: (params) => actions.send_group_notice(params),
    del_group_notice: (params) =>
      kernel('delete_group_notice', {
        group_id: required(params, 'group_id'),
        notice_id: str(required(params, 'notice_id'))
      }),
    delete_group_notice: (params) => actions.del_group_notice(params),

    // -- group files ---------------------------------------------------------
    get_group_file_list: (params) =>
      kernel('get_group_files', {
        group_id: required(params, 'group_id'),
        folder_id: str(pick(params, 'folder_id') || ''),
        start_index: num(pick(params, 'start_index')),
        count: num(pick(params, 'file_count', 'count')) || 50,
        sort_type: num(pick(params, 'sort_type')),
        sort_order: num(pick(params, 'sort_order'))
      }),
    get_group_file_count: (params) =>
      kernel('get_group_file_count', { group_id: required(params, 'group_id') }),
    del_group_file: (params) =>
      kernel('delete_group_file', {
        group_id: required(params, 'group_id'),
        file_id: str(required(params, 'file_id')),
        busid: num(pick(params, 'busid', 'bus_id'))
      }),
    create_group_file_folder: (params) =>
      kernel('create_group_folder', {
        group_id: required(params, 'group_id'),
        folder_name: str(pick(params, 'folder_name', 'name') || ''),
        parent_folder_id: str(pick(params, 'parent_id', 'parent_folder_id'))
      }),
    delete_group_file_folder: (params) =>
      kernel('delete_group_folder', {
        group_id: required(params, 'group_id'),
        folder_id: str(pick(params, 'folder_id', 'id', 'name') || '')
      }),
    rename_group_file_folder: (params) =>
      kernel('rename_group_folder', {
        group_id: required(params, 'group_id'),
        folder_id: str(pick(params, 'folder_id', 'id') || ''),
        folder_name: str(pick(params, 'folder_name', 'name') || '')
      }),
    move_group_file: (params) =>
      kernel('move_group_file', {
        group_id: required(params, 'group_id'),
        file_id: str(required(params, 'file_id')),
        busid: num(pick(params, 'busid', 'bus_id')),
        current_parent_directory: str(pick(params, 'current_parent_directory')),
        target_parent_directory: str(pick(params, 'target_parent_directory', 'folder_id'))
      }),
    // A group file is uploaded by the client itself: the bridge stages the file
    // into the account's own media tree and sends a fileElement, so no Highway
    // is involved. `upload_file: false` (add to the group without uploading)
    // has no kernel equivalent and is refused rather than ignored.
    upload_group_file: async (params) => {
      if (params.upload_file === false) {
        fail(RC.BAD_PARAM,
          'upload_group_file with upload_file=false is not implemented: a group file must be uploaded first');
      }
      const result = await kernel('upload_group_file', {
        group_id: required(params, 'group_id'),
        file: str(required(params, 'file')),
        name: str(pick(params, 'name')),
        folder: str(pick(params, 'folder', 'folder_id'))
      }, 180000);
      return {
        file_id: str(result.file_id) || null,
        message_id: result.message_id,
        file_name: str(result.file_name),
        file_size: num(result.file_size)
      };
    },
    upload_private_file: async () =>
      fail(RC.BAD_PARAM,
        'upload_private_file is not implemented: only the group file path has been verified so far'),
    get_group_file_url: async () =>
      fail(RC.BAD_PARAM,
        'get_group_file_url is not implemented: it needs an OIDB packet rather than a kernel call'),

    // -- text tools ----------------------------------------------------------
    translate_enzh: async (params) => {
      const result = await kernel('translate_text', {
        text: str(pick(params, 'text', 'word') || ''),
        words: Array.isArray(params.words) ? params.words.map(str) : undefined
      });
      const first = (result.words || [])[0] || {};
      return { original: str(first.source), translated: str(first.target), words: result.words };
    },
    ocr_image: (params) =>
      kernel('ocr_image', { image: str(pick(params, 'image', 'file', 'url') || '') }, 30000),
    image_ocr: (params) => actions.ocr_image(params),

    fetch_cookie: async () =>
      fail(RC.BAD_PARAM, 'reading account cookies is out of scope for this endpoint')
  };

  return { actions, sendTo, toSendSegments };
}

// Names the wider OneBot ecosystem expects but this endpoint cannot serve,
// either because the capability needs something the endpoint deliberately does
// not do (message database, OIDB packets, qun.qq.com cookie requests, Highway
// uploads) or because QQ's kernel has no equivalent call at all. Answering 1400
// with an explicit "not implemented" tells the user what is missing, which is
// more useful than "unknown action".
// Registered handlers that can never succeed on this build: they exist so the
// name answers with a precise reason instead of "unknown action", but neither
// the debug page nor the docs may count them as implemented.
const REFUSED = [
  'get_essence_msg_list', 'get_group_essence', 'get_forward_msg', 'fetch_cookie'
];

const UNIMPLEMENTED = [
  // needs an upload path that has not been verified yet
  'upload_private_file', 'set_qq_avatar',
  // needs an OIDB packet
  'get_group_file_url', 'get_group_honor_info', 'get_group_member_profile',
  'send_group_sign', 'get_vip_info', 'get_message_like',
  // needs the qun.qq.com web api with account cookies
  'get_school_clockin', 'get_online_clients', 'get_risk_tips_info',
  'get_group_ignore_tip', 'get_banned_groups',
  // needs the local message database
  'get_forward_msg_single', 'get_collection_list',
  // no kernel equivalent on QQNT
  'friend_poke', 'group_poke', 'poke',
  'get_ocr_languages', 'query_ocr', 'send_dms_msg', 'send_gms_msg', 'push_msg',
  'create_group', 'create_discuss', 'get_discussion', 'get_forum',
  'get_stranger_list', 'get_recent_groups', 'get_friend_profiles'
];

function handleAction(name, params, ctx) {
  const { actions, logger } = ctx;
  // HTTP callers put echo in the body; WebSocket callers pass it separately.
  const echo = ctx.echo !== undefined && ctx.echo !== null
    ? ctx.echo
    : (params && params.echo !== undefined ? params.echo : null);
  const handler = actions[name];
  if (!handler) {
    const message = UNIMPLEMENTED.includes(name)
      ? `${name} is not implemented by this endpoint`
      : `unknown action: ${name}`;
    return Promise.resolve(OB11Response.error(message, RC.BAD_PARAM, echo));
  }
  return Promise.resolve()
    .then(() => handler(params || {}))
    .then((data) => OB11Response.ok(data === undefined ? null : data, echo))
    .catch((error) => {
      const retcode = num(error && error.retcode) ||
        (error && error.code === 'unsupported_segment' ? RC.BAD_PARAM :
          error && error.code === 'untested_version' ? RC.NO_PERMISSION : RC.INTERNAL);
      const message = (error && error.message) || 'internal error';
      if (retcode === RC.INTERNAL) logger.error(`onebot ${name} failed:`, message);
      else logger.debug(`onebot ${name} rejected:`, message);
      return OB11Response.error(message, retcode, echo);
    });
}

module.exports = {
  createActions,
  handleAction,
  UNIMPLEMENTED,
  REFUSED,
  OB11Response,
  RC
};
