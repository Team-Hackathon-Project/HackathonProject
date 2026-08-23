# Demo script

Roughly three minutes, in the order a judge will want to see it. Every
screenshot below is a real capture from a real browser run, not a mockup.

## Setup (before you present)

```bash
npm install && npm run check     # 432 tests, static bundle validation
```

Load it: `chrome://extensions` (or `edge://extensions`) → **Developer mode** →
**Load unpacked** → pick this folder. Optionally add an API key in the options
page — **Anthropic (Claude)** by default, or **Groq** if that is the key you
have; press **Test connection** and you will see which model answered. The demo
works without any key at all, it just loses self-healing and falls back to the
local rules engine for advisories.

If you are showing the Bright Data half (section 4 below), start the agent in a
terminal you can leave running, and check it first:

```bash
npm run brightdata:check     # prints the zone, redacted, and connects for real
npm run agent                # the loopback bridge, on 127.0.0.1:8791
```

Open two tabs ahead of time:

1. `https://finance.yahoo.com/quote/AAPL/` — the happy path.
2. `https://stockanalysis.com/stocks/aapl/` — a site whose markup has drifted,
   which is where healing earns its keep.

---

## 1. Scrape the tab you are already looking at (~40s)

On the Yahoo tab, click the toolbar icon → **Scan this tab**.

![Quote and advisory in the popup](demo/01-scan.png)

Say: *there is no server, no API of theirs, and no scraping farm. It reads the
tab already open in front of me, normalizes it into typed JSON, and stores it
locally.* Expand **Selectors used** — that list is the audit trail of exactly
which DOM hooks produced each number.

## 2. You Make the decision (~30s)

Click **Approve**.

![The confirmation modal](demo/02-confirm.png)

Say: *the extension never places an order. Approve, Reject and Override all end
here, and all this button does is write the decision to local storage.*

Confirm, and the decision lands in the log with an explicit "No order was
placed."

![The decision log](demo/03-logged.png)

## 3. Self-healing when the page changes underneath it (~60s)

Switch to the stockanalysis tab and scan. The shipped `[data-test="quote-change"]`
hook no longer exists on that site — the layout moved on.

With a key configured, the extension captures the surrounding container, strips
it (offscreen, so the active tab never stalls), asks Claude for a replacement
selector, validates the answer against the live DOM, and re-runs extraction with
no reload.

![A healed selector, and two rejected ones](demo/04-self-healing.png)

Here is a real one, healed live on stockanalysis.com with a Groq key — the
shipped `change_percentage` hook is genuinely stale on that site, and the model
replaced it with a structural selector that the extension then validated against
the live DOM before trusting it:

![A real repair on a live page](demo/07-live-heal.png)

The interesting part of the earlier screenshot is the **rejection**. A selector that
merely *resolves* is not yet a selector that is *right*: here the model pointed
the volume and change fields at the price node, and the extension refused both
because `$182.44` is not a plausible volume or percentage. It heals, but it does
not accept garbage — and the bad selector never reaches the registry.

Scan again and the healed selector is reused from `chrome.storage.local` with no
second model call.

## 4. The same repair, in someone else's browser (~50s)

Options page → **Bright Data**. It is switched on, pointed at `127.0.0.1:8791`,
and **Test agent** already reports the zone.

![The Bright Data panel](demo/09-brightdata.png)

Type `AAPL` into **Read one now** and press **Scrape now**. It takes 20–35
seconds, and that wait is the point: this is a whole remote browser session.

What to say while it runs:

- *This reads the page through Bright Data's Scraping Browser — a real Chrome,
  somewhere else, with a CAPTCHA solver and a pinned exit country. It is for the
  pages a browser extension cannot open: geo-gated, rate-limited, or behind a
  challenge.*
- *It is not a second scraper. The agent injects this extension's own
  `content.js` into that remote page and calls the same three handlers the
  service worker calls in a real tab. Same candidate order, same sanitizer, same
  prompt, same refusals, same one retry. A repair found out there is one the
  popup would have made — so it gets merged straight back into the registry.*
- If asked why it is a separate process: *the endpoint is
  `wss://user:password@brd.superproxy.io:9222`, and the HTML standard requires
  `new WebSocket()` to throw on a URL that includes credentials. Chrome does
  exactly that, and the WebSocket API has no headers to authenticate any other
  way. An MV3 service worker is a page context. It is not a preference.*

When it returns, switch to **Selectors** and **Repair log**: the repair the
remote browser made is in this machine's registry, indistinguishable from one
made in a tab, because it is the same mechanism.

The good live demo of this is Google Finance. Their Beta rewrite left no working
price hook — `src/lib/selectors.js` says so in a comment — so
`npm run brightdata -- AAPL --url https://www.google.com/finance/quote/AAPL:NASDAQ`
has to repair it from scratch every time. Nothing is sabotaged for the demo; the
selector is simply out of date, which is the whole situation the project exists
for.

## 5. Everything at once, and it tells you when something moves (~50s)

Open the options page and press **Open dashboard**. This is the same watchlist
the popup has been feeding, on one page.

Say, while it is on screen:

- **Every ticker you have scanned is here already.** Nothing was configured; the
  watchlist builds itself out of what you scan.
- **The sparkline only appears at four scans or more.** A line drawn through two
  points is a confident trend invented out of a single move, so it is not drawn
  at all — the card says how many more scans it needs instead.
- **The bar under it is your own buy/sell band**, with today's price marked on
  it: the targets from the options page, or the ones the suggester proposed.

Then click a card and point at **Alert me when it...**. Add a **Percent move**
of 5%. What to say about it:

- It fires on the *crossing*, not while the condition holds. A price that stays
  above your target is one event, not one every fifteen minutes.
- With **Check prices in the background** switched on, the extension re-reads
  each ticker on a timer and alerts you with this page closed: an OS
  notification, a count on the toolbar icon, and the feed here. Three channels,
  because the operating system can suppress the first one without telling
  anybody.
- Background refresh needs access to that one site. It is asked for at the
  moment it is needed and revoked in **Site access**; nothing is granted at
  install.

The same page also runs as a real website — `npm run web`, then
`http://localhost:8080`. Identical files; only the transport differs. Worth
saying plainly: nothing is stored in the website. It is a view onto the
extension, which is where the data and the API key stay.

## 6. Where the state lives (~20s)

![Options: key, model, targets, healed registry](demo/05-options.png)

Say: *the key is stored locally and only ever sent to the provider's own host.
The healed-selector registry is inspectable and resettable, and the repair log
records every attempt — including the ones that were refused.*

The Bright Data credentials are deliberately *not* on this page: they live in
the agent's gitignored `.env`, on the machine that dials the endpoint. The panel
configures the agent's address and nothing else.

If someone asks what happens without an Anthropic key: switch the provider
dropdown to Groq. Same prompts, same schemas, same refusal logic — only the wire
format changes, and **Load models from provider** reads the live catalogue so
the model id is never a guess.

![The same page with Groq selected](demo/06-provider.png)

---

## If you are asked "what have you actually verified?"

- `npm run check` — 432 unit/integration tests plus static manifest and module
  graph validation.
- Real browser runs (`npm run e2e`, `npm run e2e:heal`) against
  **finance.yahoo.com** (all five fields, no healing), **stockanalysis.com** and
  **marketwatch.com** (four of five), **google.com/finance** (their Beta rewrite
  left no stable price hook, so that field is left to healing), and a locally
  served page with deliberately mangled markup to force the repair path.
- The packaged zip from `npm run package` was extracted and loaded as an
  extension, and the full scan → advise → approve → log flow re-run from it.
- Both providers answer from inside the service worker (`npm run e2e:provider`),
  and the repair loop was driven end to end in both wire formats. With a key in
  `.env`, `npm run e2e:live` does the whole thing for real against a live page.
- `npm run e2e:brightdata` — 12 checks against the real Bright Data service,
  ending in a real Chrome with the real unpacked extension driving the bridge
  from its own service worker. Last sweep, all 12 passing, including: the
  Scraping Browser accepted the credentials (`Chrome/151.0.7922.34`); a dead
  Google Finance price selector was repaired to `.fpRuab > span > span`,
  validated **inside the remote page**, and read 309.69 against 309.35 from a
  second site; the repair persisted; the next pass reused it with **zero**
  further model calls; and the reading landed in the extension's own storage
  with `last_method: "brightdata"`.

## Known limits, stated up front

- `activeTab` means the extension can only read a tab *after* you invoke it from
  the toolbar. That is deliberate: there are no declared content scripts and no
  standing access to any site.
- Advisories are a rules engine plus an LLM rationale. They are not a forecast,
  and nothing is ever sent to a broker.
- The Bright Data route needs `npm run agent` running, and a session takes
  20–35 seconds. That is why it is off by default, why the default refresh order
  tries a plain fetch first, and why the bridge runs one scrape at a time.
