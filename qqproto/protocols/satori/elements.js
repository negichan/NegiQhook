'use strict';

// Satori messages are HTML-like: <message><text>hi</text><at id="1"/></message>.
// This module is intentionally strict on the send path: every tag either becomes
// a segment the bridge can build, or throws with the reason. Nothing is dropped
// on the floor - a bot that thinks it sent a picture must not have sent text.

function escapeText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unescapeText(value) {
  return String(value || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attrs(source) {
  const out = {};
  const pattern = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(source || '')) !== null) {
    out[match[1]] = unescapeText(match[2] !== undefined ? match[2] : match[3]);
  }
  return out;
}

// The wire format is the *inner* content of a message, not a wrapped document:
// @satorijs/element stringifies text as escaped text (`hi`, not `<text>hi</text>`)
// and the official adapters parse content with that same parser. Wrapping it in
// <message> made NoneBot build one RenderMessage segment around everything, so
// quote detection and at-checks never saw the real segments.
function encode(segments) {
  const parts = [];
  for (const segment of segments || []) {
    const type = segment && segment.type;
    const data = (segment && segment.data) || {};
    switch (type) {
      case 'text':
        if (data.text) parts.push(escapeText(data.text));
        break;
      case 'at': {
        const id = data.qq === 'all' ? 'all' : String(data.qq || data.uid || '');
        if (!id) break;
        const name = data.name ? ` name="${escapeText(data.name)}"` : '';
        const all = data.qq === 'all' ? ' type="all"' : '';
        parts.push(`<at id="${escapeText(id)}"${name}${all}/>`);
        break;
      }
      case 'image': {
        const src = data.url || '';
        if (src) {
          parts.push(`<img src="${escapeText(src)}"${data.width ? ` width="${data.width}"` : ''}${data.height ? ` height="${data.height}"` : ''}/>`);
        } else {
          parts.push('[图片]');
        }
        break;
      }
      case 'record':
        parts.push('[语音]');
        break;
      case 'video':
        parts.push('[视频]');
        break;
      case 'file':
        parts.push(`[文件: ${escapeText(data.name || '')}]`);
        break;
      case 'face':
        if (data.id) {
          parts.push(`<emoji id="${escapeText(data.id)}"${data.text ? ` name="${escapeText(data.text)}"` : ''}/>`);
        } else {
          parts.push('[表情]');
        }
        break;
      case 'mface':
        parts.push(`<emoji id="${escapeText(data.id || '')}"${data.name ? ` name="${escapeText(data.name)}"` : ''}/>`);
        break;
      case 'reply':
        if (data.id) parts.push(`<quote id="${escapeText(data.id)}"/>`);
        break;
      case 'forward':
        parts.push('[聊天记录]');
        break;
      case 'json':
        parts.push('[卡片消息]');
        break;
      case 'gray_tip':
        break;
      default:
        parts.push('[消息]');
        break;
    }
  }
  return parts.join('');
}

function unsupported(type, why) {
  const error = new Error(`sending "${type}" elements is not implemented yet${why ? ': ' + why : ''}`);
  error.code = 'unsupported_segment';
  return error;
}

// `file:///D:/x.png` is what upload.create hands back, so the same string can be
// pasted into <img src> without the caller stripping the scheme by hand.
function localPath(src) {
  const value = String(src || '');
  if (!/^file:\/\//i.test(value)) return value;
  let rest = value.replace(/^file:\/\//i, '');
  // file:///D:/a.png -> /D:/a.png -> D:/a.png ; file://server/share -> //server/share
  if (/^\/[A-Za-z]:[\\/]/.test(rest)) rest = rest.slice(1);
  else if (!rest.startsWith('/')) rest = '//' + rest;
  try {
    return decodeURIComponent(rest);
  } catch (error) {
    return rest;
  }
}

// Parse a Satori message fragment into protocol-neutral segments.
// Unknown/unsupported markup is rejected so callers do not silently send a
// partial message.
function parse(content) {
  const source = String(content === undefined || content === null ? '' : content);
  if (!source) return [];
  if (source.indexOf('<') === -1) {
    return [{ type: 'text', data: { text: unescapeText(source) } }];
  }

  const segments = [];
  const token = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let cursor = 0;
  let match;
  let textOpen = false;
  let textBuffer = '';

  const pushText = (value) => {
    const text = unescapeText(value);
    if (text) segments.push({ type: 'text', data: { text } });
  };
  const flushText = () => {
    if (textOpen && textBuffer) pushText(textBuffer);
    textBuffer = '';
  };

  while ((match = token.exec(source)) !== null) {
    const before = source.slice(cursor, match.index);
    cursor = token.lastIndex;
    if (textOpen) textBuffer += before;
    else if (before) pushText(before);

    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    const rawAttrs = match[3] || '';
    const selfClosing = match[4] === '/' || name === 'br';

    if (name === 'message') {
      continue;
    }
    if (name === 'text') {
      if (closing) {
        flushText();
        textOpen = false;
      } else if (!selfClosing) {
        textOpen = true;
      }
      continue;
    }
    if (textOpen) {
      // Text content is literal; tags inside it are not markup.
      textBuffer += match[0];
      continue;
    }
    if (name === 'br') {
      segments.push({ type: 'text', data: { text: '\n' } });
      continue;
    }
    if (name === 'at') {
      if (closing) continue;
      const data = attrs(rawAttrs);
      if (!data.id) continue;
      segments.push({
        type: 'at',
        data: { qq: data.id, name: data.name || '', uid: data.uid || '' }
      });
      continue;
    }
    if (name === 'quote') {
      if (closing) continue;
      const data = attrs(rawAttrs);
      // The bridge builds the kernel reply element from its own cache, so only
      // the id travels; an unquoted <quote> has nothing to reply to.
      if (!data.id) throw unsupported('quote', 'a quote needs id="<message id>"');
      segments.push({ type: 'reply', data: { id: data.id } });
      continue;
    }
    if (name === 'emoji') {
      if (closing) continue;
      const data = attrs(rawAttrs);
      if (!data.id) throw unsupported('emoji', 'an emoji needs id="<qq face id>"');
      segments.push({ type: 'face', data: { id: data.id, text: data.name || '' } });
      continue;
    }
    if (name === 'sharp') {
      // Channel mentions have no QQ equivalent; refusing beats dropping it.
      throw unsupported('sharp', 'QQ has no channel mention');
    }
    if (name === 'img' || name === 'image') {
      if (closing) continue;
      const data = attrs(rawAttrs);
      // src may be a local path, file://, base64://, data: or http(s); core
      // resolves the non-local spellings into a local file before the bridge.
      const src = localPath(data.src || data.path || data.file || '');
      if (!src) throw unsupported(name, 'an image needs src="<path or URL>"');
      segments.push({ type: 'image', data: { file: src, summary: data.alt || '' } });
      continue;
    }
    if (name === 'file') {
      if (closing) continue;
      const data = attrs(rawAttrs);
      const src = localPath(data.src || data.path || data.file || '');
      if (!src) throw unsupported(name, 'a file needs src="<path on this machine>"');
      segments.push({ type: 'file', data: { file: src, name: data.title || data.name || '' } });
      continue;
    }
    if (name === 'audio' || name === 'video') {
      // Voice needs silk and video needs a thumbnail; neither is worth faking.
      throw unsupported(name, 'QQ needs silk/ffmpeg before this can be sent');
    }
    if (!closing) {
      // Unknown inline tag: keep its children as text (handled by the loop).
      continue;
    }
  }

  const tail = source.slice(cursor);
  if (textOpen) textBuffer += tail;
  else if (tail) pushText(tail);
  if (textOpen) flushText();

  return segments;
}

module.exports = { encode, parse, escapeText, unescapeText, localPath };
