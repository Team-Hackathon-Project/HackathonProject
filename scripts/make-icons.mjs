// Generates the extension's PNG icons without any external dependency.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Draws a rounded teal tile with an upward "market" chevron.
function pixel(size, x, y) {
  const c = (size - 1) / 2;
  const r = size / 2;
  const corner = size * 0.22;
  const dx = Math.abs(x - c) - (r - corner);
  const dy = Math.abs(y - c) - (r - corner);
  if (dx > 0 && dy > 0 && Math.hypot(dx, dy) > corner) return [0, 0, 0, 0];

  const nx = x / (size - 1);
  const ny = y / (size - 1);
  // Zig-zag line: down-left leg then up-right leg.
  const legA = 0.72 - 0.55 * (nx / 0.5);
  const legB = 0.17 + 0.30 * ((nx - 0.5) / 0.5);
  const line = nx < 0.5 ? legA : legB;
  const thickness = 0.11;
  const on = Math.abs(ny - line) < thickness && nx > 0.14 && nx < 0.86;
  if (on) return [240, 253, 250, 255];
  const g = Math.round(18 + 40 * ny);
  return [g, Math.round(90 + 45 * (1 - ny)), Math.round(96 + 40 * (1 - ny)), 255];
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(size, x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  writeFileSync(new URL(`../src/icons/icon${size}.png`, import.meta.url), png(size));
  console.log(`wrote src/icons/icon${size}.png`);
}
