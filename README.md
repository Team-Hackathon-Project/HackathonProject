# Self-Healing Market Scraper & Advisory Engine

A Chrome extension (Manifest V3) that reads the stock quote page you are already
looking at, repairs its own DOM selectors with an LLM when the site changes its
markup, and proposes **BUY / SELL / HOLD** with an explicit rationale.

It never places an order. Every recommendation ends at a confirmation modal
where you approve, reject, or override — and the decision is recorded locally.

## Install (unpacked)

```bash
npm install && npm run check
```

Then in Chrome or Edge: `chrome://extensions` (or `edge://extensions`) → enable
**Developer mode** → **Load unpacked** → select this folder.

`npm run package` also writes a clean copy with nothing but `manifest.json` and
`src/` in it:

```
dist/extension/                        point "Load unpacked" here
dist/self-healing-market-scraper-1.0.0.zip   send this to someone else
```

A zip cannot be installed directly — "Load unpacked" wants a folder, and a
`.crx` needs a signing key — so whoever receives the zip unpacks it first and
loads the folder inside. Open a quote page (Yahoo Finance, Google Finance,
MarketWatch, stockanalysis.com, or anything else), click the toolbar icon, and
press **Scan this tab**.

Optionally open the extension's options page and paste an API key. Two
providers ship: **Anthropic (Claude)** by default, and **Groq** for when an
Anthropic key is not available — Groq's free tier runs the whole loop. Pick one
in the dropdown, paste its key, and press **Test connection** to confirm it
before you rely on it. Keys are stored per provider, so switching does not
discard the other one.
Without a key everything still works: no self-healing, and advisories come from
the local rules engine.

## File tree

```
manifest.json              MV3 manifest — activeTab, storage, scripting, offscreen
src/
  background.js            Service worker: injection, healing loop, LLM calls, router
  content.js               Injected extractor (classic script — no ES imports)
  offscreen.html/.js       DOM parser for sanitizing scraped HTML off the active tab
  theme.css                Design tokens and shared primitives for both pages
  popup.html/.css/.js      Dashboard: quote card, advisory card, approve/reject/override
  options.html/.css/.js    API key, model, portfolio targets, healed-selector registry
  icons/                   Generated PNGs (scripts/make-icons.mjs)
  lib/
    constants.js           Message types, storage keys, defaults
    normalize.js           Price/percent/volume/ticker parsing → the scraping payload
    selectors.js           Shipped selector registry + candidate resolution order
    sanitize.js            HTML sanitizer used by the offscreen document
    advisor.js             Deterministic rules engine + advisory schema validation
    storage.js             Typed chrome.storage.local accessors
    llm.js                 Provider-agnostic client: structured output, retries, timeouts
    targets.js             Suggests buy/sell targets from your own scans and decisions
    verify.js              Cross-scan checks that catch a page-global price
    providers.js           Anthropic and Groq wire formats, and the active-provider resolver
scripts/
  validate.mjs             Static bundle validation (npm run lint)
  make-icons.mjs           Dependency-free PNG icon generator
  package.mjs              Builds dist/<name>-<version>.zip (npm run package)
e2e/
  harness.mjs              Shared browser plumbing (staging, popup driver)
  quote-page.mjs           Live-site run: scan → advise → approve → log
  self-healing.mjs         Deterministic repair run against a mangled page
  provider-check.mjs       Confirms a provider answers from the service worker
  live-quote.mjs           Real key, live page: a genuine repair and advisory
  auto-targets.mjs         Target suggestion across repeated scans, offline
docs/
  DEMO.md                  Three-minute demo script, with real screenshots
  env.mjs                  Reads the gitignored .env the runs take keys from
test/                      197 tests: node:test + jsdom
```

## How the self-healing loop works

1. `background.js` builds the ordered selector candidates for the tab's host:
   **healed selector → host defaults → related-host defaults → generic fallbacks.**
2. `content.js` runs them. Anything it cannot find is returned as a failure with
   the surrounding container HTML (scripts and styles already stripped).
3. The worker sends that container to the **offscreen document**, which parses it
   with `DOMParser` and strips ads, nav chrome, and volatile attributes while
   keeping every `data-*` / `aria-*` / `id` / `class` hook a selector could use.
4. The sanitized fragment goes to Claude with a `json_schema` structured output
   asking for a replacement CSS (or XPath) selector.
5. The proposal is checked twice before it is trusted: locally
   (`isPlausibleSelector` rejects `*`, `body`, HTML fragments, oversized strings)
   and then **in the live page** via `VALIDATE_SELECTOR`, which requires a single
   match that looks like a value rather than a container.
6. Only a selector that survives both is written to `chrome.storage.local` and
   used immediately — no page reload.

## Advisory & human-in-the-loop

`adviseOn()` sends the normalized snapshot plus your own position and targets to
Claude with the documented output schema, then re-validates the answer. If the
model is unavailable, refuses, or returns something off-schema, the popup falls
back to `heuristicAdvice()` — a deterministic rules engine over your targets —
and says so on the card.

`user_action_required` is forced to `true` on every path, and recorded decisions
always carry `executed: false`. The extension has no broker integration and no
code path that transmits an order.

## Data shapes

Scraping payload (`chrome.storage.local` → `snapshots[TICKER]`):

```json
{
  "ticker": "AAPL",
  "current_price": 224.50,
  "currency": "USD",
  "change_percentage": "+1.80%",
  "change_value": 1.8,
  "volume": 52300000,
  "news": ["Apple beats earnings expectations again"],
  "extracted_at": "2026-08-19T20:55:00Z",
  "source_url": "https://finance.example.com/quote/AAPL",
  "selectors_used": { "price_selector": "#quote-header-info span[data-reactid]" }
}
```

Advisory output:

```json
{
  "ticker": "AAPL",
  "action": "BUY | SELL | HOLD",
  "confidence_score": 0.85,
  "rationale": "Clear, concise paragraph explaining market context and technical drivers.",
  "user_action_required": true
}
```

## Security and privacy notes

- **Permissions are exactly** `activeTab`, `storage`, `scripting`, `offscreen`,
  plus host permissions for `https://api.anthropic.com/*` and
  `https://api.groq.com/*` — the two model providers, and nothing else. There are no
  declared content scripts, so the extension has no standing access to any site;
  it can only read a tab after you click the toolbar icon.
- **The API key lives in the service worker.** It is stored in
  `chrome.storage.local`, sent only to the selected provider's host, and is never exposed
  to the content script or included in the popup's state (`GET_STATE` returns
  `hasApiKey`, not the key).
- **Scraped text is never treated as markup.** The popup renders everything with
  `textContent`; there is no `innerHTML` assignment anywhere in the UI.
- **Only a sanitized fragment leaves the browser** during a repair — the failing
  container, capped at a configurable character budget (12,000 by default), with
  scripts, styles, forms, and ad blocks removed.

## Commands

```bash
npm run check     # static validation + the full test suite (197 tests)
npm run package   # dist/self-healing-market-scraper-<version>.zip
npm run e2e       # drive the real extension in a real browser, live site
                  #   EXT_SOURCE=dist/extension npm run e2e  tests the built copy
npm run e2e:heal  # drive the repair loop against a mangled page, offline
npm run e2e:provider   # does the configured key and model actually answer?
npm run e2e:live       # real repair + real advisory on a live page (spends tokens)
```

### Credentials for the e2e runs

The browser runs read their key from a gitignored `.env`, so it never lands in a
shell history and nothing prints it back:

```bash
cp .env.example .env
# paste your key into GROQ_API_KEY (or ANTHROPIC_API_KEY), then:
npm run e2e:provider   # confirms the key works, and says which model answered
npm run e2e:live       # one real scan: repair a stale selector, write an advisory
```

`.env` feeds the test tooling only — the extension itself takes its key from the
options page. `npm run package` never includes it. With no key configured,
`npm run e2e:provider` still runs as a transport-only check, and everything else
falls back to the local rules engine.

`npm run lint` alone runs `scripts/validate.mjs`, which catches the failures
Chrome only reports at load time: manifest shape, permission drift, missing
files, unresolvable module imports, and ES syntax sneaking into `content.js`.

`npm run package` writes a zip containing exactly `manifest.json` and `src/` —
no tests, no scripts, no repo metadata — for upload or for handing to someone
who just wants to unzip and **Load unpacked**. It is written with `node:zlib`,
so packaging adds no dependency either.

`npm run e2e` takes an optional URL (`npm run e2e -- https://…`) and writes
screenshots to `e2e/shots/`. Both e2e scripts run from a throwaway copy of the
extension with `host_permissions` widened for the site under test: `activeTab`
is only granted by a human clicking the toolbar icon, and no automation protocol
can produce that click. The shipped manifest keeps its narrow permission set.

Chrome 137 and later ignore `--load-extension`, so an up-to-date Chrome starts
cleanly with no extension in it. The harness detects that — it waits for the
service worker and moves on to the next installed browser (Edge, Chromium) if it
never appears — and prints which browser it settled on. `BROWSER_PATH=…` pins
one explicitly, in which case no fallback is attempted. None of this affects the
extension itself: Chrome installs it normally through **Load unpacked**.

## Suggested targets

Targets are what turn a quote into a signal — without them every answer is a
low-confidence HOLD — and typing two numbers per ticker is the step people skip.
So the options page offers to work them out, from your own data only:

| Anchor, first available | Meaning |
| --- | --- |
| The average of the prices you have scanned for that ticker | what it has traded at while you were watching |
| The average price of your approved BUY decisions | what you have actually paid |
| Your average cost | your book cost |
| Today's price | all there is on a first scan |

The band either side comes from how much those scans actually moved (their
standard deviation, clamped to 3–20%), or a flat 5% when there is not enough
history. Then `buy_below = anchor × (1 − band)` and
`sell_above = anchor × (1 + band)`.

That is arithmetic on your own data. It does not ask a model what a stock is
worth, and it never presents a forecast as a fact.

**Suggest targets** fills the two boxes and tells you what it anchored on — you
still press Save. Tick **Keep them updated automatically** and every later scan
of that ticker refreshes them, and the popup says so each time it happens.
Positions left manual are never rewritten.

![Suggested targets in the options page](docs/demo/08-targets.png)

Each usable scan appends one point to `price_history` (60 per ticker, oldest
dropped), which is what the averaging reads.

## Choosing a provider

The reasoning work — repair a selector, write an advisory — is the same request
in both cases: a system prompt, one user message, and a JSON schema the answer
must satisfy. Only the wire format differs, so each provider in
[`src/lib/providers.js`](src/lib/providers.js) owns exactly four things: its auth
headers, its request body, how to pull the JSON back out, and where its error
message lives.

| | Anthropic | Groq |
| --- | --- | --- |
| Endpoint | `/v1/messages` | `/openai/v1/chat/completions` |
| Auth | `x-api-key` | `Authorization: Bearer` |
| Schema enforcement | `output_config.format` | `response_format.json_schema` |
| Model list in options | fixed | **Load models from provider** reads the live catalogue |
| Default model | `claude-opus-5` | `openai/gpt-oss-120b` |

Not every model behind an OpenAI-compatible endpoint supports strict
`json_schema`. When one rejects it, the client retries the same request once
with the schema moved into the prompt, so a model that only does `json_object`
still works. Answers wrapped in a code fence or a sentence of prose are parsed
too, because smaller models do that.

Both endpoints have been confirmed reachable from the MV3 service worker
(`npm run e2e:provider`), and the full repair loop has been driven end to end in
both wire formats (`npm run e2e:heal`, `npm run e2e:heal -- groq`).

It has also been run for real: with a Groq key on `openai/gpt-oss-120b`, a scan
of stockanalysis.com repaired the stale `change_percentage` hook to
`div.mb-5 > div:first-child > div:nth-child(2)`, validated it against the live
DOM, persisted it, and produced a model-written advisory. Put your key in `.env`
and `npm run e2e:live` does the same.

Two things that run taught us, both now fixed: a model answering "that metric is
not in this fragment" was being reported as `unusable selector: ` with nothing
after the colon, hiding the one useful sentence it had written; and a rejected
selector was never sent back, so a first answer that named the right element in
invalid CSS (a Tailwind class needing escaping) simply lost. The repair loop now
retries once with the rejection quoted back to it.

## What has been verified in a real browser

The `e2e/` scripts load the extension into a real Chromium browser and drive the
real action popup — service worker, injected content script, offscreen parser
and all. Results from the last sweep:

| Page | Result |
| --- | --- |
| `finance.yahoo.com/quote/AAPL` | All five fields from the shipped defaults; no healing needed |
| `stockanalysis.com/stocks/aapl` | Ticker, price, volume and news; `change_percentage` healed live by the model |
| `marketwatch.com/investing/stock/aapl` | Ticker, price, change and news; the page carries no volume figure |
| `google.com/finance/quote/AAPL:NASDAQ` | Ticker (from the URL) and volume; Finance Beta rewrote the page, so price needs healing |
| Local page with mangled markup | Healing repairs `price`; wrong-field proposals are refused |
| The packaged zip, extracted | Scan → advise → approve → log, all working |

Two notes on reading that table. Live sites rate-limit and A/B test — MarketWatch
served an anti-bot interstitial on a later run, and the extension correctly
reported every field missing rather than inventing one. And Google Finance is
the honest case for this whole project: their markup moved, no stable hook
survived, and rather than ship a selector that returns an index level instead of
the instrument, that field is left to the repair loop.

See [docs/DEMO.md](docs/DEMO.md) for the screenshots and the demo script.

Note that `activeTab` is granted only when *you* invoke the extension from the
toolbar, so a scan always starts from a real click — there is no way for the
extension to read a tab you have not handed it.

## Deviations from the original spec

- The popup is `popup.js`, not `popup.jsx`. The extension ships with **no build
  step and no runtime dependencies** — you load the folder directly. Adding JSX
  would mean adding a bundler between the source and what Chrome runs.
- `host_permissions` includes `https://api.groq.com/*` alongside
  `https://api.anthropic.com/*`. The spec named Claude, and Claude is still the
  default; Groq is there so the project can be run and demonstrated by someone
  who cannot get an Anthropic key. The prompts, schemas, validation and refusal
  logic are identical either way — only the wire format differs.
- `host_permissions` includes `https://api.anthropic.com/*`, which the original
  permission list did not mention. Calling the API from the service worker
  requires it.
