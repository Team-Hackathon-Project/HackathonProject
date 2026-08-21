/**
 * A three-line .env reader, so credentials for the end-to-end runs live in one
 * gitignored file instead of a shell history.
 *
 * Dependency-free on purpose: the extension itself ships nothing, and the test
 * tooling should not drag in a package to split strings on "=".
 *
 * Nothing here ever prints a value — `describeKey` exists so a run can say a
 * key was found without saying what it is.
 */
import { readFileSync, existsSync } from 'node:fs';

/**
 * Parses .env text into a plain object.
 * Supports `#` comments, blank lines, `export ` prefixes, and single or double
 * quoted values. Everything after the first `=` is the value.
 */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    const quoted = (value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1);
    if (quoted) value = value.slice(1, -1);
    else value = value.split(' #')[0].trim(); // strip a trailing comment
    out[key] = value;
  }
  return out;
}

/**
 * Loads `.env` into `process.env` without clobbering anything already set —
 * a variable passed on the command line always wins over the file.
 */
export function loadEnv(file, env = process.env) {
  if (!existsSync(file)) return {};
  const values = parseEnv(readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined || env[key] === '') env[key] = value;
  }
  return values;
}

/**
 * Works out which provider the run should use.
 *
 * `LLM_PROVIDER` decides when it is set; otherwise whichever key is present
 * wins, with Groq first because that is the one you are likely to have.
 * Returns `apiKey: ''` when nothing is configured — callers treat that as
 * "run in offline mode" rather than an error.
 */
export function credentialsFromEnv(env = process.env) {
  const keys = {
    groq: { apiKey: (env.GROQ_API_KEY || '').trim(), model: (env.GROQ_MODEL || '').trim() },
    anthropic: { apiKey: (env.ANTHROPIC_API_KEY || '').trim(), model: (env.ANTHROPIC_MODEL || '').trim() },
  };
  const requested = (env.LLM_PROVIDER || '').trim().toLowerCase();
  const provider = keys[requested]
    ? requested
    : (keys.groq.apiKey && 'groq') || (keys.anthropic.apiKey && 'anthropic') || 'groq';
  return { provider, ...keys[provider], all: keys };
}

/** A safe thing to log: proves a key was read without revealing it. */
export function describeKey(apiKey) {
  if (!apiKey) return 'none';
  return `${apiKey.slice(0, 4)}…${apiKey.length} chars`;
}
