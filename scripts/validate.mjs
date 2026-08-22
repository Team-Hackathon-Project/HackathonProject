/**
 * Static validation of the extension bundle, runnable on its own
 * (`npm run lint`) and asserted by `test/manifest.test.js`.
 *
 * Checks the things Chrome only tells you about at load time: manifest shape,
 * files the manifest points at, resolvable ES-module import graphs, and the
 * rule that the injected content script must not be a module.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { PROVIDER_HOSTS } from '../src/lib/providers.js';
import { SYNCED } from './web-sync.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** The dashboard's own scripts, checked for reach-back into the bundle. */
const WEB_SCRIPTS = [
  'web/js/main.js',
  'web/js/bridge.js',
  'web/js/state.js',
  'web/js/render.js',
  'web/js/sparkline.js',
  'web/js/alerts-ui.js',
];

/**
 * The exact permission set, still checked both ways: nothing missing, and
 * nothing extra. `alarms` and `notifications` are what let the watchlist be
 * monitored with the browser closed on the dashboard; neither can read a page.
 */
const REQUIRED_PERMISSIONS = ['activeTab', 'storage', 'scripting', 'offscreen', 'alarms', 'notifications'];

/**
 * Origins the dashboard may be served from and still reach the worker.
 *
 * `externally_connectable` is the one place where a page outside the extension
 * gets a line into it, so the list is checked twice over: the entries must be
 * exactly these, and none of them may be a wildcard broad enough to hand that
 * line to the open web.
 */
const DASHBOARD_ORIGINS = ['http://localhost/*', 'http://127.0.0.1/*'];

/** Patterns that would expose the external bus far too widely to ship. */
const OVERBROAD_MATCH = /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*|\*:\/\/\*\.[a-z]+\/\*)$/i;

const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');
const exists = (relative) => existsSync(path.join(ROOT, relative));

/** Collects every relative specifier imported by an ES module file. */
function importsOf(source) {
  const specifiers = [];
  const patterns = [
    /\bimport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) specifiers.push(match[1]);
  }
  return specifiers;
}

/** Walks the module graph from `entry`, reporting unresolvable imports. */
function checkModuleGraph(entry, problems, seen = new Set()) {
  if (seen.has(entry)) return;
  seen.add(entry);
  if (!exists(entry)) {
    problems.push(`missing module: ${entry}`);
    return;
  }
  for (const specifier of importsOf(read(entry))) {
    if (!specifier.startsWith('.')) {
      problems.push(`${entry} imports a bare specifier "${specifier}"; the extension must be dependency-free`);
      continue;
    }
    checkModuleGraph(path.posix.join(path.posix.dirname(entry), specifier), problems, seen);
  }
}

/**
 * Source with its comments blanked out.
 *
 * The reach-back check below greps for a literal path, and the files it greps
 * are the same files that document why that path is forbidden. Without this,
 * explaining the rule would break it.
 */
function stripComments(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

/** Every `src="..."` and `href="..."` an HTML page points at. */
function assetsOf(htmlPath) {
  const source = read(htmlPath);
  const assets = [];
  const pattern = /(?:src|href)\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (!/^(https?:|data:|#)/.test(match[1])) assets.push(match[1]);
  }
  return assets;
}

export function validate() {
  const problems = [];

  if (!exists('manifest.json')) return ['manifest.json is missing'];
  let manifest;
  try {
    manifest = JSON.parse(read('manifest.json'));
  } catch (error) {
    return [`manifest.json is not valid JSON: ${error.message}`];
  }

  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
  if (!manifest.background || manifest.background.type !== 'module') {
    problems.push('the service worker must be declared with "type": "module"');
  }
  if (manifest.background && manifest.background.page) {
    problems.push('MV3 forbids a persistent background page');
  }
  if (manifest.content_scripts) {
    problems.push('content scripts must be injected via chrome.scripting, not declared (that would need broad host permissions)');
  }

  const permissions = manifest.permissions || [];
  for (const permission of REQUIRED_PERMISSIONS) {
    if (!permissions.includes(permission)) problems.push(`missing permission: ${permission}`);
  }
  for (const permission of permissions) {
    if (!REQUIRED_PERMISSIONS.includes(permission)) problems.push(`permission outside the documented scope: ${permission}`);
  }
  // The only hosts the extension may reach are the model providers it ships.
  const declaredHosts = manifest.host_permissions || [];
  for (const host of declaredHosts) {
    if (!PROVIDER_HOSTS.includes(host)) problems.push(`unexpected host permission: ${host}`);
  }
  for (const host of PROVIDER_HOSTS) {
    if (!declaredHosts.includes(host)) problems.push(`missing host permission for a shipped provider: ${host}`);
  }

  // Background refresh needs to read a quote page the user is not looking at,
  // which is a host permission. It is optional rather than declared: nothing is
  // granted at install, each origin is asked for separately from a gesture, and
  // the user can take any of them back. The pattern below is the *ceiling* on
  // what may ever be asked for, not something the extension holds.
  const optional = manifest.optional_host_permissions || [];
  const OPTIONAL_ALLOWED = ['http://*/*', 'https://*/*'];
  for (const pattern of optional) {
    if (!OPTIONAL_ALLOWED.includes(pattern)) {
      problems.push(`unexpected optional host permission: ${pattern}`);
    }
  }
  if (optional.includes('<all_urls>')) {
    problems.push('optional_host_permissions must not use <all_urls>');
  }

  // The dashboard's line into the worker, and how wide it is.
  const external = manifest.externally_connectable;
  if (!external || !Array.isArray(external.matches)) {
    problems.push('externally_connectable.matches must list the dashboard origins');
  } else {
    for (const match of external.matches) {
      if (OVERBROAD_MATCH.test(match)) {
        problems.push(`externally_connectable match is too broad: ${match}`);
      } else if (!DASHBOARD_ORIGINS.includes(match)) {
        problems.push(`undocumented externally_connectable match: ${match}`);
      }
    }
    for (const origin of DASHBOARD_ORIGINS) {
      if (!external.matches.includes(origin)) {
        problems.push(`missing externally_connectable match: ${origin}`);
      }
    }
  }

  // Every file the manifest points at must exist.
  const manifestFiles = [
    manifest.background && manifest.background.service_worker,
    manifest.action && manifest.action.default_popup,
    manifest.options_page,
    ...Object.values((manifest.action && manifest.action.default_icon) || {}),
    ...Object.values(manifest.icons || {}),
  ].filter(Boolean);
  for (const file of manifestFiles) {
    if (!exists(file)) problems.push(`manifest references a missing file: ${file}`);
  }

  // ES-module graphs must resolve, with no third-party dependencies.
  // The dashboard is held to the same rule: it is served both from inside the
  // extension and as a plain static folder, and neither has a build step to
  // resolve a bare specifier for it.
  for (const entry of ['src/background.js', 'src/popup.js', 'src/options.js', 'src/offscreen.js', 'web/js/main.js']) {
    checkModuleGraph(entry, problems);
  }

  // The injected content script is a classic script: no imports allowed.
  const content = read('src/content.js');
  if (/^\s*import[\s({]/m.test(content) || /\bexport\s/.test(content)) {
    problems.push('src/content.js must be a classic script — chrome.scripting.executeScript cannot inject an ES module');
  }

  // HTML pages must only reference files that exist.
  for (const page of ['src/popup.html', 'src/options.html', 'src/offscreen.html', 'web/index.html']) {
    if (!exists(page)) {
      problems.push(`missing page: ${page}`);
      continue;
    }
    for (const asset of assetsOf(page)) {
      const resolved = path.posix.join(path.posix.dirname(page), asset);
      if (!exists(resolved)) problems.push(`${page} references a missing asset: ${asset}`);
    }
  }

  // The dashboard is also served as a bare static folder, where `../src/` does
  // not exist. It therefore carries its own copies of the files it shares with
  // the extension, and those copies have to still be the same files — a stale
  // duplicate would drift the two surfaces apart silently.
  for (const [source, copy] of Object.entries(SYNCED)) {
    if (!exists(copy)) problems.push(`${copy} is missing — run \`npm run web:sync\``);
    else if (read(copy) !== read(source)) {
      problems.push(`${copy} has drifted from ${source} — run \`npm run web:sync\``);
    }
  }

  // Nothing under web/ may reach back into the extension bundle: those paths
  // resolve when the dashboard is opened from chrome-extension:// and 404 when
  // it is served from a static host, which is the harder failure to spot.
  // Comments are stripped first so the files can explain the rule they follow.
  for (const file of ['web/index.html', 'web/dashboard.css', ...WEB_SCRIPTS]) {
    if (exists(file) && /\.\.\/(\.\.\/)?src\//.test(stripComments(read(file)))) {
      problems.push(`${file} references ../src/, which does not exist when the dashboard is served as a website`);
    }
  }

  // The offscreen document the worker opens must be the one that exists.
  const constants = read('src/lib/constants.js');
  const offscreenPath = /OFFSCREEN_PATH\s*=\s*'([^']+)'/.exec(constants);
  if (!offscreenPath || !exists(offscreenPath[1])) {
    problems.push('OFFSCREEN_PATH does not point at an existing file');
  }

  return problems;
}

// `file://${argv[1]}` never matches on Windows: argv[1] arrives with drive
// letters and backslashes, while import.meta.url is a slash-separated URL with
// three slashes. The naive comparison made `npm run lint` a silent no-op here -
// no output, and exit 0 whatever the state of the bundle.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = validate();
  if (problems.length) {
    console.error(`✖ ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('✔ extension bundle validates');
}
