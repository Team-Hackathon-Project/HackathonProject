# User guide

Everything this thing does, and how to make it do it. No prior knowledge
assumed. If you want the design reasoning instead, that is in the
[README](../README.md); this file is about using it.

- [What it is](#what-it-is)
- [Install it](#install-it)
- [First run: the five-minute setup](#first-run-the-five-minute-setup)
- [Scan a page](#scan-a-page)
- [Make a decision](#make-a-decision)
- [Targets: what turns a quote into a signal](#targets-what-turns-a-quote-into-a-signal)
- [The dashboard](#the-dashboard)
- [Alerts](#alerts)
- [Watching prices while you are not looking](#watching-prices-while-you-are-not-looking)
- [Scraping without opening the page](#scraping-without-opening-the-page)
- [Every command](#every-command)
- [Where your data lives](#where-your-data-lives)
- [When something goes wrong](#when-something-goes-wrong)
- [What it will not do](#what-it-will-not-do)

---

## What it is

A browser extension that reads the stock page you are already looking at, tells
you what it thinks, and lets you decide.

Three things make it different from a bookmark and a calculator:

**It reads the page, not an API.** No market data subscription, no API key for a
quote feed. It looks at the same screen you are looking at and pulls the numbers
off it.

**It repairs itself.** Websites get redesigned, and that normally breaks a
scraper silently — it keeps running and quietly reports nothing, or worse,
something wrong. When this one cannot find the price any more, it sends that
part of the page to an AI model, asks where the price went, checks the answer
actually works on the live page, and carries on. The fix is remembered, so it
costs one model call per breakage, not one per scan.

**It never trades.** There is no broker connection, and there is no code to add
one. Every recommendation ends at a confirmation box where you approve, reject
or override, and all that writes is a line in a local log.

---

## Install it

You need [Node.js](https://nodejs.org) 20 or newer and a Chromium browser —
Chrome, Edge or Chromium itself.

```bash
npm install
npm run check      # 476 tests; takes about ten seconds
npm run package    # builds dist/extension
```

Then, in the browser:

1. Open `edge://extensions` — or `chrome://extensions`
2. Turn on **Developer mode** (a toggle, usually bottom-left)
3. Click **Load unpacked**
4. Select the `dist/extension` folder inside this project

> `npm run package` writes a clean copy with only `manifest.json`, `src/` and
> `web/` in it. You can also point **Load unpacked** at the project root — the
> manifest is there too — but then the browser is loading your tests and
> scripts as well.

Pin it: click the 🧩 puzzle icon in the toolbar and pin **Self-Healing Market
Scraper**, so the icon stays visible.

**After changing any code, press the ↻ reload arrow on the extension's card.**
The browser does not pick up edits on its own.

---

## First run: the five-minute setup

The extension opens a **setup guide** the first time it is installed. It walks
through the same five steps below, and every one of them is optional — skipping
a step leaves that part at its default rather than half-configured.

You can reach the same settings any time: click the extension icon → **Settings**.

### 1. Choose how it should think

Two providers ship. Neither is required.

| Choice | What you get |
| --- | --- |
| **Local rules engine** (no key) | Buy/sell/hold from your own targets and the scraped numbers. No self-healing. Nothing leaves your machine. |
| **Groq** | Self-healing plus a written rationale. Free tier is enough. |
| **Anthropic (Claude)** | The same, on Claude. |

To use a model:

1. **Model provider** → pick one
2. Click the API key box, press **Ctrl+A** then **Delete** to clear it
3. Paste your key. The label above the box shows a character count — check it
   matches your key's length. A half-pasted key fails with exactly the same
   "invalid API key" as a wrong one, and the box shows dots, so the count is
   the only way to see it.
4. **Load models from provider** (Groq only) fills the model list with what your
   key can actually run
5. **Test connection** — it tells you which model answered and how long it took
6. **Save settings** ← nothing is stored until you press this

Keys are kept per provider, so switching between them does not throw the other
one away.

> **Groq models:** use `openai/gpt-oss-120b` (the default) or
> `openai/gpt-oss-20b`. Both hold to the strict JSON the extension asks for.
> Groq's catalogue changes and differs per account, which is what **Load models
> from provider** is for.

### 2. Tell it what you own

**Settings → Portfolio targets.** Add a row: ticker, shares, average cost, buy
below, sell above.

This matters more than it looks. Without targets, every answer is a
low-confidence HOLD, because there is no threshold to act on.

### 3. Watch some tickers

Add them from the dashboard, or scan a page once and it appears.

### 4. Open the dashboard

**Settings → Open dashboard.** All your tickers at once.

### 5. Optionally, Bright Data

Only if you want prices for pages you have not opened, or a scraper that runs on
someone else's infrastructure. See
[Scraping without opening the page](#scraping-without-opening-the-page).

---

## Scan a page

1. Open a stock quote page. Good ones:

   | Site | What happens |
   | --- | --- |
   | `finance.yahoo.com/quote/AAPL` | Everything resolves straight away |
   | `stockanalysis.com/stocks/aapl/` | One hook is stale — **this is where you see a repair** |
   | `marketwatch.com/investing/stock/aapl` | Works; the page carries no volume |
   | `google.com/finance/quote/AAPL:NASDAQ` | Their rewrite left no stable price hook, so it needs a repair |

2. Click the extension icon
3. Click **Scan this tab**

You get:

- **The quote card** — ticker, price, change, volume, time
- **A green banner**, when something was repaired: which field, and the new
  selector the model proposed
- **An amber banner**, when a field could not be read and why
- **The advisory** — BUY / SELL / HOLD, a confidence bar, and a paragraph

Two expandable sections are worth opening in front of anyone sceptical:
**Headlines on page**, and **Selectors used** — the exact DOM hooks each number
came from. That is the audit trail; nothing is invented.

**Scan the same page twice.** The second scan is instant and shows no repair
banner, because the fix was remembered.

---

## Make a decision

Click **Approve**, **Reject**, or **Override…**.

A confirmation box appears saying nothing is sent to a broker and the decision is
recorded locally. Confirm, and it lands in the decision log at the bottom of the
popup.

That is the whole point of the design: the software has an opinion, you have the
authority, and the log records which was which.

---

## Targets: what turns a quote into a signal

`buy below` and `sell above` are what let the engine say anything more useful
than HOLD. Typing two numbers per ticker is the step everyone skips, so it can
work them out for you.

**Settings → Portfolio targets → Suggest targets.**

It anchors on the first of these it has:

| Anchor | Meaning |
| --- | --- |
| The average of prices you have scanned for that ticker | what it traded at while you were watching |
| The average price of your approved BUY decisions | what you have actually paid |
| Your average cost | your book cost |
| Today's price | all there is on a first scan |

The band either side comes from how much those scans actually moved — their
standard deviation, clamped to 3–20% — or a flat 5% when there is not enough
history yet.

It fills the boxes and tells you what it anchored on. **You still press Save.**

Tick **Keep them updated automatically** and every later scan of that ticker
refreshes them, and the popup says so each time. Positions left manual are never
rewritten.

This is arithmetic on your own data. It does not ask a model what a stock is
worth, because that would be a guess wearing a suit.

---

## The dashboard

The popup shows one ticker. The dashboard shows all of them, keeps them
refreshed, and flags the ones that moved.

Two ways to open the same thing:

```bash
# 1. Inside the extension — nothing to run
#    Settings -> "Open dashboard"

# 2. As a real website
npm run web        # http://localhost:8080
```

The website route talks to the extension directly and stores nothing itself. It
needs the extension's ID once, and the **Open dashboard** button fills that in.
With the extension disabled the page says so rather than showing an empty grid.

---

## Alerts

Four kinds of rule, because they answer different questions:

| Rule | Asks |
| --- | --- |
| **target** | "tell me when it reaches the price I decided on" — uses the targets already on the position |
| **percent** | "tell me when it moves 5%" — the move, not the level |
| **level** | "tell me when it is above 240" — a plain threshold |
| **advice_flip** | "tell me when the recommendation itself changes" |

Two rules run through all of them. An alert fires on a **crossing**, not on a
state, so it does not re-fire every fifteen minutes while the condition merely
holds — and there is a cooldown behind that. And nothing fires on a number that
is not there: a missing price is not a fall to zero.

---

## Watching prices while you are not looking

Add tickers to the watchlist and the extension refreshes them in the background,
by whichever route is cheapest:

1. **Fetch and parse the page.** Silent, fast, no tab appears. Works on
   server-rendered pages.
2. **Read it through the Bright Data Scraping Browser.** A real Chrome
   elsewhere. Off until configured.
3. **Open it in a background tab** and run the real content script. Slower and
   briefly visible, but it is a genuine render, so it works everywhere the popup
   does — including repairs.

Routes 1 and 3 read from *your* browser, so both need you to have granted access
to that host. Route 2 does not touch your browser at all.

A refresh **writes nothing it is unsure of.** A page reporting a different ticker
than the one asked for, or a price the host reports identically for two different
stocks, is recorded as a failure on that card rather than stored as a number.

---

## Scraping without opening the page

Two Bright Data products are wired in. They are different things, and the
difference matters.

### Scraping Browser — a remote Chrome you drive

The scraper is *ours*: our content script, our selectors, our repair loop,
running against a real Chrome somewhere else with a CAPTCHA solver and a pinned
exit country. Useful for pages you have not opened, and for sites that refuse a
plain fetch.

```bash
npm run brightdata:check     # do the credentials work?
npm run agent                # start the local bridge on 127.0.0.1:8791
npm run brightdata -- AAPL   # scrape one ticker through it
```

Put the endpoint in `.env` — see `.env.example`. The password shown in the
Bright Data console is masked until you press the reveal control, and the masked
form copies cleanly and fails confusingly, so it is rejected by name.

### Scraper Studio — a scraper that runs on their infrastructure

Here the scraper is a **collector** you author and publish in Bright Data's own
IDE. It runs on their machines; this project queues inputs and collects results.

```bash
npm run studio:check         # credentials only, queues nothing
npm run studio -- AAPL MSFT  # a real collector run
```

Setup is in [SCRAPER-STUDIO.md](SCRAPER-STUDIO.md) — including the wording to
give their AI Agent so the output matches what this project reads. You need two
values in `.env`:

```
BRIGHT_DATA_API_TOKEN=       # account settings -> API tokens
BRIGHT_DATA_COLLECTOR_ID=    # in the Scraper Studio URL for your collector
```

A run takes 15–20 seconds and prints what came back.

---

## Every command

```bash
# Build and check
npm run check          # lint + the full test suite
npm run package        # dist/extension (load this) + a zip (send this)
npm run web            # serve the dashboard as a website on :8080

# Browser end-to-end runs (they open a real browser)
npm run e2e            # scan a live quote page, approve, log
npm run e2e:heal       # the repair loop, offline and deterministic
npm run e2e:targets    # target suggestion across repeated scans
npm run e2e:dashboard  # the dashboard, both routes
npm run e2e:live       # a real repair and advisory, using your key
npm run e2e:provider   # does the configured key and model answer?

# Bright Data — these reach real services
npm run brightdata:check
npm run e2e:brightdata
npm run studio:check
npm run studio -- AAPL
```

Credentials for all of these live in a gitignored `.env`; copy `.env.example`
and fill in what you have. Nothing prints a key — logs show a prefix and a
length, never the value.

---

## Where your data lives

`chrome.storage.local`, on your machine. Nothing is uploaded, and there is no
account.

| Key | Holds |
| --- | --- |
| `settings` | Provider, per-provider keys and models, toggles |
| `portfolio` | Positions and targets |
| `snapshots` | The latest reading per ticker |
| `price_history` | Up to 60 price points per ticker |
| `decisions` | Every approve/reject/override, with its rationale |
| `selector_registry` | Selectors the model repaired, per host |
| `heal_log` | Every repair attempt, including refused ones |
| `watchlist` | Tickers being followed |
| `alert_rules` / `alerts` | Rules, and what has fired |

The only things that leave your machine are a sanitized fragment of page HTML
when something needs repairing, and the quote context when you ask a model for a
rationale — both to the provider you chose, from the service worker, never from
a page.

---

## When something goes wrong

**"Invalid API key" but the key is right.** Check the character counter next to
the key label. A half-paste is invisible in a password box and fails identically
to a wrong key. Clear the box completely first, then paste.

**No advisory, just a rules-based one.** Either no key is saved, or the provider
refused. The card says which. Groq's free tier rate-limits; wait ten seconds.

**"This page cannot be scraped."** The extension can only read a tab after you
click its icon, and it cannot read browser pages (`chrome://`, the web store) at
all.

**A field is missing and nothing is repairing it.** Repairs need a key. Without
one the field is reported missing rather than guessed at.

**A repair keeps failing.** Open **Settings → Repair log**. Every attempt is
there with the model's own reasoning, including the ones the extension refused
because the answer did not hold a value of the right shape.

**A number looks wrong.** **Settings → Reset healed selectors** discards every
learned selector and falls back to the shipped ones.

**The extension seems stale after a code change.** Reload it on the extensions
page. Loading unpacked does not hot-reload.

---

## What it will not do

- **It does not trade.** No broker, no order, no code path to one.
- **It does not forecast.** The advisory reads your targets and the numbers on
  the page. It is not a prediction, and confidence is deliberately low when the
  inputs are thin.
- **It cannot read a tab you have not handed it.** `activeTab` is granted by
  your click and nothing else. There are no declared content scripts.
- **It will not invent a number.** A value that does not fit its field is
  dropped and reported, not stored. A repair that resolves but returns the wrong
  kind of value is refused and never reaches the registry.
