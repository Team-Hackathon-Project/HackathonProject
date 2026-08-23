/**
 * Content script — injected on demand by `chrome.scripting.executeScript`
 * (activeTab), never declared in the manifest.
 *
 * IMPORTANT: this file is injected as a classic script, so it must not use ES
 * `import`. Every constant it shares with the rest of the extension is
 * re-declared here and asserted in `test/protocol.test.js`.
 *
 * Responsibilities:
 *   1. Run the ordered selector candidates handed down by the service worker.
 *   2. Return the raw strings it found, plus which selector produced each one.
 *   3. For anything it could not find, return a trimmed HTML container so the
 *      service worker can ask the LLM for a replacement selector.
 *   4. Validate a proposed selector on request (the re-attempt half of healing).
 */
(() => {
  const FLAG = '__selfHealingMarketScraper__';
  if (window[FLAG]) return; // already injected into this frame
  window[FLAG] = true;

  const MSG = {
    EXTRACT: 'EXTRACT',
    VALIDATE_SELECTOR: 'VALIDATE_SELECTOR',
    CAPTURE_CONTAINER: 'CAPTURE_CONTAINER',
    PING: 'PING',
  };

  const LIST_FIELDS = new Set(['news']);
  const MAX_SCALAR_LEN = 120;
  const MAX_SCALAR_CHILDREN = 4;
  /** How many matches of one scalar selector are worth looking past. */
  const MAX_SCALAR_MATCHES = 8;
  const MAX_LIST_ITEMS = 8;

  /** Tags whose content is never page data. */
  const NOISE_TAGS = [
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
    'nav', 'footer', 'header', 'aside', 'form', 'video', 'audio',
  ];

  /**
   * Fields that identify *this* instrument. A match for one of these inside a
   * region listing many instruments is always wrong, however plausible the
   * value looks on its own.
   */
  const INSTRUMENT_FIELDS = new Set(['price', 'change_percentage', 'ticker']);

  /** Regions that exist to list instruments other than this one. */
  const FOREIGN_REGION_HOOKS = [
    '[role="listbox"]', '[role="tablist"]', '[role="menu"]', '[role="navigation"]',
    '[class*="market-summary" i]', '[class*="marketsummary" i]', '[class*="watchlist" i]',
    '[class*="ticker-tape" i]', '[class*="movers" i]', '[class*="index-list" i]',
    '[aria-label*="market summary" i]',
  ].join(',');

  /** Containers that hold a repeated row/cell structure. */
  const LIST_LIKE = 'table,ul,ol,[role="table"],[role="list"],[role="listbox"],[role="grid"]';

  /** How many sibling values make a region a list of instruments rather than one. */
  const CROSS_INSTRUMENT_MIN_PEERS = 3;

  /** Text patterns used to locate a plausible container when a selector dies. */
  const FIELD_PATTERNS = {
    price: /^[^\d]{0,3}\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?[^\d%]{0,4}$/,
    change_percentage: /[-+−(]?\s*\d+(?:[.,]\d+)?\s*%/,
    volume: /^\s*\d[\d.,]*\s*[KkMmBbTt]?\s*$/,
    ticker: /^[A-Z][A-Z0-9.\-]{0,9}$/,
    news: /\S{3,}\s+\S{3,}/,
  };

  /**
   * True when `element` sits inside a region whose whole job is to list *other*
   * instruments: an index rail, a watchlist, a top-movers strip.
   *
   * Nothing inside one of these describes the stock the user is looking at, so
   * it is worthless as context for any field — which makes it the right filter
   * when hunting for a container to hand the model.
   */
  function isForeignRegion(element) {
    // Starts at the element itself: a candidate can *be* the rail, not merely
    // sit inside one.
    let node = element;
    for (let depth = 0; depth < 8 && node && node !== document.body; depth++) {
      try {
        if (node.matches(FOREIGN_REGION_HOOKS)) return true;
      } catch {
        // A selector list this browser cannot parse is not a reason to fail the
        // scrape; fall through to the next ancestor.
      }
      node = node.parentElement;
    }
    return false;
  }

  /**
   * True when `element` holds a value belonging to some other instrument.
   *
   * Stricter than `isForeignRegion`, and deliberately narrower in scope. It
   * adds a structural test — a list-like ancestor holding three or more values
   * of the same shape is a table of instruments rather than one quote — which
   * is how an unlabelled market-summary strip gives itself away.
   *
   * It applies only to the fields that identify the instrument. A plain table
   * of three numbers is exactly where a quote page keeps *this* stock's volume,
   * so the structural test would do more harm than good there.
   */
  function isCrossInstrument(element, field) {
    if (!element || !INSTRUMENT_FIELDS.has(field)) return false;
    if (isForeignRegion(element)) return true;
    const pattern = FIELD_PATTERNS[field];
    if (!pattern) return false;

    let node = element;
    for (let depth = 0; depth < 8 && node && node !== document.body; depth++) {
      try {
        if (node.matches(LIST_LIKE) && countPeers(node, pattern) >= CROSS_INSTRUMENT_MIN_PEERS) return true;
      } catch {
        // As above: an unparseable selector list is not a scrape failure.
      }
      node = node.parentElement;
    }
    return false;
  }

  /** How many leaf descendants of `root` read as a value of this shape. */
  function countPeers(root, pattern) {
    let peers = 0;
    const nodes = root.querySelectorAll('*');
    for (let i = 0; i < nodes.length && i < 400; i++) {
      const node = nodes[i];
      if (node.children.length) continue;
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && text.length <= 40 && pattern.test(text)) peers++;
      if (peers >= CROSS_INSTRUMENT_MIN_PEERS) return peers;
    }
    return peers;
  }

  /**
   * The words a page uses to introduce each metric.
   *
   * The value patterns above only recognise a bare figure, but plenty of pages
   * put the label and the value in one node — "Vol 44,102,880". Without this,
   * such a page looks to the container search as though it holds no volume at
   * all, and a field that is right there on screen gets written off as absent.
   */
  const FIELD_LABEL_PATTERNS = {
    price: /\b(price|last)\b/i,
    change_percentage: /\bchange\b/i,
    volume: /\bvol(?:ume)?\b/i,
    ticker: /\b(symbol|ticker)\b/i,
  };

  /** True when this text is worth showing the model as context for `field`. */
  function looksRelevant(field, text) {
    const value = FIELD_PATTERNS[field];
    if (value && value.test(text)) return true;
    const label = FIELD_LABEL_PATTERNS[field];
    return Boolean(label && label.test(text));
  }

  function runCss(selector, all) {
    try {
      return all ? Array.from(document.querySelectorAll(selector)) : [document.querySelector(selector)].filter(Boolean);
    } catch {
      return null; // invalid selector syntax
    }
  }

  function runXpath(expression, all) {
    try {
      const type = all ? XPathResult.ORDERED_NODE_SNAPSHOT_TYPE : XPathResult.FIRST_ORDERED_NODE_TYPE;
      const result = document.evaluate(expression, document, null, type, null);
      if (!all) return result.singleNodeValue ? [result.singleNodeValue] : [];
      const nodes = [];
      for (let i = 0; i < result.snapshotLength; i++) nodes.push(result.snapshotItem(i));
      return nodes;
    } catch {
      return null;
    }
  }

  /** Runs one selector entry. Returns null on a syntactically invalid selector. */
  function query(entry, all) {
    const nodes = entry.strategy === 'xpath' ? runXpath(entry.selector, all) : runCss(entry.selector, all);
    if (nodes === null) return null;
    return nodes.filter((node) => node && node.nodeType === 1);
  }

  /** Pulls display text out of an element, including value-carrying attributes. */
  function readText(element) {
    if (!element) return '';
    for (const attribute of ['data-value', 'data-last-price', 'value', 'content']) {
      const raw = element.getAttribute && element.getAttribute(attribute);
      if (raw && raw.trim()) return raw.trim();
    }
    const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
    return text;
  }

  /**
   * A metric selector must land on the value itself, not on a wrapper that
   * happens to contain it. A node with many element children is a container.
   */
  function isValueElement(element) {
    if (!element) return false;
    return element.querySelectorAll('*').length <= MAX_SCALAR_CHILDREN;
  }

  function extractField(field, candidates) {
    const wantList = LIST_FIELDS.has(field);
    for (const entry of candidates || []) {
      // Scalars still produce one value, but every match is collected so a
      // first hit inside an index rail can be stepped over instead of taken.
      const nodes = query(entry, true);
      if (!nodes || nodes.length === 0) continue;
      if (wantList) {
        const values = nodes.map(readText).filter((text) => text.length >= 12).slice(0, MAX_LIST_ITEMS);
        if (values.length) return { value: values, used: entry };
      } else {
        for (const node of nodes.slice(0, MAX_SCALAR_MATCHES)) {
          if (isCrossInstrument(node, field)) continue;
          const value = readText(node);
          if (value && value.length <= MAX_SCALAR_LEN && isValueElement(node)) return { value, used: entry };
        }
      }
    }
    return null;
  }

  /**
   * The element the quote is most likely to sit next to.
   *
   * An `h1` is the obvious anchor and the wrong one on any page whose heading
   * is the site name rather than the instrument (Google Finance's only `h1`
   * reads "Finance"). When the caller knows the ticker from the URL, the
   * smallest element mentioning it beats any heading.
   */
  function findAnchor(anchorText) {
    if (anchorText) {
      const needle = String(anchorText).toUpperCase();
      const scope = document.querySelector('main') || document.body;
      const nodes = scope ? scope.querySelectorAll('h1,h2,h3,[role="heading"],span,div') : [];
      // Rank by what the element *is*, then by how tightly it names the
      // instrument. Shortest-text-wins on its own picks a bare "AAPL" chip in
      // a peer table or an ad slot over the page's own "Apple Inc. (AAPL)"
      // heading, and every later distance measurement is then taken from the
      // wrong part of the page.
      const rankOf = (node) => {
        const tag = node.tagName.toLowerCase();
        if (tag === 'h1') return 0;
        if (tag === 'h2' || tag === 'h3' || node.getAttribute('role') === 'heading') return 1;
        return 2;
      };
      let best = null;
      for (let i = 0; i < nodes.length && i < 4000; i++) {
        const node = nodes[i];
        if (node.children.length > 2) continue;
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 80 || !text.toUpperCase().includes(needle)) continue;
        const rank = rankOf(node);
        if (!best || rank < best.rank || (rank === best.rank && text.length < best.text.length)) {
          best = { node, text, rank };
        }
      }
      if (best) return best.node;
    }
    return document.querySelector('h1');
  }

  /**
   * Finds the smallest element whose own text looks like the missing metric,
   * then returns an ancestor a few levels up so the LLM sees usable context.
   *
   * Returns null when the page holds no such text at all. That is a real and
   * common answer — plenty of quote pages carry no volume and no news — and it
   * beats a fallback container: it lets the caller say so plainly instead of
   * paying for a model call that can only reply "it is not in here".
   */
  function findContainer(field, anchorText) {
    const pattern = FIELD_PATTERNS[field];
    const root = document.querySelector('main') || document.body;
    if (!root) return null;
    if (!pattern) return root;

    const candidates = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    let visited = 0;
    while (node && visited < 6000) {
      visited++;
      if (!NOISE_TAGS.includes(node.tagName.toLowerCase())) {
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (text && text.length <= 40 && node.children.length <= 1 && looksRelevant(field, text)
            && !isForeignRegion(node) && !isCrossInstrument(node, field)) {
          candidates.push(node);
          if (candidates.length >= 12) break;
        }
      }
      node = walker.nextNode();
    }
    if (!candidates.length) return null;

    // Prefer the match closest to the instrument — quote pages put the live
    // number next to the name, while tables of unrelated numbers sit further off.
    const heading = findAnchor(anchorText);
    let best = candidates[0];
    if (heading) {
      let bestDistance = Infinity;
      for (const candidate of candidates) {
        const distance = domDistance(heading, candidate);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
    }
    let container = best;
    for (let i = 0; i < 3 && container.parentElement && container.parentElement !== document.body; i++) {
      container = container.parentElement;
    }
    return container;
  }

  /** Rough structural distance: depth of `b` below the common ancestor with `a`. */
  function domDistance(a, b) {
    let depth = 0;
    let node = b;
    while (node) {
      if (node.contains(a)) return depth;
      node = node.parentElement;
      depth++;
    }
    return depth;
  }

  /**
   * Cheap in-page trim before the snippet crosses a message boundary: drop
   * script/style payloads (which can be megabytes) and cap the length.
   * The deep sanitize happens in the offscreen document.
   */
  function snippetFor(field, limit, anchorText) {
    const container = findContainer(field, anchorText);
    if (!container) return '';
    let clone;
    try {
      clone = container.cloneNode(true);
    } catch {
      return '';
    }
    clone.querySelectorAll(NOISE_TAGS.join(',')).forEach((element) => element.remove());
    const html = clone.outerHTML || '';
    return html.length > limit ? `${html.slice(0, limit)}\n<!-- truncated -->` : html;
  }

  function handleExtract(payload) {
    const candidates = (payload && payload.candidates) || {};
    const limit = (payload && payload.snippetLimit) || 20000;
    const anchorText = (payload && payload.anchorText) || null;
    const raw = {};
    const used = {};
    const failures = [];

    for (const field of Object.keys(candidates)) {
      const hit = extractField(field, candidates[field]);
      if (hit) {
        raw[field] = hit.value;
        used[field] = hit.used;
      } else {
        raw[field] = LIST_FIELDS.has(field) ? [] : null;
        failures.push({
          field,
          snippet: snippetFor(field, limit, anchorText),
          tried: (candidates[field] || []).map((entry) => entry.selector),
        });
      }
    }

    return {
      ok: true,
      url: location.href,
      host: location.host,
      title: document.title,
      raw,
      used,
      failures,
    };
  }

  /**
   * Hands back the container for one field on request. The worker asks for
   * this when a selector matched but produced the wrong kind of value, so the
   * repair path gets the same context a plain miss would have given it.
   */
  function handleCapture(payload) {
    const field = payload && payload.field;
    const limit = (payload && payload.snippetLimit) || 20000;
    if (!field) return { ok: false, error: 'no field supplied' };
    const snippet = snippetFor(field, limit, (payload && payload.anchorText) || null);
    if (!snippet) return { ok: false, error: 'no container found for this field' };
    return { ok: true, snippet };
  }

  function handleValidate(payload) {
    const field = payload && payload.field;
    const entry = { selector: payload && payload.selector, strategy: payload && payload.strategy };
    if (!entry.selector) return { ok: false, error: 'no selector supplied' };
    const wantList = LIST_FIELDS.has(field);
    const nodes = query(entry, wantList);
    if (nodes === null) return { ok: false, error: 'invalid selector syntax' };
    if (nodes.length === 0) return { ok: false, error: 'selector matched no elements' };
    if (wantList) {
      const values = nodes.map(readText).filter((text) => text.length >= 12).slice(0, MAX_LIST_ITEMS);
      if (!values.length) return { ok: false, error: 'selector matched no usable text' };
      return { ok: true, value: values, matchCount: nodes.length };
    }
    if (isCrossInstrument(nodes[0], field)) {
      return { ok: false, error: 'selector matched a row in a list of other instruments, not this one' };
    }
    const value = readText(nodes[0]);
    if (!value) return { ok: false, error: 'selector matched an empty element' };
    if (value.length > MAX_SCALAR_LEN || !isValueElement(nodes[0])) {
      return { ok: false, error: 'selector matched a container, not a value' };
    }
    return { ok: true, value, matchCount: nodes.length };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;
    try {
      if (message.type === MSG.PING) {
        sendResponse({ ok: true, host: location.host });
        return undefined;
      }
      if (message.type === MSG.EXTRACT) {
        sendResponse(handleExtract(message.payload));
        return undefined;
      }
      if (message.type === MSG.VALIDATE_SELECTOR) {
        sendResponse(handleValidate(message.payload));
        return undefined;
      }
      if (message.type === MSG.CAPTURE_CONTAINER) {
        sendResponse(handleCapture(message.payload));
        return undefined;
      }
    } catch (error) {
      sendResponse({ ok: false, error: String((error && error.message) || error) });
    }
    return undefined;
  });

  // Exposed only so the offline test harness can drive the same code paths.
  window[FLAG] = { handleExtract, handleValidate, handleCapture, snippetFor, extractField };
})();
