/**
 * End-to-end run of the self-healing loop, offline and deterministic.
 *
 *   npm run e2e:heal            # Anthropic wire format
 *   npm run e2e:heal -- groq    # Groq / OpenAI-compatible wire format
 *
 * Serves a quote page whose markup matches none of the shipped selectors, then
 * stubs the provider endpoint *inside the service worker* so the repair runs
 * against a known answer instead of a live model and a live bill. Everything
 * else is real: the injection, the container capture, the offscreen sanitizer,
 * the in-page validation, the registry write, and the popup.
 *
 * What it asserts:
 *   1. `price` is healed from the model's selector and the value appears.
 *   2. The same selector proposed for `volume` and `change_percentage` is
 *      *refused*, because "$182.44" is neither — and never reaches the registry.
 *   3. A second scan reuses the healed selector with no further repair call.
 */
import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ROOT, stageExtension, launch, serviceWorker, popupDriver, sleep, READ_POPUP, SCAN_SETTLED } from './harness.mjs';

const PROVIDER = process.argv[2] || 'anthropic';
const PORT = Number(process.env.PORT || 8731);
const OUT = path.join(ROOT, 'e2e', `shots-heal-${PROVIDER}`);
mkdirSync(OUT, { recursive: true });

const log = (...args) => console.log('[heal]', ...args);
const report = { steps: [], errors: [] };
const fail = (message) => { report.errors.push(message); log('FAIL:', message); };

const html = readFileSync(path.join(ROOT, 'e2e', 'fixture.html'), 'utf8');
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
log('fixture server on http://localhost:' + PORT);

const extensionDir = stageExtension(['http://localhost/*']);
const browser = await launch(extensionDir, 'market-scraper-e2e-heal');

try {
  const { worker: sw, extensionId } = await serviceWorker(browser);
  log('service worker up:', extensionId);

  // 1. a key (so healing is enabled) and a position (so the advisory has teeth)
  const options = await browser.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options.html`, { waitUntil: 'load' });
  await sleep(600);
  await options.evaluate(async (provider) => {
    await chrome.storage.local.set({
      settings: {
        provider,
        providers: {
          anthropic: { apiKey: 'sk-ant-e2e-stub', model: 'claude-opus-5' },
          groq: { apiKey: 'gsk_e2e_stub', model: 'openai/gpt-oss-120b' },
        },
        selfHealEnabled: true,
        llmAdviceEnabled: true,
        maxSnippetChars: 12000,
      },
      portfolio: { NVDA: { shares: 10, cost_basis: 120, buy_below: 150, sell_above: 175 } },
    });
  }, PROVIDER);
  log('provider under test:', PROVIDER);

  // 2. stub the provider endpoint in the worker, and watch for warnings
  await sw.evaluate((provider) => {
    self.__llmCalls = [];
    self.__warns = [];
    const warn = console.warn;
    console.warn = (...args) => { self.__warns.push(args.map(String).join(' ')); warn(...args); };

    // Each provider is answered in its own wire format, so this run exercises
    // the real parsing path rather than a single shared shape.
    const envelope = (payload) => JSON.stringify(provider === 'groq'
      ? {
          id: 'chatcmpl_e2e', object: 'chat.completion', model: 'openai/gpt-oss-120b',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(payload) } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }
      : {
          id: 'msg_e2e', type: 'message', role: 'assistant', model: 'claude-opus-5',
          stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(payload) }],
          usage: { input_tokens: 100, output_tokens: 50 },
        });

    self.fetch = async (url, init) => {
      const body = init && init.body ? String(init.body) : '';
      const headers = (init && init.headers) || {};
      const kind = /"selector"/.test(body) || /selector/i.test(body) ? 'heal' : 'advice';
      self.__llmCalls.push({
        url: String(url),
        kind,
        hasKey: Boolean(headers['x-api-key'] || headers.authorization),
      });
      // The same node is proposed for every field on purpose: only `price` is
      // actually a price, so the other two must be rejected.
      const payload = kind === 'heal'
        ? { selector: '.qz-8f31ab', strategy: 'css', confidence: 0.93, reason: 'The live value node carries the hashed class.' }
        : {
            ticker: 'NVDA', action: 'SELL', confidence_score: 0.72,
            rationale: 'Price sits above the configured sell_above target and the position is well above its cost basis, so trimming locks in the gain. This is a suggestion only; no order is placed.',
            user_action_required: true,
          };
      return new Response(envelope(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  }, PROVIDER);

  // 3. the page whose markup nothing matches
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  await page.goto(`http://localhost:${PORT}/quote/NVDA`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, '1-mutated-page.png') });

  const popup = await popupDriver(browser, sw, { tabUrlPattern: 'http://localhost/*' });
  await sleep(1000);
  await popup.evaluate("document.getElementById('scrape-btn').click()");
  if (!(await popup.waitFor(SCAN_SETTLED))) fail('the scan never settled');
  await sleep(3000);
  await popup.screenshot(path.join(OUT, '2-healed-popup.png'));

  const state = await popup.evaluate(READ_POPUP);
  report.steps.push({ step: 'heal-scan', ...state });
  log('popup state:', JSON.stringify(state, null, 2));

  if (state.price !== '182.44') fail(`expected the healed price 182.44, got ${state.price}`);
  if (!/price/.test(state.heal || '')) fail('the popup did not report a healed price selector');
  if (!/not a valid volume/.test(state.warn || '')) fail('the wrong-field volume proposal was not refused');
  if (state.action !== 'SELL') fail(`expected the stubbed SELL advisory, got ${state.action}`);

  const worker = await sw.evaluate(async () => ({
    calls: self.__llmCalls || [],
    warns: self.__warns || [],
    offscreenStillOpen: await chrome.offscreen.hasDocument(),
  }));
  report.worker = worker;
  log('llm calls:', worker.calls.length, '| worker warnings:', worker.warns.length ? worker.warns : 'none');
  if (worker.calls.some((call) => !call.hasKey)) fail('a request went out without the API key header');
  const expectedHost = PROVIDER === 'groq' ? 'api.groq.com' : 'api.anthropic.com';
  if (worker.calls.some((call) => !call.url.includes(expectedHost))) fail(`a request went somewhere other than ${expectedHost}`);
  if (worker.warns.some((w) => /offscreen sanitize failed/.test(w))) fail('the offscreen sanitizer fell back to the regex path');
  if (worker.offscreenStillOpen) fail('the offscreen document was left open after the scrape');

  const stored = await options.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return { registry: all.selector_registry, healLog: all.heal_log, snapshots: all.snapshots };
  });
  report.storage = stored;
  log('registry:', JSON.stringify(stored.registry));

  const host = (stored.registry && stored.registry[`localhost:${PORT}`]) || {};
  if (!host.price || host.price.selector !== '.qz-8f31ab') fail('the healed price selector was not persisted');
  if (host.volume || host.change_percentage) fail('a refused selector reached the registry');
  if ((stored.snapshots.NVDA || {}).volume !== null) fail('a price was stored as the volume');

  // 4. rescan: the healed selector must come from storage, not from the model
  const healCallsBefore = worker.calls.filter((call) => call.kind === 'heal').length;
  await popup.reopen();
  await sleep(1000);
  await popup.evaluate("document.getElementById('scrape-btn').click()");
  if (!(await popup.waitFor(SCAN_SETTLED))) fail('the rescan never settled');
  await sleep(3000);
  const rescan = await popup.evaluate(READ_POPUP);
  const after = await sw.evaluate(() => (self.__llmCalls || []).filter((call) => call.kind === 'heal').length);
  report.steps.push({ step: 'rescan', price: rescan.price, heal: rescan.heal, healCallsBefore, healCallsAfter: after });
  log('rescan:', JSON.stringify({ price: rescan.price, heal: rescan.heal, healCallsBefore, healCallsAfter: after }));
  await popup.screenshot(path.join(OUT, '3-rescan.png'));

  if (rescan.price !== '182.44') fail('the cached healed selector did not survive a rescan');
  if (rescan.heal) fail('the rescan healed again instead of reusing the stored selector');

  report.errors.push(...popup.errors);
} catch (error) {
  report.errors.push('FATAL: ' + (error && error.stack ? error.stack : String(error)));
  log('FATAL', error);
} finally {
  writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2));
  log(report.errors.length ? `FAILED (${report.errors.length})` : 'all checks passed');
  await browser.close();
  server.close();
  rmSync(extensionDir, { recursive: true, force: true });
  process.exitCode = report.errors.length ? 1 : 0;
}
