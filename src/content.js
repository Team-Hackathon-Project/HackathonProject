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
    PING: 'PING',
  };

  const LIST_FIELDS = new Set(['news']);
  const MAX_SCALAR_LEN = 120;
  const MAX_SCALAR_CHILDREN = 4;
  const MAX_LIST_ITEMS = 8;

  /** Tags whose content is never page data. */
  const NOISE_TAGS = [
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
    'nav', 'footer', 'header', 'aside', 'form', 'video', 'audio',
  ];

  /** Text patterns used to locate a plausible container when a selector dies. */
  const FIELD_PATTERNS = {
    price: /^[^\d]{0,3}\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?[^\d%]{0,4}$/,
    change_percentage: /[-+−(]?\s*\d+(?:[.,]\d+)?\s*%/,
    volume: /^\s*\d[\d.,]*\s*[KkMmBbTt]?\s*$/,
    ticker: /^[A-Z][A-Z0-9.\-]{0,9}$/,
    news: /\S{3,}\s+\S{3,}/,
  };

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
      const nodes = query(entry, wantList);
      if (!nodes || nodes.length === 0) continue;
      if (wantList) {
        const values = nodes.map(readText).filter((text) => text.length >= 12).slice(0, MAX_LIST_ITEMS);
        if (values.length) return { value: values, used: entry };
      } else {
        const value = readText(nodes[0]);
        if (value && value.length <= MAX_SCALAR_LEN && isValueElement(nodes[0])) return { value, used: entry };
      }
    }
    return null;
  }

  /**
   * Finds the smallest element whose own text looks like the missing metric,
   * then returns an ancestor a few levels up so the LLM sees usable context.
   * Falls back to the page's main region.
   */
  function findContainer(field) {
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
        if (text && text.length <= 40 && node.children.length <= 1 && pattern.test(text)) {
          candidates.push(node);
          if (candidates.length >= 12) break;
        }
      }
      node = walker.nextNode();
    }
    if (!candidates.length) return root;

    // Prefer the match closest to the page heading — quote pages put the live
    // number next to the instrument name, while tables of unrelated numbers
    // sit further down.
    const heading = document.querySelector('h1');
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
  function snippetFor(field, limit) {
    const container = findContainer(field);
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
          snippet: snippetFor(field, limit),
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
    } catch (error) {
      sendResponse({ ok: false, error: String((error && error.message) || error) });
    }
    return undefined;
  });

  // Exposed only so the offline test harness can drive the same code paths.
  window[FLAG] = { handleExtract, handleValidate, snippetFor, extractField };
})();
