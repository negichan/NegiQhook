'use strict';

// Image references a bot framework may send -> one local file path.
//
// NapCat accepts `file` as a local path, a file:// URI, a base64:// payload, a
// data: URL or an http(s) URL. The bridge and the QQ kernel only read local
// files, so the endpoint resolves the other spellings here, before core hands
// the bridge a path:
//
//   file:///D:/x.png        -> D:\x.png (existence is checked by the bridge)
//   base64://iVBOR...       -> decoded, sniffed, written to the cache
//   data:image/png;base64,  -> same
//   https://host/x.png      -> downloaded (30 MB cap, 30s, 5 redirects), cached
//
// The cache is qqproto/data/media/<sha256>.<ext> (content-addressed, so sending
// the same picture twice reuses one file). Only real PNG/JPEG/GIF/WebP/BMP
// bytes are accepted: an HTML error page or a text file is refused with the
// reason instead of being staged as a "picture". Files older than a week are
// pruned lazily on the first save of a run.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { fileURLToPath } = require('url');

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;
const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const SIGNATURES = [
  {
    ext: '.png', mime: 'image/png',
    test: (buffer) => buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 &&
      buffer[2] === 0x4e && buffer[3] === 0x47
  },
  {
    ext: '.jpg', mime: 'image/jpeg',
    test: (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  },
  {
    ext: '.gif', mime: 'image/gif',
    test: (buffer) => buffer.length >= 6 &&
      (buffer.slice(0, 6).toString('latin1') === 'GIF87a' || buffer.slice(0, 6).toString('latin1') === 'GIF89a')
  },
  {
    ext: '.webp', mime: 'image/webp',
    test: (buffer) => buffer.length >= 12 && buffer.slice(0, 4).toString('latin1') === 'RIFF' &&
      buffer.slice(8, 12).toString('latin1') === 'WEBP'
  },
  {
    ext: '.bmp', mime: 'image/bmp',
    test: (buffer) => buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d
  }
];

function sniffImage(buffer) {
  for (const signature of SIGNATURES) {
    if (signature.test(buffer)) return signature;
  }
  return null;
}

function bad(message) {
  const error = new Error(message);
  error.code = 'bad_param';
  return error;
}

function defaultCacheDir() {
  return path.resolve(__dirname, '..', 'data', 'media');
}

// Only the image signatures above are wanted, so the MIME prefix of a data URL
// is advisory; the bytes decide. This keeps a mislabelled but valid picture
// working and a valid-looking label with fake bytes refused.
function decodeDataUrl(text) {
  const match = /^data:([^,]*?),(.*)$/is.exec(text);
  if (!match) throw bad('image data: URL is malformed');
  const meta = match[1];
  const payload = match[2];
  if (!/;base64(;|$)/i.test(meta)) {
    throw bad('image data: URL must be base64-encoded');
  }
  return Buffer.from(payload.replace(/\s+/g, ''), 'base64');
}

class ImageSource {
  constructor({ cacheDir, logger, maxBytes, timeoutMs, maxRedirects } = {}) {
    this.cacheDir = cacheDir || defaultCacheDir();
    this.log = logger || null;
    this.maxBytes = Math.max(1024, Number(maxBytes) || MAX_IMAGE_BYTES);
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || FETCH_TIMEOUT_MS);
    this.maxRedirects = Number.isFinite(maxRedirects) ? maxRedirects : MAX_REDIRECTS;
    this.pruned = false;
  }

  // Resolve one image reference. A plain path is returned untouched (the
  // bridge validates that it exists); everything else becomes a cached file.
  async resolve(reference) {
    const raw = String(reference === undefined || reference === null ? '' : reference).trim();
    if (!raw) throw bad('image needs a file that exists on this machine');
    if (/^file:/i.test(raw)) return this._fromFileUrl(raw);
    if (/^base64:\/\//i.test(raw)) return this._fromBase64(raw.replace(/^base64:\/\//i, ''));
    if (/^base64:/i.test(raw)) throw bad('image base64:// payload is malformed');
    if (/^data:/i.test(raw)) return this._save(decodeDataUrl(raw), 'data URL');
    if (/^https?:\/\//i.test(raw)) return this._download(raw);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      throw bad('unsupported image reference scheme: ' + raw.split(':')[0]);
    }
    return raw;
  }

  _fromFileUrl(raw) {
    let local;
    try {
      local = fileURLToPath(raw);
    } catch (error) {
      throw bad('image file:// URL is malformed: ' + raw);
    }
    if (!local) throw bad('image file:// URL is empty');
    return local;
  }

  _fromBase64(payload) {
    const text = payload.trim();
    if (!text) throw bad('image base64:// payload is empty');
    // Some clients put a full data: URL after base64://; accept both spellings.
    if (/^data:/i.test(text)) return this._save(decodeDataUrl(text), 'data URL');
    const clean = text.replace(/\s+/g, '');
    if (clean.length > Math.ceil(this.maxBytes / 3) * 4 + 16) {
      throw bad('image is larger than ' + Math.round(this.maxBytes / (1024 * 1024)) + ' MB');
    }
    if (!/^[A-Za-z0-9+/=_-]+$/.test(clean)) {
      throw bad('image base64:// payload contains characters that are not base64');
    }
    return this._save(Buffer.from(clean, 'base64'), 'base64');
  }

  _download(url, redirects = 0) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(url);
      } catch (error) {
        reject(bad('image URL is malformed: ' + url));
        return;
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        reject(bad('image URL must be http(s): ' + url));
        return;
      }
      const transport = target.protocol === 'https:' ? https : http;
      const request = transport.get(target, {
        timeout: this.timeoutMs,
        headers: { 'user-agent': 'qqproto/1 image fetch' }
      }, (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirects >= this.maxRedirects) {
            reject(bad('image download redirected too many times'));
            return;
          }
          let next;
          try {
            next = new URL(response.headers.location, target).toString();
          } catch (error) {
            reject(bad('image download redirect is malformed'));
            return;
          }
          this._download(next, redirects + 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(bad('image download failed: HTTP ' + status + ' from ' + target.host));
          return;
        }
        const declared = Number(response.headers['content-length']) || 0;
        if (declared > this.maxBytes) {
          response.destroy();
          reject(bad('image is larger than ' + Math.round(this.maxBytes / (1024 * 1024)) + ' MB'));
          return;
        }
        const chunks = [];
        let size = 0;
        let settled = false;
        response.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > this.maxBytes) {
            settled = true;
            response.destroy();
            reject(bad('image is larger than ' + Math.round(this.maxBytes / (1024 * 1024)) + ' MB'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          try {
            resolve(this._save(Buffer.concat(chunks), 'download from ' + target.host));
          } catch (error) {
            reject(error);
          }
        });
        response.on('error', (error) => {
          if (settled) return;
          settled = true;
          reject(bad('image download failed: ' + error.message));
        });
      });
      request.on('timeout', () => request.destroy(new Error('timeout after ' + this.timeoutMs + 'ms')));
      request.on('error', (error) => reject(bad('image download failed: ' + error.message)));
    });
  }

  _save(buffer, origin) {
    if (!buffer || !buffer.length) throw bad('image ' + origin + ' is empty');
    if (buffer.length > this.maxBytes) {
      throw bad('image is larger than ' + Math.round(this.maxBytes / (1024 * 1024)) + ' MB');
    }
    const signature = sniffImage(buffer);
    if (!signature) {
      throw bad('image ' + origin + ' is not a PNG/JPEG/GIF/WebP/BMP picture');
    }
    this._pruneOnce();
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const file = path.join(this.cacheDir, hash.slice(0, 32) + signature.ext);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, file);
      if (this.log && this.log.debug) {
        this.log.debug('image cached:', file, '(' + buffer.length + ' bytes, ' + origin + ')');
      }
    }
    return file;
  }

  _pruneOnce() {
    if (this.pruned) return;
    this.pruned = true;
    let entries;
    try {
      entries = fs.readdirSync(this.cacheDir);
    } catch (error) {
      return;
    }
    const cutoff = Date.now() - CACHE_MAX_AGE_MS;
    for (const entry of entries) {
      const file = path.join(this.cacheDir, entry);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile() && stat.mtimeMs < cutoff) fs.rmSync(file, { force: true });
      } catch (error) {
        // a file another instance is using is not worth failing a send over
      }
    }
  }
}

function createImageSource(options) {
  return new ImageSource(options);
}

module.exports = {
  createImageSource,
  ImageSource,
  sniffImage,
  MAX_IMAGE_BYTES
};
