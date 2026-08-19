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

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked**
→ select this folder. Open a quote page (Yahoo Finance, Google Finance,
MarketWatch, stockanalysis.com, or anything else), click the toolbar icon, and
press **Scan this tab**.

Optionally open the extension's options page and paste an Anthropic API key.
Without a key everything still works: no self-healing, and advisories come from
the local rules engine.

## File tree

```
manifest.json              MV3 manifest — activeTab, storage, scripting, offscreen
src/
  background.js            Service worker: injection, healing loop, LLM calls, router
  content.js               Injected extractor (classic script — no ES imports)
  offscreen.html/.js       DOM parser for sanitizing scraped HTML off the active tab
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
    llm.js                 Anthropic Messages API client (raw fetch, structured outputs)
scripts/
  validate.mjs             Static bundle validation (npm run lint)
  make-icons.mjs           Dependency-free PNG icon generator
test/                      122 tests: node:test + jsdom
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
  plus one host permission for `https://api.anthropic.com/*`. There are no
  declared content scripts, so the extension has no standing access to any site;
  it can only read a tab after you click the toolbar icon.
- **The API key lives in the service worker.** It is stored in
  `chrome.storage.local`, sent only to `api.anthropic.com`, and is never exposed
  to the content script or included in the popup's state (`GET_STATE` returns
  `hasApiKey`, not the key).
- **Scraped text is never treated as markup.** The popup renders everything with
  `textContent`; there is no `innerHTML` assignment anywhere in the UI.
- **Only a sanitized fragment leaves the browser** during a repair — the failing
  container, capped at a configurable character budget (12,000 by default), with
  scripts, styles, forms, and ad blocks removed.

## Commands

```bash
npm run check   # static validation + the full test suite
```

`npm run lint` alone runs `scripts/validate.mjs`, which catches the failures
Chrome only reports at load time: manifest shape, permission drift, missing
files, unresolvable module imports, and ES syntax sneaking into `content.js`.

## Deviations from the original spec

- The popup is `popup.js`, not `popup.jsx`. The extension ships with **no build
  step and no runtime dependencies** — you load the folder directly. Adding JSX
  would mean adding a bundler between the source and what Chrome runs.
- `host_permissions` includes `https://api.anthropic.com/*`, which the original
  permission list did not mention. Calling the API from the service worker
  requires it.
