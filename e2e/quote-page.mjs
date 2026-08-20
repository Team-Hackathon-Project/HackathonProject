/**
 * End-to-end run against a live quote page.
 *
 *   npm run e2e                                    # Yahoo Finance, AAPL
 *   npm run e2e -- https://stockanalysis.com/stocks/aapl/
 *
 * Loads the extension, opens the page, scans it through the real action popup,
 * approves the advisory through the confirmation modal, and checks what landed
 * in `chrome.storage.local`. Screenshots go to `e2e/shots/`.
 *
 * Live sites are not fixtures: a page can rate-limit, A/B test, or serve an
 * anti-bot interstitial, and then fields legitimately come back missing. Read
 * `1-quote-page.png` before blaming the extension.
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ROOT, stageExtension, launch, serviceWorker, popupDriver, sleep, READ_POPUP, SCAN_SETTLED } from './harness.mjs';

const url = process.argv[2] || 'https://finance.yahoo.com/quote/AAPL/';
const settleMs = Number(process.env.SETTLE_MS || 2500);
const origin = new URL(url).origin;

const OUT = path.join(ROOT, 'e2e', 'shots');
mkdirSync(OUT, { recursive: true });

const log = (...args) => console.log('[e2e]', ...args);
const report = { url, steps: [], errors: [] };

const extensionDir = stageExtension([`${origin}/*`]);
const browser = await launch(extensionDir, 'market-scraper-e2e');

try {
  const { worker: sw, extensionId } = await serviceWorker(browser);
  log('service worker up:', extensionId);

  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.bringToFront();
  await sleep(settleMs);
  log('quote page:', page.url());
  await page.screenshot({ path: path.join(OUT, '1-quote-page.png') });

  const popup = await popupDriver(browser, sw);
  await sleep(1200);
  log('action popup open');
  await popup.screenshot(path.join(OUT, '2-popup-initial.png'));

  await popup.evaluate("document.getElementById('scrape-btn').click()");
  if (!(await popup.waitFor(SCAN_SETTLED))) report.errors.push('the scan never settled');
  await sleep(3000);
  await popup.screenshot(path.join(OUT, '3-popup-scanned.png'));

  const scanned = await popup.evaluate(READ_POPUP);
  report.steps.push({ step: 'scan', ...scanned });
  log('after scan:', JSON.stringify(scanned, null, 2));

  if (scanned.adviceVisible) {
    await popup.evaluate("document.getElementById('approve-btn').click()");
    await sleep(600);
    const modal = await popup.evaluate(`(() => {
      const m = document.getElementById('modal');
      const b = document.getElementById('modal-body');
      return { open: Boolean(m && !m.classList.contains('hidden')), body: b ? b.textContent.trim() : null };
    })()`);
    report.steps.push({ step: 'approve-modal', ...modal });
    log('confirmation modal:', JSON.stringify(modal));
    await popup.screenshot(path.join(OUT, '4-confirm-modal.png'));

    if (!modal.open) report.errors.push('Approve did not raise a confirmation modal');
    else {
      await popup.evaluate("document.getElementById('modal-confirm').click()");
      await sleep(1200);
      const after = await popup.evaluate(READ_POPUP);
      report.steps.push({ step: 'after-confirm', status: after.status, logItems: after.logItems });
      log('decision log:', JSON.stringify(after.logItems));
      await popup.screenshot(path.join(OUT, '5-decision-logged.png'));
      if (!after.logItems.length) report.errors.push('the decision was not written to the log');
    }
  } else {
    log('no advisory card — the page did not yield a ticker and a price');
  }

  const options = await browser.newPage();
  await options.setViewport({ width: 900, height: 900 });
  await options.goto(`chrome-extension://${extensionId}/src/options.html`, { waitUntil: 'load' });
  await sleep(1200);
  await options.screenshot({ path: path.join(OUT, '6-options.png'), fullPage: true });

  report.storage = await options.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return { keys: Object.keys(all), snapshots: all.snapshots || null, decisions: all.decisions || null };
  });
  log('storage keys:', report.storage.keys);
  log('snapshot:', JSON.stringify(report.storage.snapshots));

  report.errors.push(...popup.errors);
} catch (error) {
  report.errors.push('FATAL: ' + (error && error.stack ? error.stack : String(error)));
  log('FATAL', error);
} finally {
  writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2));
  log('errors:', report.errors.length ? report.errors : 'none');
  await browser.close();
  rmSync(extensionDir, { recursive: true, force: true });
  process.exitCode = report.errors.length ? 1 : 0;
}
