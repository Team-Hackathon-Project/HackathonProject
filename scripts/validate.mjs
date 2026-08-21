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

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const REQUIRED_PERMISSIONS = ['activeTab', 'storage', 'scripting', 'offscreen'];

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
  for (const entry of ['src/background.js', 'src/popup.js', 'src/options.js', 'src/offscreen.js']) {
    checkModuleGraph(entry, problems);
  }

  // The injected content script is a classic script: no imports allowed.
  const content = read('src/content.js');
  if (/^\s*import[\s({]/m.test(content) || /\bexport\s/.test(content)) {
    problems.push('src/content.js must be a classic script — chrome.scripting.executeScript cannot inject an ES module');
  }

  // HTML pages must only reference files that exist.
  for (const page of ['src/popup.html', 'src/options.html', 'src/offscreen.html']) {
    if (!exists(page)) {
      problems.push(`missing page: ${page}`);
      continue;
    }
    for (const asset of assetsOf(page)) {
      const resolved = path.posix.join(path.posix.dirname(page), asset);
      if (!exists(resolved)) problems.push(`${page} references a missing asset: ${asset}`);
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
