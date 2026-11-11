'use strict';

// Print a PNG QR code as text so a console session can scan it directly
// (same idea as NapCat's terminal QR). Zero dependencies: it decodes the PNG
// itself, recovers the QR module grid from pixel run lengths, then renders with
// Unicode half blocks.
//
//   node scripts/qr_console.js <file.png> [--ascii] [--max-width <cols>]
//   node scripts/qr_console.js --self-test

const fs = require('fs');
const zlib = require('zlib');

function crc32(buf, table) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Minimal PNG reader: 8-bit grey/RGB/RGBA and palette images, no interlace.
function decodePng(buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== signature[i]) throw new Error('not a PNG file');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  const dataChunks = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      dataChunks.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!width || !height) throw new Error('PNG has no IHDR');
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  const subByteOk = colorType === 0 || colorType === 3 || colorType === 4;
  if (!(bitDepth === 8 || (subByteOk && [1, 2, 4].includes(bitDepth)))) {
    throw new Error('unsupported bit depth ' + bitDepth + ' for colour type ' + colorType);
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 1;
  const raw = zlib.inflateSync(Buffer.concat(dataChunks));
  const bytesPerPixel = Math.max(1, Math.round(channels * bitDepth / 8));
  const stride = Math.ceil(width * channels * bitDepth / 8);
  // One pixel value (0..255 luminance or a palette index) at column x of an
  // unfiltered row. Sub-byte depths pack several pixels per byte, big-endian
  // inside the byte, which is how QR encoders emit 1-bit images.
  const sample = (out, x) => {
    if (bitDepth === 8) return out[x * channels];
    const bitIndex = x * bitDepth;
    const byteIndex = Math.floor(bitIndex / 8);
    const shift = 8 - bitDepth - (bitIndex % 8);
    return (out[byteIndex] >> shift) & ((1 << bitDepth) - 1);
  };
  const scaleSubByte = (value) => {
    if (bitDepth === 8) return value;
    return Math.round(value * (255 / ((1 << bitDepth) - 1)));
  };
  const gray = new Uint8Array(width * height);
  let previous = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const out = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bytesPerPixel ? out[x - bytesPerPixel] : 0;
      const b = previous[x];
      const c = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      const value = line[x];
      let result;
      if (filter === 0) result = value;
      else if (filter === 1) result = value + a;
      else if (filter === 2) result = value + b;
      else if (filter === 3) result = value + ((a + b) >> 1);
      else if (filter === 4) result = value + paeth(a, b, c);
      else throw new Error('unknown PNG filter ' + filter);
      out[x] = result & 0xff;
    }
    previous = out;
    for (let x = 0; x < width; x++) {
      let luminance = 255;
      if (colorType === 3) {
        const index = sample(out, x);
        const r = palette ? palette[index * 3] : index * 17;
        const g = palette ? palette[index * 3 + 1] : index * 17;
        const b = palette ? palette[index * 3 + 2] : index * 17;
        luminance = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      } else if (channels === 1 || channels === 2) {
        luminance = scaleSubByte(sample(out, x));
      } else {
        const base = x * channels;
        luminance = Math.round(0.299 * out[base] + 0.587 * out[base + 1] + 0.114 * out[base + 2]);
      }
      gray[y * width + x] = luminance;
    }
  }
  return { width, height, gray };
}

function binarize(image) {
  let min = 255;
  let max = 0;
  for (const value of image.gray) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (max === min) throw new Error('image is a single colour');
  const threshold = (min + max) / 2;
  const bits = new Uint8Array(image.width * image.height);
  for (let i = 0; i < image.gray.length; i++) {
    bits[i] = image.gray[i] < threshold ? 1 : 0;
  }
  return bits;
}

function darkBounds(bits, width, height) {
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bits[y * width + x]) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (bottom < top) throw new Error('no dark pixels');
  return { top, bottom, left, right, width: right - left + 1, height: bottom - top + 1 };
}

function gcd(a, b) {
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

function render(buffer, options) {
  const settings = Object.assign({ ascii: false, maxWidth: 78 }, options || {});
  const image = decodePng(buffer);
  const bits = binarize(image);
  const bounds = darkBounds(bits, image.width, image.height);
  const size = estimateModuleSize(bits, image, bounds);
  const modules = Math.max(21, Math.round(bounds.width / size));
  const originX = bounds.left;
  const originY = bounds.top;
  const grid = [];
  for (let r = 0; r < modules; r++) {
    const row = [];
    for (let c = 0; c < modules; c++) {
      const x = Math.min(image.width - 1, Math.floor(originX + (c + 0.5) * size));
      const y = Math.min(image.height - 1, Math.floor(originY + (r + 0.5) * size));
      row.push(bits[y * image.width + x]);
    }
    grid.push(row);
  }
  return { modules, size, grid, text: draw(grid, settings) };
}

function estimateModuleSize(bits, image, bounds) {
  const lengths = [];
  const scan = (get, count) => {
    let run = 1;
    for (let i = 1; i < count; i++) {
      if (get(i) === get(i - 1)) run++;
      else {
        if (run > 1) lengths.push(run);
        run = 1;
      }
    }
    if (run > 1) lengths.push(run);
  };
  for (const y of [bounds.top + 6, bounds.top + Math.floor(bounds.height / 2), bounds.bottom - 7]) {
    if (y < 0 || y >= image.height) continue;
    scan((i) => bits[y * image.width + bounds.left + i], bounds.width);
  }
  for (const x of [bounds.left + 6, bounds.left + Math.floor(bounds.width / 2), bounds.right - 7]) {
    if (x < 0 || x >= image.width) continue;
    scan((i) => bits[(bounds.top + i) * image.width + x], bounds.height);
  }
  if (!lengths.length) return bounds.width / 21;
  let size = lengths.reduce((acc, value) => gcd(acc, value), lengths[0]);
  if (!size || size < 1) {
    const counts = new Map();
    for (const value of lengths) counts.set(value, (counts.get(value) || 0) + 1);
    size = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  }
  const candidates = [];
  for (let version = 1; version <= 40; version++) {
    const modules = 4 * version + 17;
    candidates.push({ modules, diff: Math.abs(bounds.width / modules - size) });
  }
  candidates.sort((a, b) => a.diff - b.diff);
  const best = candidates[0].modules;
  return bounds.width / best;
}

function draw(grid, settings) {
  const lines = [];
  if (settings.ascii) {
    for (const row of grid) lines.push(row.map((bit) => (bit ? '##' : '  ')).join(''));
    return lines.join('\n');
  }
  const blank = ' ';
  for (let r = 0; r < grid.length; r += 2) {
    let line = '';
    for (let c = 0; c < grid[r].length; c++) {
      const top = grid[r][c];
      const bottom = r + 1 < grid.length ? grid[r + 1][c] : 0;
      if (top && bottom) line += '█';
      else if (top) line += '▀';
      else if (bottom) line += '▄';
      else line += blank;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function encodePng(width, height, pixels) {
  const crc = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4, 0, body.length);
    out.writeUInt32BE(crc32(body, CRC_TABLE), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    for (let x = 0; x < width; x++) {
      raw[y * (width + 1) + 1 + x] = pixels[y * width + x];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    crc('IHDR', ihdr),
    crc('IDAT', zlib.deflateSync(raw)),
    crc('IEND', Buffer.alloc(0))
  ]);
}

function selfTest() {
  // A fake QR: 21 modules at 8 px with a 4-module quiet zone, finder squares
  // in three corners plus some data noise.
  const modules = 21;
  const scale = 8;
  const quiet = 4;
  const size = (modules + quiet * 2) * scale;
  const pixels = new Uint8Array(size * size).fill(255);
  const set = (r, c, dark) => {
    if (!dark) return;
    for (let y = 0; y < scale; y++) {
      for (let x = 0; x < scale; x++) {
        pixels[((quiet + r) * scale + y) * size + (quiet + c) * scale + x] = 0;
      }
    }
  };
  const finder = (top, left) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(top + r, left + c, edge || core);
      }
    }
  };
  finder(0, 0);
  finder(0, modules - 7);
  finder(modules - 7, 0);
  for (let r = 8; r < modules - 8; r++) {
    for (let c = 8; c < modules - 8; c++) {
      set(r, c, (r * 7 + c * 13) % 3 === 0);
    }
  }
  const png = encodePng(size, size, pixels);
  const result = render(png, {});
  const failures = [];
  if (result.modules !== modules) failures.push('module count ' + result.modules);
  if (Math.abs(result.size - scale) > 0.01) failures.push('module size ' + result.size);
  if (!result.grid[0][0]) failures.push('top-left finder missing');
  if (!result.grid[0][modules - 1]) failures.push('top-right finder missing');
  if (!result.grid[modules - 1][0]) failures.push('bottom-left finder missing');
  if (result.grid[0][modules - 9]) failures.push('quiet zone leaked into grid');
  if (failures.length) {
    console.error('FAIL qr_console self test');
    for (const failure of failures) console.error('  - ' + failure);
    process.exit(1);
  }
  console.log('PASS  qr_console decodes a synthetic QR png (' + modules + ' modules, scale ' + result.size + ')');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    selfTest();
    process.exit(0);
  }
  const file = args.find((arg) => !arg.startsWith('--'));
  if (!file) {
    console.log('usage: node scripts/qr_console.js <file.png> [--ascii] [--self-test]');
    process.exit(2);
  }
  try {
    const result = render(fs.readFileSync(file), {
      ascii: args.includes('--ascii'),
      maxWidth: Number(args[args.indexOf('--max-width') + 1] || 78)
    });
    console.log(result.text);
  } catch (e) {
    console.error('could not render ' + file + ': ' + e.message);
    process.exit(1);
  }
}

module.exports = { render, decodePng, encodePng };
