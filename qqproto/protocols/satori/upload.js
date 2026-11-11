'use strict';

// upload.create: the one Satori method that takes bytes instead of JSON.
// A file is written under qqproto/data/upload and handed back as a file:// url,
// which <img src> understands - so a framework can upload once and send the
// picture without this endpoint ever downloading anything.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_TOTAL = 32 * 1024 * 1024;
const MAX_FILES = 8;

function boundaryOf(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  return match ? String(match[1] || match[2] || '').trim() : '';
}

// Reads the whole body into memory first: 32 MB is the cap, and multipart is a
// one-off path, so streaming parsers would be more code for no gain.
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error(`upload is larger than ${Math.round(limit / 1048576)} MB`);
        error.status = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function splitParts(body, boundary) {
  const marker = Buffer.from('--' + boundary);
  const parts = [];
  let index = body.indexOf(marker);
  while (index !== -1) {
    const after = index + marker.length;
    // "--" right after the marker closes the body.
    if (body.slice(after, after + 2).toString() === '--') break;
    const headerStart = after + 2; // CRLF after the boundary line
    const headerEnd = body.indexOf('\r\n\r\n', headerStart);
    if (headerEnd === -1) break;
    const headers = body.slice(headerStart, headerEnd).toString('utf8');
    const next = body.indexOf(marker, headerEnd + 4);
    if (next === -1) break;
    // The CRLF in front of the next marker is the delimiter's, not the file's.
    parts.push({ headers: headers, content: body.slice(headerEnd + 4, next - 2) });
    index = next;
  }
  return parts;
}

function filenameOf(headers) {
  const disposition = /content-disposition:([^\r\n]*)/i.exec(headers);
  if (!disposition) return '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition[1]);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch (error) {
      return encoded[1].trim();
    }
  }
  const plain = /filename="([^"]*)"/i.exec(disposition[1]);
  if (plain) return plain[1];
  const bare = /filename=([^;]+)/i.exec(disposition[1]);
  return bare ? bare[1].trim() : '';
}

async function saveUploads(request, dir) {
  const type = String(request.headers['content-type'] || '');
  if (!/multipart\/form-data/i.test(type)) {
    const error = new Error('upload.create needs multipart/form-data with one or more files');
    error.status = 400;
    throw error;
  }
  const boundary = boundaryOf(type);
  if (!boundary) {
    const error = new Error('multipart body without a boundary');
    error.status = 400;
    throw error;
  }
  const body = await readBody(request, MAX_TOTAL);
  const files = splitParts(body, boundary).filter((part) => filenameOf(part.headers));
  if (files.length === 0) {
    const error = new Error('no file part in the upload');
    error.status = 400;
    throw error;
  }
  if (files.length > MAX_FILES) {
    const error = new Error(`at most ${MAX_FILES} files per upload`);
    error.status = 413;
    throw error;
  }
  fs.mkdirSync(dir, { recursive: true });
  const urls = [];
  for (const part of files) {
    const ext = path.extname(filenameOf(part.headers)).slice(0, 12).replace(/[^A-Za-z0-9.]/g, '');
    const file = path.join(dir, crypto.randomBytes(8).toString('hex') + ext);
    fs.writeFileSync(file, part.content);
    urls.push('file:///' + file.split(path.sep).join('/'));
  }
  return urls;
}

module.exports = { saveUploads, MAX_TOTAL, MAX_FILES };
