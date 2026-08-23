/**
 * The Bright Data Scraper Studio client.
 *
 * Every test here stubs `fetch`: the point is the contract with their API —
 * the two endpoints, the bearer token, which failures are worth retrying, how
 * "still building" is told apart from "done", and how a collector row becomes
 * the snapshot shape the rest of the project already speaks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  studioFromEnv, describeToken, triggerCollector, fetchDataset, runCollector,
  snapshotFromRow, inputsForTickers, scrapeThroughStudio, StudioError,
  readDataset, parseBody, STUDIO_API,
} from '../agent/studio.mjs';
import { createBridge } from '../agent/server.mjs';

const TOKEN = 'brd_token_abcdef';
const COLLECTOR = 'c_123456';

/** A fetch stub that answers from a queue and records what it was asked. */
function stub(responses) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const { status = 200, json = null, text = null } = typeof next === 'function' ? next(url, init) : next;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      async text() {
        return text === null ? JSON.stringify(json) : text;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

const fast = { pollIntervalMs: 1, retries: 1, requestTimeoutMs: 500 };

/* ---------------------------------------------------------------- *
 * Credentials
 * ---------------------------------------------------------------- */

test('studioFromEnv accepts both spellings and reports what is missing', () => {
  assert.deepEqual(studioFromEnv({}), {
    ok: false, configured: false, error: 'no Scraper Studio credentials in .env', apiToken: '', collectorId: '',
  });

  const bright = studioFromEnv({ BRIGHT_DATA_API_TOKEN: ' t ', BRIGHT_DATA_COLLECTOR_ID: ' c ' });
  assert.equal(bright.ok, true);
  assert.equal(bright.apiToken, 't', 'whitespace from a paste is trimmed');
  assert.equal(bright.collectorId, 'c');

  // The project's own BRIGHTDATA_ prefix works too, so a key put in the
  // "wrong" one of the two spellings is not silently ignored.
  const alt = studioFromEnv({ BRIGHTDATA_API_TOKEN: 't', BRIGHTDATA_COLLECTOR_ID: 'c' });
  assert.equal(alt.ok, true);

  assert.match(studioFromEnv({ BRIGHT_DATA_COLLECTOR_ID: 'c' }).error, /API_TOKEN is missing/);
  assert.match(studioFromEnv({ BRIGHT_DATA_API_TOKEN: 't' }).error, /COLLECTOR_ID is missing/);
});

test('describeToken never reveals the token', () => {
  assert.equal(describeToken(''), 'none');
  const described = describeToken('brd_supersecret_value');
  assert.equal(described.includes('supersecret'), false);
  assert.match(described, /^brd_…\d+ chars$/);
});

/* ---------------------------------------------------------------- *
 * Trigger
 * ---------------------------------------------------------------- */

test('trigger posts the inputs to the collector with a bearer token', async () => {
  const fetchImpl = stub({ json: { collection_id: 'snap_1' } });
  const id = await triggerCollector({
    collectorId: COLLECTOR, apiToken: TOKEN, inputs: [{ url: 'https://example.com/a' }], options: fast, fetchImpl,
  });

  assert.equal(id, 'snap_1');
  const { url, init, body } = fetchImpl.calls[0];
  assert.equal(url, `${STUDIO_API}/dca/trigger?collector=${COLLECTOR}&queue_next=1`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers['content-type'], 'application/json');
  assert.deepEqual(body, [{ url: 'https://example.com/a' }]);
});

test('trigger accepts the other names Bright Data uses for the snapshot id', async () => {
  for (const key of ['collection_id', 'snapshot_id', 'id']) {
    const fetchImpl = stub({ json: { [key]: 'snap_x' } });
    const id = await triggerCollector({ collectorId: COLLECTOR, apiToken: TOKEN, inputs: [{ url: 'u' }], options: fast, fetchImpl });
    assert.equal(id, 'snap_x', key);
  }
});

test('trigger refuses an empty job and an id-less answer', async () => {
  await assert.rejects(
    () => triggerCollector({ collectorId: COLLECTOR, apiToken: TOKEN, inputs: [], fetchImpl: stub({ json: {} }) }),
    /No inputs/
  );
  await assert.rejects(
    () => triggerCollector({ collectorId: COLLECTOR, apiToken: TOKEN, inputs: [{ url: 'u' }], options: fast, fetchImpl: stub({ json: { queued: true } }) }),
    /no collection id/
  );
});

/* ---------------------------------------------------------------- *
 * Failure handling
 * ---------------------------------------------------------------- */

test('a 4xx fails immediately — a wrong token will not fix itself', async () => {
  const fetchImpl = stub({ status: 401, json: { error: 'Unauthorized' } });
  await assert.rejects(
    () => triggerCollector({ collectorId: COLLECTOR, apiToken: 'wrong', inputs: [{ url: 'u' }], options: fast, fetchImpl }),
    (error) => error instanceof StudioError && error.status === 401 && /Unauthorized/.test(error.message)
  );
  assert.equal(fetchImpl.calls.length, 1, 'no retries on a client error');
});

test('a 5xx is retried, then reported', async () => {
  const flaky = stub([{ status: 502, text: 'bad gateway' }, { json: { collection_id: 'snap_2' } }]);
  const id = await triggerCollector({ collectorId: COLLECTOR, apiToken: TOKEN, inputs: [{ url: 'u' }], options: fast, fetchImpl: flaky });
  assert.equal(id, 'snap_2');
  assert.equal(flaky.calls.length, 2, 'one retry was enough');

  const dead = stub({ status: 500, text: 'nope' });
  await assert.rejects(
    () => triggerCollector({ collectorId: COLLECTOR, apiToken: TOKEN, inputs: [{ url: 'u' }], options: fast, fetchImpl: dead }),
    (error) => error.status === 500 && error.retryable === true
  );
  assert.equal(dead.calls.length, 2, 'retries are bounded');
});

test('a network failure is retried the same way', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new Error('socket hang up');
    return { ok: true, status: 200, statusText: '200', async text() { return JSON.stringify({ collection_id: 'snap_3' }); } };
  };
  const id = await triggerCollector({ collectorId: COLLECTOR, apiToken: TOKEN, inputs: [{ url: 'u' }], options: fast, fetchImpl });
  assert.equal(id, 'snap_3');
  assert.equal(calls, 2);
});

/* ---------------------------------------------------------------- *
 * Polling
 * ---------------------------------------------------------------- */

test('a status object means still building; an array means done', async () => {
  const building = await fetchDataset({ collectionId: 's', apiToken: TOKEN, options: fast, fetchImpl: stub({ json: { status: 'running' } }) });
  assert.deepEqual(building, { ready: false, rows: [], status: 'running' });

  const empty = await fetchDataset({ collectionId: 's', apiToken: TOKEN, options: fast, fetchImpl: stub({ json: [] }) });
  assert.equal(empty.ready, false, 'an empty array is not a finished job');

  const done = await fetchDataset({ collectionId: 's', apiToken: TOKEN, options: fast, fetchImpl: stub({ json: [{ ticker: 'AAPL' }] }) });
  assert.equal(done.ready, true);
  assert.equal(done.rows.length, 1);
});

test('a collector that produced one row answers with a bare object, not an array', () => {
  // What a real run returns. "Not an array means still building" polls a job
  // that finished in seconds until the loop gives up — this is that bug, pinned.
  const row = { ticker: 'AAPL', current_price: 309.35, currency: 'USD', change_percentage: '-0.63%' };
  const result = readDataset(row);
  assert.equal(result.ready, true);
  assert.deepEqual(result.rows, [row]);
});

test('readDataset treats a body as progress only when it says so', () => {
  for (const status of ['building', 'running', 'pending', 'collecting', 'queued', 'IN_PROGRESS']) {
    assert.equal(readDataset({ status }).ready, false, status);
  }
  assert.equal(readDataset({ state: 'running' }).ready, false);
  assert.equal(readDataset({}).ready, false, 'nothing yet');
  assert.equal(readDataset([]).ready, false, 'an empty dataset is not a result');
  assert.equal(readDataset(null).ready, false);

  const failed = readDataset({ error: 'collector crashed' });
  assert.equal(failed.ready, false);
  assert.match(failed.status, /collector crashed/);

  // A row that happens to carry a status field is still a row.
  const row = readDataset({ ticker: 'AAPL', current_price: 1, status: 'ok' });
  assert.equal(row.ready, true);
  assert.equal(row.rows.length, 1);
});

test('parseBody reads JSON and NDJSON, and gives up on neither-of-those', () => {
  assert.deepEqual(parseBody('{"a":1}'), { a: 1 });
  assert.deepEqual(parseBody('[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(parseBody(['{"a":1}', '{"a":2}'].join(String.fromCharCode(10))), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(parseBody(['{"a":1}', '', '{"a":2}', ''].join(String.fromCharCode(10))), [{ a: 1 }, { a: 2 }]);
  assert.equal(parseBody(''), null);
  assert.equal(parseBody('   '), null);
  assert.equal(parseBody('<html>gateway</html>'), null);
});

test('a single-row job is collected without waiting out the poll loop', async () => {
  const fetchImpl = stub([
    { json: { collection_id: 'snap_single' } },
    { json: { ticker: 'AAPL', current_price: 309.35 } },
  ]);
  const run = await runCollector({
    collectorId: COLLECTOR, apiToken: TOKEN, inputs: [{ url: 'u' }], options: fast, fetchImpl,
  });
  assert.equal(run.attempts, 1, 'the first poll already had the answer');
  assert.equal(run.rows.length, 1);
});

test('runCollector waits through the building phase and reports progress', async () => {
  const fetchImpl = stub([
    { json: { collection_id: 'snap_4' } },
    { json: { status: 'building' } },
    { json: { status: 'building' } },
    { json: [{ ticker: 'AAPL', price: 224.5 }] },
  ]);
  const phases = [];
  const run = await runCollector({
    collectorId: COLLECTOR, apiToken: TOKEN, inputs: [{ url: 'u' }],
    options: fast, fetchImpl, onProgress: (event) => phases.push(event.phase),
  });

  assert.equal(run.ok, true);
  assert.equal(run.collectionId, 'snap_4');
  assert.equal(run.rows.length, 1);
  assert.equal(run.attempts, 3);
  assert.deepEqual(phases, ['triggered', 'waiting', 'waiting', 'ready']);
  assert.equal(fetchImpl.calls[1].url, `${STUDIO_API}/dca/dataset?id=snap_4`);
});

test('a job that never finishes times out with the snapshot id in the message', async () => {
  const fetchImpl = stub([{ json: { collection_id: 'snap_5' } }, { json: { status: 'building' } }]);
  await assert.rejects(
    () => runCollector({
      collectorId: COLLECTOR, apiToken: TOKEN, inputs: [{ url: 'u' }],
      options: { ...fast, maxAttempts: 3 }, fetchImpl,
    }),
    (error) => /did not finish/.test(error.message) && /snap_5/.test(error.message)
  );
});

/* ---------------------------------------------------------------- *
 * Mapping the collector's rows onto our snapshot
 * ---------------------------------------------------------------- */

test('a collector row becomes a snapshot, whatever the schema called the fields', () => {
  const snapshot = snapshotFromRow({
    symbol: 'aapl',
    price: '$224.50',
    percent_change: '+1.80%',
    change_amount: '3.95',
    volume: '52,300,000',
    headlines: ['Apple beats expectations', 42, 'Analysts raise targets'],
    url: 'https://example.com/quote/AAPL',
  });

  assert.equal(snapshot.ticker, 'AAPL');
  assert.equal(snapshot.current_price, 224.5);
  assert.equal(snapshot.change_percentage, '+1.80%');
  assert.equal(snapshot.change_value, 3.95);
  assert.equal(snapshot.volume, 52300000);
  assert.deepEqual(snapshot.news, ['Apple beats expectations', 'Analysts raise targets'], 'non-strings are dropped');
  assert.equal(snapshot.source_url, 'https://example.com/quote/AAPL');
  assert.equal(snapshot.method, 'scraper-studio');
});

test('a row with numbers already typed is left alone', () => {
  const snapshot = snapshotFromRow({ ticker: 'MSFT', current_price: 480.61, volume: 5218451, currency: 'USD' });
  assert.equal(snapshot.current_price, 480.61);
  assert.equal(snapshot.volume, 5218451);
});

test('a row with nothing usable does not become a half-filled snapshot', () => {
  assert.equal(snapshotFromRow(null), null);
  assert.equal(snapshotFromRow('nope'), null);
  const empty = snapshotFromRow({ foo: 'bar' }, { fallbackTicker: 'AAPL' });
  assert.equal(empty.ticker, 'AAPL', 'the input we asked for is a better guess than nothing');
  assert.equal(empty.current_price, null);
  assert.equal(empty.volume, null);
});

test('inputs are built from tickers, with the quote URL alongside', () => {
  assert.deepEqual(inputsForTickers([' aapl ', '', null, 'msft']), [
    { ticker: 'AAPL', url: 'https://stockanalysis.com/stocks/aapl/' },
    { ticker: 'MSFT', url: 'https://stockanalysis.com/stocks/msft/' },
  ]);
});

/* ---------------------------------------------------------------- *
 * End to end, against the stub
 * ---------------------------------------------------------------- */

test('scrapeThroughStudio returns snapshots and keeps the unusable rows visible', async () => {
  const fetchImpl = stub([
    { json: { collection_id: 'snap_6' } },
    { json: [
      { ticker: 'AAPL', price: 224.5 },
      { ticker: 'MSFT', price: 'n/a' },
    ] },
  ]);

  const result = await scrapeThroughStudio({
    tickers: ['AAPL', 'MSFT'],
    config: { studio: { ok: true, apiToken: TOKEN, collectorId: COLLECTOR } },
    options: fast,
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'scraper-studio');
  assert.equal(result.collection_id, 'snap_6');
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.snapshots[0].ticker, 'AAPL');
  assert.equal(result.unusable.length, 1, 'a row with no price is reported, not dropped');
  assert.equal(result.unusable[0].row.ticker, 'MSFT');

  assert.deepEqual(fetchImpl.calls[0].body, [
    { ticker: 'AAPL', url: 'https://stockanalysis.com/stocks/aapl/' },
    { ticker: 'MSFT', url: 'https://stockanalysis.com/stocks/msft/' },
  ]);
});

test('scrapeThroughStudio refuses to run unconfigured, or with nothing to collect', async () => {
  await assert.rejects(
    () => scrapeThroughStudio({ tickers: ['AAPL'], config: { studio: { ok: false, error: 'BRIGHT_DATA_API_TOKEN is missing' } } }),
    /BRIGHT_DATA_API_TOKEN is missing/
  );
  await assert.rejects(
    () => scrapeThroughStudio({ config: { studio: { ok: true, apiToken: TOKEN, collectorId: COLLECTOR } } }),
    /Nothing to collect/
  );
});

test('explicit URLs are sent as-is, without a ticker being invented', async () => {
  const fetchImpl = stub([{ json: { collection_id: 's' } }, { json: [{ ticker: 'AAPL', price: 1 }] }]);
  await scrapeThroughStudio({
    urls: ['https://example.com/x'],
    config: { studio: { ok: true, apiToken: TOKEN, collectorId: COLLECTOR } },
    options: fast,
    fetchImpl,
  });
  assert.deepEqual(fetchImpl.calls[0].body, [{ url: 'https://example.com/x' }]);
});

/* ---------------------------------------------------------------- *
 * The bridge route the extension calls
 * ---------------------------------------------------------------- */

/** Starts the bridge on an ephemeral port and returns its base URL. */
async function withBridge(config, run) {
  const server = createBridge(config);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const bridgeConfig = (overrides = {}) => ({
  ok: true,
  bridge: { host: '127.0.0.1', port: 0, token: '' },
  llm: { apiKey: '' },
  studio: { ok: true, apiToken: TOKEN, collectorId: COLLECTOR },
  summary: { brightdata: { configured: false }, llm: {}, studio: { configured: true, collector: COLLECTOR } },
  ...overrides,
});

test('POST /studio runs the collector and answers with snapshots', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub([
    { json: { collection_id: 'snap_bridge' } },
    { json: [{ ticker: 'AAPL', price: 224.5, percent_change: '+1.80%' }] },
  ]);
  try {
    const body = await withBridge(bridgeConfig(), async (base) => {
      const response = await realFetch(`${base}/studio`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tickers: ['AAPL'] }),
      });
      assert.equal(response.status, 200);
      return response.json();
    });

    assert.equal(body.ok, true);
    assert.equal(body.method, 'scraper-studio');
    assert.equal(body.collection_id, 'snap_bridge');
    assert.equal(body.snapshots.length, 1);
    assert.equal(body.snapshots[0].ticker, 'AAPL');
    assert.equal(body.snapshots[0].current_price, 224.5);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('POST /studio reports a misconfiguration as an answer, not a crash', async () => {
  const realFetch = globalThis.fetch;
  try {
    const body = await withBridge(
      bridgeConfig({ studio: { ok: false, error: 'BRIGHT_DATA_COLLECTOR_ID is missing' } }),
      async (base) => {
        const response = await realFetch(`${base}/studio`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tickers: ['AAPL'] }),
        });
        assert.equal(response.status, 200, 'the bridge answers rather than throwing');
        return response.json();
      }
    );
    assert.equal(body.ok, false);
    assert.match(body.error, /COLLECTOR_ID is missing/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('GET /health says whether Scraper Studio is configured, without the token', async () => {
  const realFetch = globalThis.fetch;
  try {
    const body = await withBridge(bridgeConfig(), async (base) => (await realFetch(`${base}/health`)).json());
    assert.deepEqual(body.studio, { configured: true, collector: COLLECTOR });
    assert.equal(JSON.stringify(body).includes(TOKEN), false, 'no credential may appear in /health');
  } finally {
    globalThis.fetch = realFetch;
  }
});
