/**
 * The loopback bridge (`npm run agent`).
 *
 * A ~200-line `node:http` server, no dependencies, bound to 127.0.0.1. It is
 * the only way the extension can use the Scraping Browser at all: the endpoint
 * carries its credentials in the URL, and a browser `WebSocket` is required by
 * the HTML standard to throw on a URL that "includes credentials". See the
 * header of `src/lib/brightdata.js`.
 *
 *   GET  /health     configuration and readiness, with nothing secret in it
 *   POST /scrape     { url?, ticker?, registry?, selfHeal? } -> one scrape
 *   POST /studio     { tickers?, urls? } -> a Scraper Studio collector run
 *   GET  /registry   every healed selector the agent knows
 *   POST /registry   merge the extension's healed selectors into the agent's
 *
 * Two things guard it, because "it is only on localhost" is not by itself a
 * boundary — any page in the browser can also reach localhost:
 *
 *   Origin allowlist   only chrome-extension:// and loopback origins get a
 *                      CORS preflight through, so a random site cannot spend
 *                      the user's Bright Data hours from a background tab.
 *   Optional token     BRIGHTDATA_BRIDGE_TOKEN, checked on every route when set.
 */
import http from 'node:http';
import { loadAgentConfig, loadAgentEnv } from './config.mjs';
import { scrapeThroughBrightData } from './scrape.mjs';
import { scrapeThroughStudio } from './studio.mjs';
import { getRegistry, mergeRegistry, getHealLog } from './registry.mjs';
import { BRIDGE_PROTOCOL } from '../src/lib/brightdata.js';

const MAX_BODY_BYTES = 256 * 1024;

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => console.log(`[${now()}] ${message}`);

/** Origins allowed to preflight: the extension itself, and a local dashboard. */
export function originAllowed(origin) {
  if (!origin) return true; // curl and same-origin requests send none
  if (origin.startsWith('chrome-extension://')) return true;
  if (origin.startsWith('moz-extension://')) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Constant-time-ish comparison, so a token cannot be guessed byte by byte. */
export function tokenMatches(expected, supplied) {
  if (!expected) return true;
  const a = String(expected);
  const b = String(supplied || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function send(response, status, payload, origin) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': origin || '*',
    'access-control-allow-headers': 'content-type, x-bridge-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
    vary: 'Origin',
  });
  response.end(body);
}

/**
 * Scrapes run one at a time.
 *
 * Each one is a whole remote browser session. Firing several in parallel
 * because two dashboard cards refreshed at once is how a Bright Data plan gets
 * spent in an afternoon, and the pages are not in a hurry.
 */
function makeQueue() {
  let tail = Promise.resolve();
  return (job) => {
    const result = tail.then(job, job);
    tail = result.then(() => {}, () => {});
    return result;
  };
}

export function createBridge(config = loadAgentConfig()) {
  const queue = makeQueue();

  const routes = {
    'GET /health': async () => ({
      ok: config.ok,
      service: 'brightdata-bridge',
      protocol: BRIDGE_PROTOCOL,
      tokenRequired: Boolean(config.bridge.token),
      brightdata: config.summary.brightdata,
      llm: config.summary.llm,
      studio: config.summary.studio,
      selfHealing: {
        available: Boolean(config.llm.apiKey),
        reason: config.llm.apiKey ? null : 'no model API key in .env — scrapes will run without repair',
      },
      heals: getHealLog().slice(0, 10),
    }),

    'GET /registry': async () => ({ ok: true, registry: getRegistry() }),

    'POST /registry': async (body) => {
      const { merged, registry } = mergeRegistry(body.registry || {});
      if (merged) log(`merged ${merged} healed selector(s) from the extension`);
      return { ok: true, merged, registry };
    },

    // Scraper Studio: the collector is authored and published in Bright Data's
    // own IDE and runs on their infrastructure. This route only queues inputs
    // and hands back what the collector produced, in our snapshot shape.
    'POST /studio': async (body) => queue(async () => {
      const tickers = Array.isArray(body.tickers) ? body.tickers : (body.ticker ? [body.ticker] : []);
      const urls = Array.isArray(body.urls) ? body.urls : (body.url ? [body.url] : []);
      const label = tickers.join(',') || urls.join(',') || '(nothing)';
      log(`studio ${label}`);
      try {
        const result = await scrapeThroughStudio({
          tickers,
          urls,
          config,
          onProgress: (event) => log(`  ${event.phase}${event.status ? ` (${event.status})` : ''}`),
        });
        log(`  ${result.ok ? 'ok' : 'no usable rows'} ${label} — ${result.snapshots.length} snapshot(s) in ${result.duration_ms}ms`);
        return result;
      } catch (error) {
        const message = String((error && error.message) || error);
        log(`  error ${label}: ${message}`);
        return { ok: false, method: 'scraper-studio', error: message };
      }
    }),

    'POST /scrape': async (body) => queue(async () => {
      const label = body.ticker || body.url || '(unnamed)';
      if (body.registry) mergeRegistry(body.registry);
      log(`scrape ${label}`);
      try {
        const result = await scrapeThroughBrightData({
          url: body.url,
          ticker: body.ticker,
          config,
          selfHeal: body.selfHeal !== false,
          log: (message) => log(`  ${message}`),
        });
        const healed = result.healed && result.healed.length
          ? ` healed:${result.healed.map((entry) => entry.field).join(',')}`
          : '';
        log(`  ${result.ok ? 'ok' : 'failed'} ${label}${healed} in ${result.duration_ms}ms`);
        return result;
      } catch (error) {
        const message = String((error && error.message) || error);
        log(`  error ${label}: ${message}`);
        return { ok: false, ticker: body.ticker || null, method: 'brightdata', error: message };
      }
    }),
  };

  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin || '';
    if (!originAllowed(origin)) {
      send(response, 403, { ok: false, error: 'origin not allowed' }, 'null');
      return;
    }
    const allow = origin || '*';

    if (request.method === 'OPTIONS') {
      send(response, 204, {}, allow);
      return;
    }
    if (!tokenMatches(config.bridge.token, request.headers['x-bridge-token'])) {
      send(response, 401, { ok: false, error: 'bridge token missing or wrong' }, allow);
      return;
    }

    const path = (request.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
    const handler = routes[`${request.method} ${path}`];
    if (!handler) {
      send(response, 404, { ok: false, error: `no route for ${request.method} ${path}` }, allow);
      return;
    }

    let body = {};
    if (request.method === 'POST') {
      try {
        const text = await readBody(request);
        body = text ? JSON.parse(text) : {};
      } catch (error) {
        send(response, 400, { ok: false, error: `unreadable request body: ${String((error && error.message) || error)}` }, allow);
        return;
      }
    }

    try {
      send(response, 200, await handler(body), allow);
    } catch (error) {
      send(response, 500, { ok: false, error: String((error && error.message) || error) }, allow);
    }
  });

  return server;
}

export function startBridge(config = loadAgentConfig()) {
  const server = createBridge(config);
  return new Promise((resolve) => {
    server.listen(config.bridge.port, config.bridge.host, () => {
      log(`Bright Data bridge listening on http://${config.bridge.host}:${config.bridge.port}`);
      log(`  Bright Data: ${config.summary.brightdata.configured
        ? `${config.summary.brightdata.description}`
        : `NOT CONFIGURED — ${config.summary.brightdata.error}`}`);
      log(`  self-healing: ${config.llm.apiKey
        ? `${config.summary.llm.provider} (${config.summary.llm.model})`
        : 'OFF — no model API key in .env'}`);
      log(`  token: ${config.bridge.token ? 'required' : 'not set (any local page may call this bridge)'}`);
      resolve(server);
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  loadAgentEnv();
  startBridge().catch((error) => {
    console.error(String((error && error.stack) || error));
    process.exit(1);
  });
}
