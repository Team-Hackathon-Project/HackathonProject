# Bright Data Scraper Studio

The hackathon rule reads:

> your project must use Bright Data Scraper Studio to create and run a custom
> web scraper.

That names one specific Bright Data product, and it is **not** the Scraping
Browser this project already uses. Both are Bright Data, and the difference is
where the scraper lives:

| | Scraping Browser (`npm run agent`) | Scraper Studio (`npm run studio`) |
| --- | --- | --- |
| Who wrote the scraper | us, in `src/content.js` | you, in Bright Data's IDE |
| Where it runs | your machine drives a remote Chrome | Bright Data's infrastructure |
| How data comes back | we parse the DOM ourselves | an HTTP endpoint returns a dataset |
| What a judge can point at | a websocket endpoint | a **Collector ID** in your dashboard |

The client for Studio is written and tested: [`agent/studio.mjs`](../agent/studio.mjs).
What it needs from you is a published collector, because that part happens
inside your Bright Data account and cannot be done from this repository.

---

## What you need to do

### 1. Create the collector

Bright Data → **Scraper Studio** → new scraper. Their AI Agent takes a plain
description; give it this, which is worded to produce exactly the fields the
extension already understands:

> Scrape a stock quote page. The input is a URL such as
> `https://stockanalysis.com/stocks/aapl/`. Return one row per page with these
> fields: `ticker` (the symbol, uppercase), `current_price` (a number, no
> currency symbol), `currency` (a three-letter code, default USD),
> `change_percentage` (the day's percentage change as text, e.g. "+1.80%"),
> `change_value` (that change as a number), `volume` (shares traded, as a
> number), `news` (an array of up to five headline strings on the page), and
> `source_url` (the page URL).

Then run it once inside Studio against `https://stockanalysis.com/stocks/aapl/`
so there is a real job in your dashboard, and **publish** it.

Field names are matched loosely on our side — `symbol`, `price`,
`percent_change`, `headlines` and several others are all understood — so a
schema the Agent words slightly differently will still work. What matters is
that a row carries **a ticker and a price**; rows without both are reported as
unusable rather than silently dropped.

### 2. Copy two values into `.env`

```
BRIGHT_DATA_API_TOKEN=...
BRIGHT_DATA_COLLECTOR_ID=...
```

- **API token** — Bright Data → account settings → API tokens → create
- **Collector ID** — in the Scraper Studio URL for your collector, and on the
  collector's own page

`.env` is gitignored and is never packaged.

### 3. Check the wiring

```bash
npm run studio:check     # credentials only — queues no job, spends nothing
npm run studio -- AAPL   # a real collector run
```

A real run prints the snapshot id, polls until the dataset is ready, and lists
what came back:

```
[studio] collector: c_xxxxx · token: brd_…40 chars
[studio] queued — snapshot s_yyyyy
[studio] waiting (building) — attempt 1
[studio] dataset ready — 1 row(s) after 2 poll(s)
[studio] 1 usable snapshot(s) in 8431ms
[studio]   AAPL  USD 224.5 (+1.80%)
```

---

## How it is wired in

`npm run agent` serves a loopback bridge the extension already talks to. Scraper
Studio is a route on that same bridge, so a Studio result reaches the popup by
the path a Scraping Browser result already takes:

```
POST /studio   { "tickers": ["AAPL"] }  ->  { ok, snapshots: [...], collection_id }
```

The rows come back mapped onto the project's own snapshot shape, which means a
Studio scrape and a browser scrape are interchangeable downstream — same
advisory, same storage, same popup. `GET /health` reports whether Studio is
configured, alongside everything else.

---

## What the two endpoints are

For anyone reading the code or checking our homework:

```
POST https://api.brightdata.com/dca/trigger?collector=<id>&queue_next=1
     Authorization: Bearer <token>
     body: [{ "url": "https://..." }, ...]
     -> { "collection_id": "<snapshot id>" }

GET  https://api.brightdata.com/dca/dataset?id=<snapshot id>
     Authorization: Bearer <token>
     -> a status object while the job builds
     -> a JSON array once it is finished
```

"An array means finished" is Bright Data's own signal, not an inference of ours.

Two failure modes are treated differently on purpose, following their
boilerplate: a **4xx fails immediately**, because a wrong token or a wrong
collector id will answer the same way forever, while a **5xx or a dropped
connection backs off and retries** (1s, 2s, 4s), because that is their side
having a moment. A job that never finishes times out after ~5 minutes with the
snapshot id in the message, so you can go and look at it in the dashboard.

---

## Troubleshooting

| What you see | What it means |
| --- | --- |
| `401` | The API token. Check `BRIGHT_DATA_API_TOKEN`. |
| `404` | The collector id. Check `BRIGHT_DATA_COLLECTOR_ID`. |
| `did not finish within 300s` | The job is still building. The snapshot id is in the message — open it in the dashboard. |
| `N row(s) had no usable ticker or price` | The collector ran, but its output schema does not carry what we need. The CLI prints the offending rows; compare them with the field list in step 1. |
| `no Scraper Studio credentials in .env` | Neither value is set yet. |

A row whose price reads `n/a` is deliberately treated as **no price**, not as
zero — a plausible-looking number nothing questions downstream is worse than a
missing one.
