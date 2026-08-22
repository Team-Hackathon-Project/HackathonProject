/**
 * Mirrors the shared parts of the extension into `web/vendor/` (`npm run web:sync`).
 *
 * The dashboard is served two ways: from inside the extension bundle, where
 * `../src/` is right there, and from a bare static folder rooted at `web/`,
 * where it is not. A relative import out of `web/` resolves in the first case
 * and 404s in the second, and that is the harder failure to notice — the
 * extension route is the one you develop against.
 *
 * So `web/` reaches for nothing outside itself, and the handful of files it
 * shares with the extension are copied in here instead. Every copied file is
 * dependency-free on its own, which is what makes a flat copy sufficient.
 *
 * The copies are committed, so a clone can serve `web/` with no build step at
 * all. `scripts/validate.mjs` fails the lint when one drifts, so this script is
 * the fix for that failure rather than something to remember to run.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * Source file -> its home under `web/vendor/`.
 *
 * `advisor.js`, `normalize.js` and `targets.js` are the pure ones: no `chrome.*`
 * and no imports of their own, so the dashboard can run the same parsing,
 * profit-and-loss and target arithmetic the popup does rather than a second
 * implementation that rounds differently.
 */
export const SYNCED = {
  'src/theme.css': 'web/vendor/theme.css',
  'src/lib/advisor.js': 'web/vendor/lib/advisor.js',
  'src/lib/normalize.js': 'web/vendor/lib/normalize.js',
  'src/lib/targets.js': 'web/vendor/lib/targets.js',
  'src/lib/alerts.js': 'web/vendor/lib/alerts.js',
};

/** Copies anything out of date. Returns the list of files it rewrote. */
export function syncWeb() {
  const written = [];
  for (const [from, to] of Object.entries(SYNCED)) {
    const source = readFileSync(path.join(ROOT, from), 'utf8');
    const target = path.join(ROOT, to);
    if (existsSync(target) && readFileSync(target, 'utf8') === source) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
    written.push(to);
  }
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const written = syncWeb();
  if (!written.length) console.log('✔ web/vendor is already in sync');
  else for (const file of written) console.log(`  wrote ${file}`);
}
