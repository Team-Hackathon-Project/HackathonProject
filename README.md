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
    extract-core.js        Headless extraction, for HTML fetched without a browser
    alerts.js              Alert rules: target, percent, level, advisory flip
    providers.js           Anthropic and Groq wire formats, and the active-provider resolver
web/                       The dashboard. Served two ways from one codebase:
  index.html               inside the extension (chrome-extension://<id>/web/index.html)
  dashboard.css            and as a plain static site (npm run web)
  js/bridge.js             Transport adapter: direct messaging, or externally_connectable
  js/state.js              Store, refresh loop, derived views
  js/render.js             Every DOM node — textContent only, never innerHTML
  js/alerts-ui.js          Alert feed, rule editor, toasts, monitoring control
  js/sparkline.js          Hand-rolled inline-SVG price series
  vendor/                  Byte-identical copies of shared files (npm run web:sync)
scripts/
  validate.mjs             Static bundle validation (npm run lint)
  make-icons.mjs           Dependency-free PNG icon generator
  package.mjs              Builds dist/<name>-<version>.zip (npm run package)
  web-sync.mjs             Mirrors shared files into web/vendor/ (npm run web:sync)
  serve-web.mjs            Zero-dependency static server for web/ (npm run web)
e2e/
  harness.mjs              Shared browser plumbing (staging, popup driver)
  quote-page.mjs           Live-site run: scan → advise → approve → log
  self-healing.mjs         Deterministic repair run against a mangled page
  provider-check.mjs       Confirms a provider answers from the service worker
  live-quote.mjs           Real key, live page: a genuine repair and advisory
  auto-targets.mjs         Target suggestion across repeated scans, offline
  dashboard.mjs            The dashboard on both routes, and the external boundary
docs/
  DEMO.md                  Three-minute demo script, with real screenshots
  env.mjs                  Reads the gitignored .env the runs take keys from
test/                      197 tests: node:test + jsdom
```

## The dashboard

The popup shows one ticker: whichever tab you just scanned. The dashboard shows
all of them at once, keeps them refreshed while you are not looking, and tells
you when one crosses a line you drew.

It is one codebase served two ways, and the only difference between them is how
a message reaches the service worker:

```bash
# 1. Inside the extension. No server, no setup, nothing to configure.
#    Options page -> "Open dashboard", or open this directly:
#    chrome-extension://<your-extension-id>/web/index.html

# 2. As a real website.
npm run web            # http://localhost:8080
```

The website route reaches the extension through `externally_connectable`, which
covers `localhost` and `127.0.0.1` on any port. It needs the extension's ID
once — the **Open dashboard** button on the options page fills that in for you,
and the page remembers it. Deploying it elsewhere means adding that origin to
`externally_connectable.matches` in `manifest.json` first; it cannot be
configured at runtime, by design.

Nothing is stored in the website. It is a view: the watchlist, the price
history, the API key and every scrape live in the extension, on your machine.
With the extension disabled, the page says so rather than showing a blank grid.

### Background refresh

A refresh re-reads a quote page you do not have open, by whichever route is
cheaper:

1. **Fetch the page and parse it.** Silent, fast, no tab appears. Works only on
   a server-rendered quote page.
2. **Open it in a background tab and run the real content script.** Slower and
   briefly visible in the tab strip, but it is a genuine render, so it works
   everywhere the popup does — including the self-healing repair path.

The first is tried first and the second catches what it cannot read, which is
most JavaScript-heavy finance sites. Both need you to have granted access to
that host; see the security notes below. A ticker you add by symbol alone
defaults to `stockanalysis.com`, which renders server-side and so usually works
by the fast path.

A refresh writes nothing it is unsure of. A page reporting a different ticker
than the one asked for, a price the host reports identically for two different
stocks, or a page with no readable price all end as a recorded failure on that
ticker's card rather than as a number in your history.

### Alerts

Four rule kinds, all evaluated locally:

| Rule | Fires when |
| --- | --- |
| **target** | the price reaches `target_buy_below` or `target_sell_above` — the targets already on your position, so anything set in the options page or proposed by the target suggester alerts with nothing further to configure |
| **percent** | it moves more than *n*%, measured from the previous reading, the oldest reading held, your average cost, or the last alert |
| **level** | it goes above or below a plain price you name |
| **advice_flip** | the recommendation itself changes (HOLD → BUY) |

Every rule fires on a **crossing**, not on a state: a price that stays above
your sell target is one event, not one every fifteen minutes. A per-rule
cooldown catches the rest. Nothing fires on a price that failed to parse — a
missing number is not a fall to zero.

An alert arrives on three channels at once, because the first can be silently
suppressed by the operating system: an OS notification, a count on the toolbar
icon, and a feed in the dashboard.

**Background monitoring is off until you switch it on.** When it is on, a
`chrome.alarms` tick refreshes the monitored tickers on your chosen interval and
evaluates the rules against what it read. `advice_flip` uses the free local
rules engine unless you opt into `alertsUseLlm` — a model call every fifteen
minutes per ticker is real money spent on a question that mostly answers "HOLD,
same as last time".

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

Watchlist entry (`chrome.storage.local` -> `watchlist[TICKER]`):

```json
{
  "ticker": "AAPL",
  "source_url": "https://stockanalysis.com/stocks/aapl/",
  "monitor": true,
  "added_at": "2026-08-19T20:55:00Z",
  "last_refreshed_at": "2026-08-22T09:15:00Z",
  "last_method": "fetch",
  "last_error": null,
  "needs_permission": null
}
```

Alert rule (`alert_rules[TICKER][]`) and the alert it raises (`alerts[]`):

```json
{
  "id": "AAPL-percent-m1k2j3",
  "ticker": "AAPL",
  "kind": "target | percent | level | advice_flip",
  "enabled": true,
  "threshold": 5,
  "direction": "up | down | both",
  "baseline": "previous_scan | session_open | avg_cost | last_alert",
  "cooldown_minutes": 60,
  "last_fired_at": null,
  "last_fired_price": null
}
```

```json
{
  "id": "AAPL-percent-m1k2j3-1755859200000",
  "rule_id": "AAPL-percent-m1k2j3",
  "ticker": "AAPL",
  "kind": "percent",
  "title": "AAPL moved +5.20%",
  "body": "Now 224.50, against 213.40 — the previous reading.",
  "direction": "up",
  "price": 224.50,
  "currency": "USD",
  "at": "2026-08-22T09:15:00Z",
  "seen": false
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

- **Permissions granted at install are exactly** `activeTab`, `storage`,
  `scripting`, `offscreen`, `alarms`, `notifications`, plus host permissions for
  `https://api.anthropic.com/*` and `https://api.groq.com/*` — the two model
  providers, and nothing else. There are no declared content scripts, so the
  extension has no standing access to any site.
- **Background refresh needs site access, and asks for it one host at a time.**
  Scanning the tab you are looking at still needs nothing: that is what clicking
  the toolbar icon grants. Re-reading a ticker you are *not* looking at is
  different — the page is not open, so the extension needs standing access to
  that one site. Those are `optional_host_permissions`: **nothing is granted at
  install**, each origin is requested separately from a real click, and you can
  revoke any of them from the options page or `chrome://extensions`. Until you
  grant one, background refresh for that ticker refuses and says so.
- **The dashboard's line in is narrow.** `externally_connectable` lists
  `http://localhost/*` and `http://127.0.0.1/*` only, and the worker answers
  such a page from an explicit allowlist (`EXTERNAL_ALLOWED` in
  `src/lib/constants.js`). `TEST_PROVIDER`, `SCRAPE_ACTIVE_TAB`, `GET_STATE` and
  `RESET_SELECTORS` are deliberately not on it, and the API key never crosses
  that boundary in either direction.
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
npm run check     # static validation + the full test suite (330 tests)
npm run web       # serve the dashboard at http://localhost:8080
npm run web:sync  # refresh web/vendor/ from src/ (the lint fails if it drifts)
npm run package   # dist/self-healing-market-scraper-<version>.zip
npm run e2e       # drive the real extension in a real browser, live site
                  #   EXT_SOURCE=dist/extension npm run e2e  tests the built copy
npm run e2e:heal  # drive the repair loop against a mangled page, offline
npm run e2e:provider   # does the configured key and model actually answer?
npm run e2e:live       # real repair + real advisory on a live page (spends tokens)
npm run e2e:dashboard  # the dashboard on both routes, offline, plus the external boundary
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

`npm run e2e:dashboard` drives the dashboard itself, offline, on both routes.
The last sweep, 23 checks, all passing:

| Checked | Result |
| --- | --- |
| `chrome-extension://<id>/web/index.html` | Watchlist, sparklines, target bands and P/L render from stored state, with no page errors |
| A six-point series vs a one-point one | The first charts; the second says how many more scans it needs, rather than drawing a trend out of one reading |
| The detail drawer | Headline, the selector that read the price, price history, decisions, and the rule editor |
| The alert feed | An unread alert is marked unread, marking it read clears the toolbar badge |
| Background monitoring | Off on arrival; switching it on schedules the `chrome.alarms` tick in the worker |
| `http://localhost:<port>/` with no extension | Says the extension is unreachable, and what to do about it — not a blank grid |
| `http://localhost:<port>/?ext=<id>` | The same watchlist over `externally_connectable`, and the ID remembered afterwards |
| A web page calling `TEST_PROVIDER` | Refused by name. So is `SCRAPE_ACTIVE_TAB` |
| What a web page *can* read | No `apiKey`, no `sk-ant`, no `gsk_` anywhere in it |
| A ticker added from the website | Actually lands in the extension's storage |

See [docs/DEMO.md](docs/DEMO.md) for the screenshots and the demo script.

Note that `activeTab` is granted only when *you* invoke the extension from the
toolbar, so a scan always starts from a real click — there is no way for the
extension to read a tab you have not handed it. Background refresh is the one
path that reads a page without a click, and it cannot touch a host until you
have granted that host explicitly.

## Known limits

Worth knowing before relying on any of this:

- **The fetch fast path cannot read a JavaScript-rendered quote page.** Yahoo
  Finance and Google Finance serve HTML with no price in it. Those fall through
  to the background-tab path, which is slower and flickers a tab into the strip.
- **`optional_host_permissions` widens what the extension *may* ask for.**
  Nothing is granted at install and every grant is per origin and revocable, but
  this is a broader ceiling than the two provider hosts the extension shipped
  with, and it is the one real trade the dashboard makes.
- **A deployed dashboard origin has to be added to the manifest by hand.**
  `externally_connectable` is fixed at build time; there is no runtime setting
  that can widen it, deliberately.
- **The website build cannot grant host permissions.** Chrome only honours
  `chrome.permissions.request()` from an extension page inside a real gesture, so
  the website links you to the in-extension dashboard for that one step.
- **OS notifications can be suppressed** by Focus Assist or Do Not Disturb
  without telling anyone. The toolbar badge and the in-page feed are the
  channels that always work.
- **Everything is local and capped**: 200 decisions, 60 price points per ticker,
  100 repair events, 200 alerts. Nothing syncs between devices.
- **`session_open` means "the oldest reading still held"**, not a real market
  open — the price history is capped, so it is as far back as the extension can
  see, which on a busy ticker may be under a day.

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
- The spec described "a separate dashboard website". It is one, and it is also a
  page inside the extension — the same files, served both ways. A website alone
  cannot cross-origin fetch a quote page or reach `chrome.storage`, so it would
  have needed the extension anyway; making the in-extension route the one that
  always works means the dashboard has no setup step and no way to be left
  half-connected.
- The spec's "Agent Service" is still not a separate service. The worker calls
  the provider APIs directly, and the dashboard talks to the worker. Adding a
  backend would mean a deploy target, an auth story, and moving the user's API
  key off their machine — for a dashboard whose data is already local.
- `permissions` gained `alarms` and `notifications`, and
  `optional_host_permissions` was added. Background monitoring is not possible
  without the first two, and reading a page you are not looking at is not
  possible without the third. See **Known limits**.
