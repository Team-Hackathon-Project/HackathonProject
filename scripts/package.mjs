/**
 * Builds the loadable/uploadable extension archive (`npm run package`).
 *
 * Writes two things into `dist/`, both containing exactly what Chrome needs —
 * `manifest.json` and `src/` — and nothing else: no tests, no scripts, no
 * repository metadata.
 *
 *   dist/extension/               load this with "Load unpacked"
 *   dist/<name>-<version>.zip     hand this to someone else
 *
 * Chrome and Edge cannot install a plain zip: "Load unpacked" wants a folder,
 * and a .crx needs a signing key. So the folder is the one to point the browser
 * at, and the zip is for sending.
 *
 * The zip is written by hand with `node:zlib` so the project keeps its
 * "no runtime and no build dependencies" property.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, cpSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INCLUDE = ['manifest.json', 'src'];

/** Every file under `relative`, depth-first, as repo-relative posix paths. */
function collect(relative) {
  const absolute = path.join(ROOT, relative);
  if (statSync(absolute).isFile()) return [relative];
  const out = [];
  for (const entry of readdirSync(absolute).sort()) {
    out.push(...collect(path.posix.join(relative, entry)));
  }
  return out;
}

/* ---------------------------------------------------------------- *
 * Minimal ZIP writer (PKZIP 2.0, deflate or store, no zip64)
 * ---------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** DOS date/time pair for a JS Date (the zip format's 1980-epoch encoding). */
function dosStamp(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2));
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function buildZip(entries, stamp = new Date()) {
  const { time, day } = dosStamp(stamp);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const payload = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length
    nameBytes.copy(local, 30);
    locals.push(local, payload);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk number
    central.writeUInt16LE(0, 36);         // internal attributes
    central.writeUInt32LE(0, 38);         // external attributes
    central.writeUInt32LE(offset, 42);    // offset of local header
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + payload.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, end]);
}

/* ---------------------------------------------------------------- *
 * Build
 * ---------------------------------------------------------------- */

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

if (manifest.version !== pkg.version) {
  console.error(`version mismatch: package.json ${pkg.version} vs manifest.json ${manifest.version}`);
  process.exit(1);
}

const files = INCLUDE.flatMap(collect);
const entries = files.map((name) => ({ name, data: readFileSync(path.join(ROOT, name)) }));

const distDir = path.join(ROOT, 'dist');
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const outName = `${pkg.name}-${pkg.version}.zip`;
const outPath = path.join(distDir, outName);
writeFileSync(outPath, buildZip(entries));

// The same payload as a loadable folder, since a zip cannot be installed.
const unpackedDir = path.join(distDir, 'extension');
for (const name of INCLUDE) {
  cpSync(path.join(ROOT, name), path.join(unpackedDir, name), { recursive: true });
}

const bytes = statSync(outPath).size;
console.log(`packaged ${entries.length} files (${(bytes / 1024).toFixed(1)} KB)`);
for (const name of files) console.log(`  ${name}`);
console.log('');
console.log(`  dist/extension/        <- "Load unpacked" points here`);
console.log(`  dist/${outName}   <- send this to someone else`);
console.log('');
console.log('Install: chrome://extensions (or edge://extensions) -> Developer mode -> Load unpacked -> dist/extension');
