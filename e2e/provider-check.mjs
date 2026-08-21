/**
 * Checks that a provider is reachable and answers a schema-constrained request,
 * exercised through the extension's own service worker — the only place that
 * matters, since that is where every real call originates.
 *
 *   npm run e2e:provider                     # uses the key in .env
 *   npm run e2e:provider -- anthropic        # the other provider from .env
 *   npm run e2e:provider -- groq gsk_…       # a one-off key, bypassing .env
 *
 * With no key configured anywhere it still runs, as a transport-only check.
 *
 * Without a key it sends a deliberately unauthenticated request: an HTTP 401
 * coming back is a pass, because it proves the host permission and CORS let the
 * request out of the worker at all. A network-level failure is the interesting
 * negative. With a key it is the real thing, and the only way to confirm that a
 * given model honours structured output.
 */
import { stageExtension, launch, serviceWorker, sleep, credentialsFromEnv, describeKey } from './harness.mjs';

const fromEnv = credentialsFromEnv();
const providerId = process.argv[2] || fromEnv.provider;
// A key on the command line wins; otherwise .env supplies it, and if that is
// empty the run falls back to a transport-only check with a dummy key.
const apiKey = process.argv[3] || (providerId === fromEnv.provider ? fromEnv.apiKey : (fromEnv.all[providerId] || {}).apiKey || '');
const model = providerId === fromEnv.provider ? fromEnv.model : (fromEnv.all[providerId] || {}).model || '';
const log = (...args) => console.log('[provider]', ...args);

log(`provider: ${providerId} · key: ${describeKey(apiKey)}${apiKey ? '' : ' (transport-only check)'}`);

const extensionDir = stageExtension([]);
const browser = await launch(extensionDir, 'market-scraper-e2e-provider');
let failed = false;

try {
  const { extensionId } = await serviceWorker(browser);
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options.html`, { waitUntil: 'load' });
  await sleep(600);

  const response = await page.evaluate(async (provider, key, chosenModel) => {
    const started = Date.now();
    const result = await chrome.runtime.sendMessage({
      type: 'TEST_PROVIDER',
      payload: { provider, apiKey: key || 'not-a-real-key', model: chosenModel || '' },
    });
    return { ...result, roundTripMs: Date.now() - started };
  }, providerId, apiKey, model);

  log(JSON.stringify(response, null, 2));

  const message = String((response && response.error) || '');
  const reachedProvider = /API \d{3}:/.test(message); // an HTTP status means the request got out
  const unauthorized = /API (401|403):/.test(message);

  if (response && response.ok) {
    const { label, model, ms, note } = response.data;
    log(`PASS: ${label} answered a schema-constrained request as ${model} in ${ms} ms${note ? ` — "${note}"` : ''}`);
  } else if (!apiKey && unauthorized) {
    log(`PASS: reachable from the service worker — the dummy key was rejected by the provider, not by the browser.`);
    log(`      (${message})`);
  } else if (/Network error/.test(message)) {
    failed = true;
    log('FAIL: the request never reached the provider. Check the host permission in manifest.json.');
  } else if (reachedProvider) {
    failed = true;
    log(`FAIL: ${message}`);
    if (/API 400:/.test(message)) {
      log('If that mentions response_format, the model does not support strict JSON schema.');
      log('The client retries such models with the schema in the prompt, so pick another model or ignore this.');
    }
  } else {
    failed = true;
    log(`FAIL: ${message || 'no response from the service worker'}`);
  }
} catch (error) {
  failed = true;
  log('FATAL', error);
} finally {
  await browser.close();
  process.exitCode = failed ? 1 : 0;
}
