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
