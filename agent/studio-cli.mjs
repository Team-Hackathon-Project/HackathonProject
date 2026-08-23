/**
 * Runs the published Scraper Studio collector from the terminal.
 *
 *   npm run studio -- AAPL MSFT
 *   npm run studio -- https://stockanalysis.com/stocks/aapl/
 *   npm run studio:check                  (credentials only, no job queued)
 *
 * Credentials come from the gitignored `.env`:
 *   BRIGHT_DATA_API_TOKEN       Bright Data -> account settings -> API tokens
 *   BRIGHT_DATA_COLLECTOR_ID    the id in the Scraper Studio URL for your collector
 *
 * A job costs page loads on your Bright Data plan, so the check mode exists to
 * confirm the wiring without spending any.
 */
import { loadAgentEnv } from './config.mjs';
import { studioFromEnv, describeToken, scrapeThroughStudio, StudioError } from './studio.mjs';

const args = process.argv.slice(2).filter(Boolean);
const checkOnly = args.includes('--check');
const targets = args.filter((value) => value !== '--check');

const log = (...parts) => console.log('[studio]', ...parts);

loadAgentEnv();
const studio = studioFromEnv();

log(`collector: ${studio.collectorId || '(not set)'} · token: ${describeToken(studio.apiToken)}`);

if (!studio.ok) {
  console.error([
    '',
    `Scraper Studio is not configured: ${studio.error}`,
    '',
    '  1. Bright Data -> Scraper Studio -> open (or create) your collector',
    '  2. Copy the collector id out of the page URL',
    '  3. Bright Data -> account settings -> API tokens -> create one',
    '  4. Put both in .env:',
    '',
    '       BRIGHT_DATA_API_TOKEN=...',
    '       BRIGHT_DATA_COLLECTOR_ID=...',
    '',
    '  docs/SCRAPER-STUDIO.md walks through it, including what to ask the AI',
    '  Agent for so the collector returns the fields this project expects.',
    '',
  ].join('\n'));
  process.exit(1);
}

if (checkOnly) {
  log('credentials present — run without --check to queue a real job.');
  process.exit(0);
}

if (!targets.length) {
  console.error('Nothing to collect. Pass one or more tickers, or a URL.\n  npm run studio -- AAPL');
  process.exit(1);
}

const urls = targets.filter((value) => /^https?:\/\//i.test(value));
const tickers = targets.filter((value) => !/^https?:\/\//i.test(value));

try {
  const result = await scrapeThroughStudio({
    tickers,
    urls,
    onProgress: (event) => {
      if (event.phase === 'triggered') log(`queued — snapshot ${event.collectionId}`);
      else if (event.phase === 'waiting') log(`waiting (${event.status}) — attempt ${event.attempt}`);
      else if (event.phase === 'ready') log(`dataset ready — ${event.rows} row(s) after ${event.attempt} poll(s)`);
    },
  });

  log(`${result.snapshots.length} usable snapshot(s) in ${result.duration_ms}ms`);
  for (const snapshot of result.snapshots) {
    const change = snapshot.change_percentage ? ` (${snapshot.change_percentage})` : '';
    log(`  ${snapshot.ticker}  ${snapshot.currency} ${snapshot.current_price}${change}`);
  }
  if (result.unusable.length) {
    log(`${result.unusable.length} row(s) had no usable ticker or price:`);
    for (const item of result.unusable.slice(0, 3)) {
      log(`  row ${item.index}: ${JSON.stringify(item.row).slice(0, 160)}`);
    }
    log('If every row looks like this, the collector\'s output schema does not match');
    log('what this project expects — see docs/SCRAPER-STUDIO.md.');
  }
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  const message = String((error && error.message) || error);
  console.error(`[studio] failed: ${message}`);
  if (error instanceof StudioError && error.status === 401) {
    console.error('        A 401 is the API token. Check BRIGHT_DATA_API_TOKEN in .env.');
  }
  if (error instanceof StudioError && error.status === 404) {
    console.error('        A 404 is the collector id. Check BRIGHT_DATA_COLLECTOR_ID in .env.');
  }
  process.exitCode = 1;
}
