/** Synthetic quote pages used to exercise extraction and healing offline. */

/** Matches the shipped Yahoo-style defaults. */
export const HEALTHY_PAGE = `
<!doctype html>
<html><head><title>Apple Inc. (AAPL) Stock Price</title></head>
<body>
  <nav id="site-nav"><a href="/">Home</a></nav>
  <div class="ad-slot" id="advert-top">Sponsored: trade free today</div>
  <main>
    <section data-testid="quote-hdr"><h1>Apple Inc. (AAPL)</h1></section>
    <div class="quote-strip">
      <span data-testid="qsp-price">224.50</span>
      <span data-testid="qsp-price-change-percent">(+1.80%)</span>
    </div>
    <table>
      <tr><th>Volume</th><td><fin-streamer data-field="regularMarketVolume">52,300,000</fin-streamer></td></tr>
    </table>
    <section data-testid="recent-news">
      <div data-testid="storyitem"><h3>Apple beats earnings expectations again</h3></div>
      <div data-testid="storyitem"><h3>Analysts raise price targets on iPhone demand</h3></div>
    </section>
  </main>
  <footer>© Example</footer>
  <script>window.__tracking = {a:1};</script>
</body></html>`;

/**
 * Same data, but every shipped hook has been renamed — this is the layout
 * change that must trigger the self-healing path.
 */
export const BROKEN_PAGE = `
<!doctype html>
<html><head><title>Apple Inc. (AAPL) Stock Price</title></head>
<body>
  <nav id="site-nav"><a href="/">Home</a></nav>
  <main>
    <section class="hdr-2026"><h1>Apple Inc. (AAPL)</h1></section>
    <div class="quote-strip-v2">
      <span class="qz-8f31ab">224.50</span>
      <span class="qz-delta-19c">(+1.80%)</span>
    </div>
    <div class="stats-v2"><span class="lbl">Volume</span><span class="qz-vol-77a">52,300,000</span></div>
    <div class="ad-slot">Sponsored</div>
    <section class="stories-v2">
      <div class="story"><h3>Apple beats earnings expectations again</h3></div>
    </section>
  </main>
  <script>window.__tracking = {a:1};</script>
</body></html>`;

/** A page with no recognizable quote data at all. */
export const EMPTY_PAGE = `
<!doctype html>
<html><head><title>About us</title></head>
<body><main><h1>About our company</h1><p>We are a company that does things.</p></main></body></html>`;

/**
 * A page where an early generic selector matches a real element that holds the
 * wrong kind of value: `[class*="volume" i]` lands on the *label*, not the
 * count. The structural fallback further down the list has the real number.
 */
export const MISLEADING_PAGE = `
<!doctype html>
<html><head><title>Apple Inc. (AAPL) Stock Price</title></head>
<body>
  <main>
    <section data-testid="quote-hdr"><h1>Apple Inc. (AAPL)</h1></section>
    <span data-testid="qsp-price">224.50</span>
    <span data-testid="qsp-price-change-percent">(+1.80%)</span>
    <table>
      <tr><td class="volume-label">Volume</td><td class="figure">52,300,000</td></tr>
    </table>
    <section data-testid="recent-news">
      <div data-testid="storyitem"><h3>Apple beats earnings expectations again</h3></div>
    </section>
  </main>
</body></html>`;

/** Same shape, but with no usable volume anywhere on the page. */
export const MISLEADING_ONLY_PAGE = `
<!doctype html>
<html><head><title>Apple Inc. (AAPL) Stock Price</title></head>
<body>
  <main>
    <section data-testid="quote-hdr"><h1>Apple Inc. (AAPL)</h1></section>
    <span data-testid="qsp-price">224.50</span>
    <div class="volume-label">Volume</div>
  </main>
</body></html>`;


/**
 * The shape that produced the "every stock shows the same price" bug.
 *
 * Modelled on Google Finance as it actually renders to the extension: no
 * `<main>`, the only `h1` is the site name, the instrument's own quote block is
 * absent, and the sole price-shaped text on the page is a rail of index levels.
 * A scraper that takes the first plausible number here reports the same index
 * for every ticker it is ever pointed at.
 */
export const INDEX_RAIL_PAGE = `
<!doctype html>
<html><head><title>AAPL: Apple Inc - Google Finance</title></head>
<body>
  <header><h1>Finance</h1></header>
  <div role="listbox" class="market-summary">
    <div role="option"><span>Dow Jones</span><span>54,106.20</span></div>
    <div role="option"><span>S&amp;P 500</span><span>7,318.44</span></div>
    <div role="option"><span>Nasdaq</span><span>24,901.03</span></div>
    <div role="option"><span>Russell</span><span>2,477.61</span></div>
  </div>
  <table class="movers">
    <tr><td>NVDA</td><td>184.62</td></tr>
    <tr><td>MSFT</td><td>484.45</td></tr>
    <tr><td>TSLA</td><td>396.10</td></tr>
  </table>
</body></html>`;
