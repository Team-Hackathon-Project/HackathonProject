/**
 * DOM sanitizer for scraped snippets.
 *
 * Runs in the offscreen document (real DOM) and in tests (jsdom). It takes a
 * parsed root element and returns compact HTML that keeps every attribute a
 * selector could hook onto while discarding page bloat.
 */

/** Elements that never contain quote data. */
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object',
  'embed', 'video', 'audio', 'picture', 'source', 'link', 'meta', 'form', 'input',
  'button', 'select', 'textarea', 'nav', 'footer', 'header', 'aside', 'ins',
]);

/** Attribute names that are stable enough to build a selector from. */
const KEEP_ATTRS = new Set(['id', 'class', 'role', 'itemprop', 'itemtype', 'lang', 'value', 'content']);

/** Substrings that mark an element as advertising or chrome rather than content. */
const AD_HINTS = ['advert', 'ad-slot', 'adslot', 'sponsor', 'promo', 'banner', 'cookie', 'consent', 'newsletter', 'paywall', 'taboola', 'outbrain'];

const DEFAULT_MAX_CHARS = 12000;

function keepAttribute(name) {
  if (KEEP_ATTRS.has(name)) return true;
  if (name.startsWith('data-')) return true;
  if (name.startsWith('aria-')) return true;
  return false;
}

/** True when an element's id/class/role smells like an ad or consent banner. */
export function looksLikeAd(element) {
  const haystack = [
    element.getAttribute('id') || '',
    element.getAttribute('class') || '',
    element.getAttribute('data-testid') || '',
  ].join(' ').toLowerCase();
  if (!haystack.trim()) return false;
  return AD_HINTS.some((hint) => haystack.includes(hint));
}

/** Collapses a long, volatile class list so it stays readable in the prompt. */
function trimClassList(value) {
  const classes = value.split(/\s+/).filter(Boolean);
  // Hashed build classes (e.g. "css-1x7f2q9", "yf-8m2k1") carry no signal.
  const meaningful = classes.filter((name) => !/^[a-z]{1,4}-?[a-z0-9]{6,}$/i.test(name) || /[-_](price|quote|change|volume|symbol|ticker|last)/i.test(name));
  return (meaningful.length ? meaningful : classes).slice(0, 6).join(' ');
}

/**
 * Sanitizes `root` in place-ish (it mutates the passed tree, so hand it a
 * parsed copy) and returns { html, removed, truncated, chars }.
 */
export function sanitizeSnippet(root, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  if (!root) return { html: '', removed: 0, truncated: false, chars: 0 };
  let removed = 0;

  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 0x1 /* SHOW_ELEMENT */);
  const doomed = [];
  let node = walker.currentNode;
  while (node) {
    const tag = node.tagName.toLowerCase();
    if (DROP_TAGS.has(tag) || looksLikeAd(node)) doomed.push(node);
    node = walker.nextNode();
  }
  for (const element of doomed) {
    if (element.parentNode) {
      element.remove();
      removed++;
    }
  }

  for (const element of root.querySelectorAll('*')) {
    for (const attribute of Array.from(element.attributes)) {
      if (!keepAttribute(attribute.name)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (attribute.name === 'class') {
        const trimmed = trimClassList(attribute.value);
        if (trimmed) element.setAttribute('class', trimmed);
        else element.removeAttribute('class');
      } else if (attribute.value.length > 120) {
        element.setAttribute(attribute.name, `${attribute.value.slice(0, 120)}…`);
      }
    }
  }

  let html = (root.innerHTML || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\s{2,}/g, ' ').trim();
  const truncated = html.length > maxChars;
  if (truncated) html = `${html.slice(0, maxChars)}\n<!-- truncated -->`;
  return { html, removed, truncated, chars: html.length };
}
