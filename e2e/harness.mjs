/**
 * Shared plumbing for the browser end-to-end runs.
 *
 * These scripts drive the *real* extension in a real Chromium browser: the
 * service worker, the injected content script, the offscreen parser and the
 * action popup, all of them the shipped files.
 *
 * One deliberate deviation: `activeTab` is only granted when a human clicks the
 * toolbar icon, and no automation protocol can produce that click. So the run
 * works from a throwaway copy of the extension with `host_permissions` added
 * for the sites under test. Nothing else is changed, and the shipped
 * `manifest.json` keeps its narrow permission set.
 */
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { loadEnv, credentialsFromEnv, describeKey } from './env.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));

// Credentials for these runs live in a gitignored `.env` (see `.env.example`).
// Anything already in the environment wins, so a one-off key on the command
// line still overrides the file.
loadEnv(path.join(ROOT, '.env'));
export { credentialsFromEnv, describeKey };

/** Where Chromium/Chrome/Edge might be on this machine. */
const BROWSERS = [
  process.env.BROWSER_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export function findBrowser() {
  for (const candidate of BROWSERS) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('No Chrome/Chromium/Edge binary found. Set BROWSER_PATH to one.');
}

/**
 * Copies the extension to a temp directory and widens `host_permissions` so an
 * automated run can inject without the toolbar click that grants activeTab.
 */
export function stageExtension(hosts) {
  const dir = path.join(os.tmpdir(), `market-scraper-e2e-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });

  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  manifest.host_permissions = Array.from(new Set([...(manifest.host_permissions || []), ...hosts]));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function launch(extensionDir, profileName) {
  return puppeteer.launch({
    executablePath: findBrowser(),
    headless: false, // extensions do not load in the old headless mode
    protocolTimeout: 60000,
    userDataDir: path.join(os.tmpdir(), `${profileName}-${process.pid}`),
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1100,860',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
}

export async function serviceWorker(browser) {
  const target = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().includes('background.js'),
    { timeout: 20000 },
  );
  return { target, worker: await target.worker(), extensionId: new URL(target.url()).host };
}

/**
 * Opens the real action popup and returns a driver for it.
 *
 * Puppeteer will not hand back a `Page` for an action-popup target, so this
 * talks to it over a raw CDP session. The popup is dismissed whenever the
 * browser window changes focus, so `evaluate` reopens it and retries once.
 */
export async function popupDriver(browser, sw, { tabUrlPattern } = {}) {
  const open = async () => {
    await sw.evaluate(async (pattern) => {
      const tabs = pattern
        ? await chrome.tabs.query({ url: pattern })
        : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs[0];
      if (tab) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      const options = tab ? { windowId: tab.windowId } : undefined;
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          await chrome.action.openPopup(options);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 750));
        }
      }
      throw new Error('could not open the action popup');
    }, tabUrlPattern || null);

    const target = await browser.waitForTarget(
      (t) => t.type() === 'page' && t.url().includes('/src/popup.html'),
      { timeout: 20000 },
    );
    const session = await target.createCDPSession();
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    return session;
  };

  let session = await open();
  const errors = [];
  const attach = (s) => {
    s.on('Runtime.exceptionThrown', (event) => {
      const details = event.exceptionDetails || {};
      errors.push('popup exception: ' + ((details.exception && details.exception.description) || details.text));
    });
    s.on('Runtime.consoleAPICalled', (event) => {
      if (event.type === 'error') errors.push('popup console: ' + event.args.map((a) => a.value ?? a.description).join(' '));
    });
  };
  attach(session);

  const evaluate = async (expression) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
          expression, awaitPromise: true, returnByValue: true,
        });
        if (exceptionDetails) {
          throw new Error((exceptionDetails.exception && exceptionDetails.exception.description) || exceptionDetails.text);
        }
        return result.value;
      } catch (error) {
        if (attempt === 1 || !/Session closed|Target closed/i.test(String(error.message))) throw error;
        session = await open();
        attach(session);
        await sleep(800);
      }
    }
    return undefined;
  };

  const screenshot = async (file) => {
    try {
      const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(data, 'base64'));
    } catch (error) {
      errors.push(`screenshot ${path.basename(file)}: ${error.message}`);
    }
  };

  /** Polls an expression until it is truthy. Returns false on timeout. */
  const waitFor = async (expression, timeout = 60000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return true;
      await sleep(400);
    }
    return false;
  };

  return { evaluate, screenshot, waitFor, errors, reopen: async () => { session = await open(); attach(session); } };
}

/** Reads the whole popup surface in one round trip. */
export const READ_POPUP = `(() => {
  const t = (id) => { const el = document.getElementById(id); return el ? el.textContent.trim() : null; };
  const vis = (id) => { const el = document.getElementById(id); return Boolean(el && !el.classList.contains('hidden')); };
  return {
    status: t('status'),
    snapshotVisible: vis('snapshot-card'),
    ticker: t('snapshot-title'), price: t('snapshot-price'), currency: t('snapshot-currency'),
    change: t('snapshot-change'), volume: t('snapshot-volume'), scraped: t('snapshot-time'),
    selectors: Array.from(document.querySelectorAll('#snapshot-selectors li')).map((li) => li.textContent.trim()),
    heal: vis('heal-banner') ? t('heal-banner') : null,
    warn: vis('warn-banner') ? t('warn-banner') : null,
    adviceVisible: vis('advice-card'),
    action: t('advice-action'), score: t('advice-score'),
    rationale: t('advice-rationale'), source: t('advice-source'),
    logVisible: vis('log-card'),
    logItems: Array.from(document.querySelectorAll('#decision-log li')).map((li) => li.textContent.trim()),
  };
})()`;

/** True once the scan has either produced a card or settled on a message. */
export const SCAN_SETTLED = `(() => {
  const card = document.getElementById('snapshot-card');
  const status = document.getElementById('status');
  return (card && !card.classList.contains('hidden'))
    || (status && status.textContent && !/…|Scanning|Working/i.test(status.textContent));
})()`;
