/**
 * A price series as an inline SVG, built by hand.
 *
 * A chart library would be the only dependency in the project, for a shape that
 * is one `polyline`. It stays hand-rolled for the same reason the zip writer
 * and the icon generator do.
 *
 * `price_history` arrives newest-first and holds at most 60 points, so it is
 * reversed here and never sampled down.
 */

const NS = 'http://www.w3.org/2000/svg';

const svgEl = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

/**
 * Below this, a line chart is a lie: two points draw a confident straight
 * trend out of a single move. It is the same floor `targets.js` uses before it
 * will anchor on scan history, and for the same reason.
 */
export const MIN_CHART_POINTS = 4;

/** The prices in a stored series, oldest first. */
export function seriesOf(points) {
  return (Array.isArray(points) ? points : [])
    .map((point) => (point && Number.isFinite(point.price) ? point.price : null))
    .filter((price) => price !== null)
    .reverse(); // stored newest-first; time runs left to right
}

/**
 * Draws `points` into a fixed-viewBox SVG that scales with its container.
 *
 * Returns null when there is not enough series to be honest about. Callers
 * render their own placeholder rather than an empty chart frame.
 *
 * The SVG is `aria-hidden`: colour is the only thing it encodes, and colour is
 * never allowed to be the only carrier of a fact. The card states the same
 * trend in text — a signed change and the range beneath it — and that text is
 * what a screen reader and a monochrome display get.
 */
export function sparkline(points, { width = 220, height = 44, direction = 'flat' } = {}) {
  const prices = seriesOf(points);
  if (prices.length < MIN_CHART_POINTS) return null;

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  // A perfectly flat series would divide by zero; draw it down the middle.
  const span = max - min || 1;
  const pad = 3;
  const usable = height - pad * 2;

  const coords = prices.map((price, index) => {
    const x = (index / (prices.length - 1)) * width;
    const y = pad + (1 - (price - min) / span) * usable;
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
  });

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    class: 'spark',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  svg.dataset.direction = direction;

  const line = coords.map(([x, y]) => `${x},${y}`).join(' ');
  // The fill is the same path closed along the floor, which keeps the two in
  // step without computing the geometry twice.
  svg.append(
    svgEl('polygon', { class: 'spark-fill', points: `0,${height} ${line} ${width},${height}` }),
    svgEl('polyline', { class: 'spark-line', points: line }),
    svgEl('circle', { class: 'spark-head', cx: coords[coords.length - 1][0], cy: coords[coords.length - 1][1], r: 2.5 })
  );
  return svg;
}
