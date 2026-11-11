'use strict';

// QQ normalised segments (from proto_bridge.js) <-> OneBot v11 segments.
// Field names follow what NapCat / LLOneBot emit so existing bot frameworks
// parse them unchanged: image carries url/file/summary, record carries
// file/url/time, json carries data, reply carries a numeric message_id.

class SendError extends Error {
  constructor(retcode, message) {
    super(message);
    this.retcode = retcode;
  }
}

function str(value) {
  return value === undefined || value === null ? '' : String(value);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// The message-id table has to key on something the send result and the kernel
// event agree on. For a group, QQ reports peerUid as the group's own uid while
// the caller addresses the group number, so key groups on the group code; a
// private chat already keys on the partner uid in both directions.
function peerKeyOf(event) {
  if (!event) return '';
  const chatType = num(event.chat_type) || (event.is_group ? 2 : 1);
  if (chatType === 2) {
    return `2:${str(event.group_id || event.peer_uin || event.peer_uid)}`;
  }
  return `${chatType}:${str(event.peer_uid || event.peer_uin || '')}`;
}

function peerKeyFromSend(peer) {
  if (!peer) return '';
  const chatType = num(peer.chat_type) || 1;
  const key = str(peer.peer_uid);
  return key ? `${chatType}:${key}` : '';
}

// Inverse of peerKeyOf, only used as a fallback when the message is no longer
// cached and recall has to address the peer itself.
function peerFromKey(peerKey) {
  const text = str(peerKey);
  const index = text.indexOf(':');
  if (index === -1) return { chat_type: 0, peer_uid: '' };
  return {
    chat_type: num(text.slice(0, index)),
    peer_uid: text.slice(index + 1)
  };
}

// uid (u_xxx / group member uid) -> QQ number, using whatever the caches know.
function uinOf(store, id, groupId) {
  const key = str(id);
  if (!key || /^\d+$/.test(key)) return key;
  const friend = store.friendByUid(key);
  if (friend && friend.uin) return str(friend.uin);
  const groups = groupId ? [String(groupId)] : [...store.members.keys()];
  for (const group of groups) {
    const members = store.members.get(group);
    if (!members) continue;
    const member = members.get(key);
    if (member && member.uin) return str(member.uin);
  }
  return '';
}

function toOneBotSegments(elements, ctx = {}) {
  const unique = ctx.unique || null;
  const peerKey = ctx.peerKey || '';
  const store = ctx.store || null;
  const groupId = ctx.groupId || '';
  const out = [];
  for (const segment of elements || []) {
    const data = (segment && segment.data) || {};
    switch (segment.type) {
      case 'text':
        out.push({ type: 'text', data: { text: str(data.text) } });
        break;
      case 'at': {
        // QQ fills atNtUid (a u_... uid) and often leaves atUin empty, while
        // OneBot clients want the QQ number. Reverse-map through the caches.
        let qq = str(data.qq || '');
        const uid = str(data.uid || '');
        if (qq !== 'all' && (!/^\d+$/.test(qq) || (uid && qq !== uid))) {
          const uin = store ? uinOf(store, uid || qq, groupId) : '';
          if (uin) qq = uin;
          else if (!/^\d+$/.test(qq)) qq = uid || qq;
        }
        out.push({
          type: 'at',
          data: qq ? { qq, ...(data.name ? { name: str(data.name) } : {}) } : { qq: '' }
        });
        break;
      }
      case 'face':
        out.push({ type: 'face', data: { id: num(data.id) } });
        break;
      case 'mface':
        out.push({
          type: 'mface',
          data: {
            id: str(data.id),
            name: str(data.name),
            summary: str(data.summary),
            url: str(data.url)
          }
        });
        break;
      case 'image':
        out.push({
          type: 'image',
          data: {
            url: str(data.url),
            file: str(data.file) || str(data.md5),
            file_id: str(data.file_uuid),
            md5: str(data.md5),
            size: num(data.file_size),
            width: num(data.width),
            height: num(data.height),
            summary: str(data.summary),
            // Where the bytes are on this machine, when the client has already
            // downloaded the picture (or only its thumbnail - then `thumb` is
            // true). NapCat does not emit these two, but they are the only way
            // a bot gets the picture without media download support.
            path: str(data.path),
            thumb: !!data.thumb
          }
        });
        break;
      case 'record':
        out.push({
          type: 'record',
          data: {
            file: str(data.file),
            url: str(data.url || ''),
            time: num(data.duration),
            voice_name: str(data.file),
            md5: str(data.md5)
          }
        });
        break;
      case 'video':
        out.push({
          type: 'video',
          data: {
            file: str(data.file),
            url: str(data.url || ''),
            duration: num(data.duration),
            size: num(data.size),
            md5: str(data.md5)
          }
        });
        break;
      case 'file':
        out.push({
          type: 'file',
          data: {
            file: str(data.name),
            url: str(data.url || ''),
            size: num(data.size),
            file_id: str(data.file_uuid),
            md5: str(data.md5)
          }
        });
        break;
      case 'json':
        out.push({ type: 'json', data: { data: str(data.text) } });
        break;
      case 'forward':
        out.push({ type: 'forward', data: { id: str(data.id) } });
        break;
      case 'reply': {
        const nativeId = str(data.id);
        const mapped = unique && peerKey && nativeId ? unique.findId(peerKey, nativeId) : 0;
        out.push({
          type: 'reply',
          data: {
            id: mapped || nativeId,
            message_id: mapped || 0,
            sender_id: num(data.sender_uin),
            text: str(data.text)
          }
        });
        break;
      }
      case 'gray_tip':
        break;
      default:
        out.push({ type: 'text', data: { text: '[消息]' } });
        break;
    }
  }
  return out;
}

function cqEscape(value) {
  return str(value)
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/]/g, '&#93;')
    .replace(/,/g, '&#44;');
}

// Plain text only has to survive the "[CQ:" scanner, so a comma is left as it
// is: escaping it would show &#44; to any client that does not unescape.
function textEscape(value) {
  return str(value)
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/]/g, '&#93;');
}

function cqUnescape(value) {
  return str(value)
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

function toCqString(segments) {
  const parts = [];
  for (const segment of segments) {
    const data = segment.data || {};
    if (segment.type === 'text') {
      parts.push(textEscape(data.text));
      continue;
    }
    const fields = Object.keys(data)
      .filter(key => data[key] !== undefined && data[key] !== null && data[key] !== '')
      .map(key => `${key}=${cqEscape(data[key])}`);
    parts.push(`[CQ:${segment.type}${fields.length ? ',' + fields.join(',') : ''}]`);
  }
  return parts.join('');
}

// Accepts a CQ-code string, a plain string (auto_escape), or a segment array.
function parseMessage(message, autoEscape = false) {
  if (Array.isArray(message)) {
    return message.map((segment) => ({
      type: str(segment && segment.type),
      data: (segment && segment.data) || {}
    }));
  }
  const text = str(message);
  if (autoEscape || !text.includes('[CQ:')) {
    // auto_escape means "literal, do not decode"; otherwise a body produced by
    // toCqString still has to come back as the original text.
    const value = autoEscape ? text : cqUnescape(text);
    return value ? [{ type: 'text', data: { text: value } }] : [];
  }

  const segments = [];
  const pattern = /\[CQ:([a-zA-Z_][\w-]*)((?:,.*?)?)\]/g;
  let cursor = 0;
  let match;
  const pushLiteral = (chunk) => {
    if (!chunk) return;
    const value = cqUnescape(chunk);
    if (value) segments.push({ type: 'text', data: { text: value } });
  };
  while ((match = pattern.exec(text)) !== null) {
    pushLiteral(text.slice(cursor, match.index));
    cursor = pattern.lastIndex;
    const type = match[1];
    const data = {};
    if (match[2]) {
      // Split on commas that separate key=value pairs. A comma a client left
      // unescaped inside a value has no '=' after it, so it rejoins that value.
      const pairs = [];
      for (const part of match[2].slice(1).split(',')) {
        if (part.includes('=') || pairs.length === 0) pairs.push(part);
        else pairs[pairs.length - 1] += `,${part}`;
      }
      for (const pair of pairs) {
        const index = pair.indexOf('=');
        if (index === -1) {
          if (pair) data[pair] = '';
          continue;
        }
        data[pair.slice(0, index)] = cqUnescape(pair.slice(index + 1));
      }
    }
    if (type === 'face') data.id = num(data.id);
    if (type === 'at' && data.qq === undefined) data.qq = data.id;
    segments.push({ type, data });
  }
  pushLiteral(text.slice(cursor));
  return segments;
}

// The bridge executes text/at elements; anything else is refused the same way
// NapCat refuses an unimplemented media upload.
function toBridgeSegments(segments) {
  const out = [];
  for (const segment of segments) {
    const data = segment.data || {};
    if (segment.type === 'text') {
      const value = str(data.text);
      if (value) out.push({ type: 'text', data: { text: value } });
      continue;
    }
    if (segment.type === 'at') {
      out.push({
        type: 'at',
        data: {
          qq: str(data.qq || data.id || ''),
          uid: str(data.uid || ''),
          name: str(data.name || '')
        }
      });
      continue;
    }
    if (segment.type === 'image') {
      // The bridge in the QQ process only reads a file that already exists on
      // this machine, so the endpoint resolves whatever spelling the client
      // used (local path, file://, base64://, data:, http(s)) into the image
      // cache first. An event segment echoed straight back into a send carries
      // `path` (the file the client already has) next to `file` (the md5 name),
      // so prefer the path.
      out.push({
        type: 'image',
        data: {
          file: str(data.path || data.file || data.url || data.base64),
          summary: str(data.summary)
        }
      });
      continue;
    }
    if (segment.type === 'record' || segment.type === 'video' ||
        segment.type === 'file' || segment.type === 'json' || segment.type === 'reply' ||
        segment.type === 'forward' || segment.type === 'face' || segment.type === 'mface' ||
        segment.type === 'node') {
      throw new SendError(1400, `sending "${segment.type}" is not implemented by this endpoint yet`);
    }
    throw new SendError(1400, `unknown message segment "${segment.type}"`);
  }
  if (out.length === 0) throw new SendError(1400, 'message is empty');
  return out;
}

module.exports = {
  SendError,
  peerKeyOf,
  peerKeyFromSend,
  peerFromKey,
  uinOf,
  toOneBotSegments,
  toCqString,
  parseMessage,
  toBridgeSegments,
  str,
  num
};
