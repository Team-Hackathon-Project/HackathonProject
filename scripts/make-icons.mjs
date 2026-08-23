/**
 * Generates the extension's PNG icons without any external dependency.
 *
 * The mark is the product's instrument: an open gauge ring with a rising line
 * inside it. The ring is deliberately not closed - the gap is where a page
 * broke, and closing that loop is what the extension does. The same shape is
 * drawn as inline SVG in the popup, the settings rail and the dashboard, so a
 * toolbar icon and the header of every surface are one identity.
 *
 * Everything is drawn from signed-distance tests and supersampled 4x4, which
 * is what keeps a 16px ring from turning into porridge.
 */
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

/* ------------------------------------------------------------------ *
 * The palette, matching `--accent` and `--accent-ink` in theme.css
 * ------------------------------------------------------------------ */

const TILE_LIGHT = [127, 176, 255];
const TILE_DEEP = [40, 88, 196];
const MARK_INK = [4, 14, 30];

/** The zig-zag inside the ring, in unit coordinates. */
const TICK = [
  [0.30, 0.60],
  [0.43, 0.47],
  [0.55, 0.56],
  [0.69, 0.38],
];

/** The ring's gap, in degrees, measured with y pointing down. */
const GAP_FROM = -56;
const GAP_TO = 10;

const mix = (a, b, t) => a.map((value, i) => value + (b[i] - value) * t);

/** Distance from p to the segment ab. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len = vx * vx + vy * vy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

/**
 * Colour at one unit-space sample, as [r, g, b, a].
 *
 * `stroke` is the half-width of the ring and the tick. At toolbar size the
 * ring is dropped and the line drawn larger: a 16px tile cannot hold both, and
 * a mark that has gone to mush is worse than a simpler mark that has not.
 */
function sample(x, y, { stroke, ring, scale }) {
  const corner = 0.22;
  const dx = Math.abs(x - 0.5) - (0.5 - corner);
  const dy = Math.abs(y - 0.5) - (0.5 - corner);
  if (dx > 0 && dy > 0 && Math.hypot(dx, dy) > corner) return [0, 0, 0, 0];

  // The tile: the accent, lit from the top-left corner.
  const tile = mix(TILE_LIGHT, TILE_DEEP, Math.min(1, (x * 0.55 + y * 0.75)));

  let onRing = false;
  if (ring) {
    const radius = Math.hypot(x - 0.5, y - 0.5);
    const angle = (Math.atan2(y - 0.5, x - 0.5) * 180) / Math.PI;
    const inGap = angle > GAP_FROM && angle < GAP_TO;
    onRing = !inGap && Math.abs(radius - 0.33) < stroke;
  }

  let onTick = false;
  for (let i = 0; i < TICK.length - 1 && !onTick; i++) {
    const [ax, ay] = TICK[i];
    const [bx, by] = TICK[i + 1];
    onTick = distanceToSegment(
      x, y,
      0.5 + (ax - 0.5) * scale, 0.5 + (ay - 0.5) * scale,
      0.5 + (bx - 0.5) * scale, 0.5 + (by - 0.5) * scale
    ) < stroke;
  }

  return onRing || onTick ? [...MARK_INK, 255] : [...tile, 255];
}

const SS = 4; // supersampling grid per axis

function png(size) {
  const ring = size >= 32;
  const stroke = ring ? Math.max(0.037, 0.8 / size) : 0.1;
  const scale = ring ? 1 : 1.45;
  const shape = { stroke, ring, scale };
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [sr, sg, sb, sa] = sample(
            (x + (sx + 0.5) / SS) / size,
            (y + (sy + 0.5) / SS) / size,
            shape
          );
          const weight = sa / 255;
          r += sr * weight; g += sg * weight; b += sb * weight; a += sa;
        }
      }
      const total = a / 255;
      const alpha = Math.round(a / (SS * SS));
      raw[o++] = total ? Math.round(r / total) : 0;
      raw[o++] = total ? Math.round(g / total) : 0;
      raw[o++] = total ? Math.round(b / total) : 0;
      raw[o++] = alpha;
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
