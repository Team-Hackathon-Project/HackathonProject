/**
 * Serves `web/` over http on localhost (`npm run web`).
 *
 * The dashboard's website route needs an origin the manifest's
 * `externally_connectable.matches` covers, and `http://localhost/*` matches any
 * port. Rather than send anyone off to install a static server, this is twenty
 * lines of `node:http` — the project has no runtime dependencies and this is
 * not the thing to spend the first one on.
 *
 *   npm run web              http://localhost:8080
 *   npm run web -- 5173      a different port
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const port = Number(process.argv[2]) || Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Maps a request path to a file inside `web/`, or null.
 *
 * The resolved path is checked to still be under the root afterwards, so
 * `../../.env` and its percent-encoded spellings cannot walk out of the folder.
 */
function resolve(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (decoded.endsWith('/')) decoded += 'index.html';
  const full = path.resolve(WEB_ROOT, `.${decoded}`);
  const root = path.resolve(WEB_ROOT);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

const server = createServer(async (request, response) => {
  const file = resolve(request.url || '/');
  if (!file) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(file);
    const target = info.isDirectory() ? path.join(file, 'index.html') : file;
    const body = await readFile(target);
    response.writeHead(200, {
      'content-type': TYPES[path.extname(target)] || 'application/octet-stream',
      // The dashboard is edited and reloaded constantly during development;
      // a cached module graph is the wrong default here.
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`  dashboard   http://localhost:${port}`);
  console.log('');
  console.log('  The extension only answers pages on localhost or 127.0.0.1 — that is what');
  console.log('  externally_connectable in manifest.json allows. Append ?ext=<extension id>');
  console.log('  once, or use the "Open dashboard" button on the extension\'s options page.');
});
