/**
 * Agent configuration: where the Bright Data endpoint, the bridge settings and
 * the model credentials come from.
 *
 * All of it is environment, read out of the gitignored `.env` at the repository
 * root. Nothing is hard-coded, and nothing here ever prints a secret — the
 * summary functions return the redacted forms from `src/lib/brightdata.js`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, credentialsFromEnv, describeKey } from '../e2e/env.mjs';
import {
  parseEndpoint, buildEndpoint, describeEndpoint, redactEndpoint, withGeo, geoOf, GEO_PARAMS, DEFAULT_BRIDGE_URL,
} from '../src/lib/brightdata.js';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Reads `.env` into `process.env` without clobbering anything already set. */
export function loadAgentEnv(env = process.env) {
  loadEnv(path.join(ROOT, '.env'), env);
  return env;
}

/**
 * Resolves the Scraping Browser endpoint from the environment.
 *
 * Three spellings are accepted, most specific first, because three different
 * places in Bright Data's own documentation hand you the credentials in three
 * different shapes:
 *
 *   BRIGHTDATA_BROWSER_URL   the full `wss://user:pass@brd.superproxy.io:9222`
 *   BRIGHTDATA_AUTH / AUTH   the bare `user:pass` pair their samples use
 *   BRIGHTDATA_CUSTOMER + BRIGHTDATA_ZONE + BRIGHTDATA_PASSWORD
 */
export function endpointFromEnv(env = process.env) {
  const resolved = rawEndpointFromEnv(env);
  if (!resolved.ok) return resolved;

  // Geo-pinning is applied here rather than asked of the user as a hand-edited
  // username, because getting the suffix order wrong fails silently: Bright
  // Data serves the request from wherever it likes and the page looks merely
  // unreadable. See `withGeo` for why the country matters at all.
  const geo = geoFromEnv(env);
  const endpoint = withGeo(resolved.endpoint, geo);
  return { ...parseEndpoint(endpoint), source: resolved.source, geo: geoOf(endpoint) };
}

/** Which of the three accepted spellings supplied the credentials. */
function rawEndpointFromEnv(env) {
  const direct = (env.BRIGHTDATA_BROWSER_URL || '').trim();
  if (direct) return { ...parseEndpoint(direct), source: 'BRIGHTDATA_BROWSER_URL' };

  const auth = (env.BRIGHTDATA_AUTH || env.AUTH || '').trim();
  if (auth) {
    const source = env.BRIGHTDATA_AUTH ? 'BRIGHTDATA_AUTH' : 'AUTH';
    return { ...parseEndpoint(auth), source };
  }

  const customer = (env.BRIGHTDATA_CUSTOMER || '').trim();
  const zone = (env.BRIGHTDATA_ZONE || '').trim();
  const password = (env.BRIGHTDATA_PASSWORD || '').trim();
  if (customer && zone && password) {
    return { ...parseEndpoint(buildEndpoint({ customer, zone, password })), source: 'BRIGHTDATA_CUSTOMER/ZONE/PASSWORD' };
  }

  return {
    ok: false,
    source: null,
    error: 'No Bright Data endpoint in the environment. Set BRIGHTDATA_BROWSER_URL in .env — see .env.example.',
  };
}

/** `BRIGHTDATA_COUNTRY`, `BRIGHTDATA_CITY`, and the rest, as a geo object. */
export function geoFromEnv(env = process.env) {
  const geo = {};
  for (const key of GEO_PARAMS) {
    const value = (env[`BRIGHTDATA_${key.toUpperCase()}`] || '').trim();
    if (value) geo[key] = value;
  }
  return geo;
}

/** Bridge server settings: address, port, and the shared token if one is set. */
export function bridgeFromEnv(env = process.env) {
  const port = Number((env.BRIGHTDATA_BRIDGE_PORT || '').trim()) || new URL(DEFAULT_BRIDGE_URL).port || 8791;
  const host = (env.BRIGHTDATA_BRIDGE_HOST || '127.0.0.1').trim();
  const token = (env.BRIGHTDATA_BRIDGE_TOKEN || '').trim();
  return { host, port: Number(port), token, url: `http://${host}:${port}` };
}

/** Timeouts and behaviour knobs, all overridable but sane unset. */
export function tuningFromEnv(env = process.env) {
  const number = (name, fallback) => {
    const value = Number((env[name] || '').trim());
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    navigationTimeoutMs: number('BRIGHTDATA_NAV_TIMEOUT_MS', 120000),
    connectTimeoutMs: number('BRIGHTDATA_CONNECT_TIMEOUT_MS', 60000),
    captchaDetectTimeoutMs: number('BRIGHTDATA_CAPTCHA_TIMEOUT_MS', 10000),
    /** Extra settle time after load, for prices painted a tick after onload. */
    settleMs: number('BRIGHTDATA_SETTLE_MS', 1500),
    maxSnippetChars: number('BRIGHTDATA_MAX_SNIPPET_CHARS', 12000),
    solveCaptcha: (env.BRIGHTDATA_SOLVE_CAPTCHA || '').trim().toLowerCase() !== 'false',
  };
}

/** The model credentials the healing loop uses, or `apiKey: ''` for offline. */
export function llmFromEnv(env = process.env) {
  return credentialsFromEnv(env);
}

/**
 * Everything at once, plus a printable summary that contains no secrets.
 * `ok` is false when the endpoint could not be resolved; the caller decides
 * whether that is fatal (it is, for a scrape) or merely reportable (health).
 */
export function loadAgentConfig(env = loadAgentEnv()) {
  const endpoint = endpointFromEnv(env);
  const bridge = bridgeFromEnv(env);
  const tuning = tuningFromEnv(env);
  const llm = llmFromEnv(env);
  return {
    ok: endpoint.ok === true,
    endpoint,
    bridge,
    tuning,
    llm,
    summary: {
      brightdata: endpoint.ok
        ? {
          configured: true,
          source: endpoint.source,
          zone: endpoint.zone,
          customer: endpoint.customer,
          geo: endpoint.geo || {},
          description: describeEndpoint(endpoint),
          redacted: redactEndpoint(endpoint.endpoint),
        }
        : { configured: false, source: endpoint.source, error: endpoint.error },
      bridge: { url: bridge.url, tokenRequired: Boolean(bridge.token) },
      llm: { provider: llm.provider, model: llm.model || '(provider default)', key: describeKey(llm.apiKey) },
    },
  };
}
