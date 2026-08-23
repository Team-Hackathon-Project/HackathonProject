#!/usr/bin/env node
/**
 * The Bright Data scraper at a terminal (`npm run brightdata`).
 *
 *   npm run brightdata -- --check                 is the endpoint good?
 *   npm run brightdata -- AAPL                    scrape, healing as needed
 *   npm run brightdata -- AAPL --url https://…    a specific quote page
 *   npm run brightdata -- AAPL --json             machine-readable output
 *   npm run brightdata -- AAPL --no-heal          extract only, never repair
 *   npm run brightdata -- --registry              show the healed selectors
 *
 * Exit code 0 means a usable snapshot; 1 means it could not read one. Nothing
 * printed here contains the Bright Data password or the model key.
 */
import { loadAgentConfig, loadAgentEnv } from './config.mjs';
import { connectBrightData } from './brightdata.mjs';
import { scrapeThroughBrightData, defaultQuoteUrl, normalizeTicker } from './scrape.mjs';
import { getRegistry, getHealLog } from './registry.mjs';

export function parseArgs(argv) {
  const options = { ticker: null, url: null, json: false, check: false, heal: true, registry: false, quiet: false };
  const rest = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--check') options.check = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--quiet') options.quiet = true;
    else if (argument === '--registry') options.registry = true;
    else if (argument === '--no-heal') options.heal = false;
    else if (argument === '--url') options.url = argv[++index] || null;
    else if (argument === '--ticker') options.ticker = normalizeTicker(argv[++index]);
    else if (argument.startsWith('--url=')) options.url = argument.slice(6);
    else if (argument.startsWith('--ticker=')) options.ticker = normalizeTicker(argument.slice(9));
    else if (argument.startsWith('-')) throw new Error(`unknown option: ${argument}`);
    else rest.push(argument);
  }
  if (!options.ticker && rest.length) options.ticker = normalizeTicker(rest[0]);
  return options;
}

function printSummary(config) {
  const { brightdata, llm, bridge } = config.summary;
  console.log('Bright Data Scraping Browser');
  if (brightdata.configured) {
    console.log(`  endpoint   ${brightdata.redacted}`);
    console.log(`  zone       ${brightdata.zone}   (customer ${brightdata.customer}, from ${brightdata.source})`);
  } else {
    console.log(`  endpoint   NOT CONFIGURED`);
    console.log(`             ${brightdata.error}`);
  }
  console.log(`  self-heal  ${config.llm.apiKey ? `${llm.provider} · ${llm.model} · key ${llm.key}` : 'OFF — no model key in .env'}`);
  console.log(`  bridge     ${bridge.url}${bridge.tokenRequired ? ' (token required)' : ''}`);
}

function printResult(result) {
  const snapshot = result.snapshot || {};
  console.log('');
  console.log(`${result.ok ? '✔' : '✖'} ${result.ticker || '(no ticker)'} via Bright Data in ${result.duration_ms}ms`);
  console.log(`  url        ${result.url}`);
  if (result.captcha && result.captcha.attempted) {
    console.log(`  captcha    ${result.captcha.status || result.captcha.error || 'not detected'}`);
  }
  if (result.ok) {
    console.log(`  price      ${snapshot.current_price} ${snapshot.currency}`);
    console.log(`  change     ${snapshot.change_percentage ?? '—'}`);
    console.log(`  volume     ${snapshot.volume ?? '—'}`);
    if (snapshot.news && snapshot.news.length) console.log(`  headline   ${snapshot.news[0]}`);
    console.log(`  selectors  ${JSON.stringify(snapshot.selectors_used)}`);
  } else {
    console.log(`  error      ${result.error}`);
  }
  if (result.healed && result.healed.length) {
    console.log('  healed:');
    for (const entry of result.healed) console.log(`    ${entry.field} -> ${entry.strategy}: ${entry.selector}`);
  }
  for (const warning of result.warnings || []) console.log(`  warning    ${warning}`);
  for (const notice of result.notices || []) console.log(`  note       ${notice}`);
}

async function main(argv) {
  const options = parseArgs(argv);
  loadAgentEnv();
  const config = loadAgentConfig();

  if (options.registry) {
    const registry = getRegistry();
    if (options.json) {
      console.log(JSON.stringify({ registry, heal_log: getHealLog() }, null, 2));
      return 0;
    }
    const hosts = Object.keys(registry);
    if (!hosts.length) console.log('No healed selectors recorded yet.');
    for (const host of hosts) {
      console.log(host);
      for (const [field, entry] of Object.entries(registry[host])) {
        console.log(`  ${field.padEnd(18)} ${entry.strategy}: ${entry.selector}   (${entry.healed_at})`);
      }
    }
    return 0;
  }

  if (!options.json && !options.quiet) printSummary(config);

  if (!config.endpoint.ok) {
    if (options.json) console.log(JSON.stringify({ ok: false, error: config.endpoint.error }, null, 2));
    else console.error(`\n✖ ${config.endpoint.error}`);
    return 1;
  }

  if (options.check) {
    // A connect and an immediate close is the cheapest proof the credentials
    // work: it is a real session, so a wrong password fails here exactly as it
    // would mid-scrape, and it costs no page load.
    const browser = await connectBrightData({
      endpoint: config.endpoint.endpoint,
      connectTimeoutMs: config.tuning.connectTimeoutMs,
      log: options.json || options.quiet ? () => {} : (message) => console.log(`  ${message}`),
    });
    const version = await browser.version().catch(() => 'unknown');
    await browser.close();
    if (options.json) console.log(JSON.stringify({ ok: true, version, zone: config.endpoint.zone }, null, 2));
    else console.log(`\n✔ Bright Data accepted the credentials — remote browser reports ${version}`);
    return 0;
  }

  if (!options.ticker && !options.url) {
    console.error('\nUsage: npm run brightdata -- <TICKER> [--url <quote page>] [--json] [--no-heal]');
    console.error('       npm run brightdata -- --check');
    return 1;
  }

  const url = options.url || defaultQuoteUrl(options.ticker);
  const result = await scrapeThroughBrightData({
    url,
    ticker: options.ticker,
    config,
    selfHeal: options.heal,
    log: options.json || options.quiet ? () => {} : (message) => console.log(`  ${message}`),
  });

  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith('cli.mjs')) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`\n✖ ${String((error && error.message) || error)}`);
      process.exit(1);
    });
}
