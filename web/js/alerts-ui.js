/**
 * The alert surfaces: the feed, the per-ticker rule editor, and the toasts.
 *
 * Split out of `render.js` because it is a self-contained slice of the page and
 * that file was already the largest thing here.
 *
 * The same no-markup rule applies: every string that came from a scraped page
 * or from a rule the user typed goes in through `textContent`.
 */
import { el, append, relativeTime } from './render.js';
import { describeRule, RULE_KINDS, BASELINES } from '../vendor/lib/alerts.js';

/* ------------------------------------------------------------------ *
 * Monitoring
 * ------------------------------------------------------------------ */

const INTERVALS = [5, 15, 30, 60, 240];

/**
 * The background-monitoring control.
 *
 * States what it will actually do, because "monitoring: on" is not enough
 * information to consent to — it fetches pages on a timer, and that is worth
 * saying out loud next to the switch that starts it.
 */
export function monitorControl({ settings, onToggle, onInterval }) {
  const enabled = Boolean(settings && settings.monitorEnabled);
  const minutes = (settings && settings.monitorIntervalMinutes) || 15;

  const toggle = el('input', {
    type: 'checkbox', id: 'monitor-enabled',
    onChange: (event) => onToggle(event.target.checked),
  });
  toggle.checked = enabled;

  const select = el('select', {
    id: 'monitor-interval', 'aria-label': 'How often to check',
    disabled: !enabled,
    onChange: (event) => onInterval(Number(event.target.value)),
  }, INTERVALS.map((value) => el('option', {
    value: String(value),
    text: value < 60 ? `every ${value} min` : `every ${value / 60} hr`,
  })));
  select.value = String(INTERVALS.includes(minutes) ? minutes : 15);

  return el('div.card.monitor-card',
    el('div.monitor-head',
      el('label.monitor-switch', { for: 'monitor-enabled' }, toggle,
        el('span', { text: 'Check prices in the background' })),
      select),
    el('p.muted.small', {
      text: enabled
        ? 'The extension re-reads each monitored ticker on this schedule, even with this page closed, and alerts you when a rule fires.'
        : 'Off. Nothing is fetched unless you press Refresh prices yourself.',
    }));
}

/* ------------------------------------------------------------------ *
 * The feed
 * ------------------------------------------------------------------ */

export function alertFeed({ alerts, onSelect, onMarkSeen, onClear }) {
  if (!alerts.length) return null;
  const unseen = alerts.filter((alert) => !alert.seen).length;

  return el('section.feed',
    el('div.feed-head',
      el('h2.label', { text: unseen ? `Alerts · ${unseen} new` : 'Alerts' }),
      el('div.row',
        unseen
          ? el('button.btn.small', { type: 'button', text: 'Mark all read', onClick: onMarkSeen })
          : null,
        el('button.btn.small', { type: 'button', text: 'Clear', onClick: onClear }))),
    el('ul.plain.feed-list', alerts.slice(0, 30).map((alert) => alertRow(alert, onSelect))));
}

function alertRow(alert, onSelect) {
  return el('li.alert-row', {
    dataset: { seen: alert.seen ? 'true' : 'false', direction: alert.direction || 'flat' },
    tabindex: '0',
    role: 'button',
    onClick: () => onSelect(alert.ticker),
    onKeydown: (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onSelect(alert.ticker);
    },
  },
  el('div.alert-body',
    el('strong.alert-title', { text: alert.title }),
    el('span.muted.small', { text: alert.body })),
  el('span.muted.small.alert-when', { text: relativeTime(alert.at) }));
}

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

const KIND_LABELS = {
  target: 'Buy / sell target',
  percent: 'Percent move',
  level: 'Price level',
  advice_flip: 'Recommendation changes',
};

export function ruleSection(ticker, rules, { onSave, onDelete }) {
  return el('section.drawer-section',
    el('h3', { text: 'Alert me when it…' }),
    rules.length
      ? el('ul.plain.small', rules.map((rule) => ruleRow(rule, onDelete)))
      : el('p.muted.small', { text: 'No rules yet. Nothing will alert on this ticker.' }),
    ruleForm(ticker, onSave));
}

function ruleRow(rule, onDelete) {
  return el('li.rule-row',
    el('span', { text: describeRule(rule) }),
    el('button.icon-btn.plain-icon.remove', {
      type: 'button', text: '×', 'aria-label': `Delete this rule`,
      onClick: () => onDelete(rule),
    }));
}

/**
 * The add-a-rule form.
 *
 * Each kind needs different fields, so the irrelevant ones are removed rather
 * than disabled — a greyed-out box still reads as something you were meant to
 * fill in.
 */
function ruleForm(ticker, onSave) {
  const kind = el('select', { id: `rule-kind-${ticker}`, 'aria-label': 'Rule type' },
    RULE_KINDS.map((value) => el('option', { value, text: KIND_LABELS[value] })));

  const fields = el('div.rule-fields');
  const form = el('form.rule-form', {
    onSubmit: (event) => {
      event.preventDefault();
      const payload = { ticker, kind: kind.value };
      for (const input of fields.querySelectorAll('[data-field]')) {
        payload[input.dataset.field] = input.value;
      }
      onSave(payload);
      kind.value = 'target';
      renderFields();
    },
  }, kind, fields, el('button.btn.small', { type: 'submit', text: 'Add' }));

  function renderFields() {
    fields.replaceChildren();
    if (kind.value === 'percent') {
      append(fields,
        numberField('threshold', '5', 'Percent', ticker, { min: '0.1', step: '0.1' }),
        choiceField('direction', ['both', 'up', 'down'], 'Direction', ticker),
        choiceField('baseline', BASELINES, 'Measured from', ticker));
    } else if (kind.value === 'level') {
      append(fields,
        choiceField('comparator', ['above', 'below'], 'When it goes', ticker),
        numberField('price', '240', 'Price', ticker, { min: '0.01', step: '0.01' }));
    }
  }

  kind.addEventListener('change', renderFields);
  renderFields();
  return form;
}

function numberField(field, placeholder, label, ticker, attrs = {}) {
  return el('input', {
    type: 'number', placeholder, 'aria-label': label, required: true,
    id: `rule-${field}-${ticker}`, dataset: { field }, ...attrs,
  });
}

const CHOICE_LABELS = {
  both: 'either way',
  up: 'up',
  down: 'down',
  above: 'above',
  below: 'below',
  previous_scan: 'the previous reading',
  session_open: 'the oldest reading held',
  avg_cost: 'your average cost',
  last_alert: 'the last alert',
};

function choiceField(field, values, label, ticker) {
  return el('select', {
    'aria-label': label, id: `rule-${field}-${ticker}`, dataset: { field },
  }, values.map((value) => el('option', { value, text: CHOICE_LABELS[value] || value })));
}

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

/**
 * Shows newly arrived alerts in the corner, and as a real OS notification when
 * the page is a website and has been given permission.
 *
 * Inside the extension the service worker has already raised a proper
 * notification, so doing it again here would double every alert.
 */
export function toaster({ container, isExtensionPage }) {
  const shown = new Set();

  return function show(alerts) {
    for (const alert of alerts) {
      if (shown.has(alert.id)) continue;
      shown.add(alert.id);

      const toast = el('div.toast', { dataset: { direction: alert.direction || 'flat' }, role: 'status' },
        el('strong', { text: alert.title }),
        el('span.small.muted', { text: alert.body }));
      container.append(toast);
      setTimeout(() => toast.remove(), 9000);

      if (isExtensionPage || document.visibilityState === 'visible') continue;
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(alert.title, { body: alert.body, tag: alert.id });
        }
      } catch {
        // Some browsers throw on construction in an unsupported context.
      }
    }
  };
}

/** Asks for web-notification permission, from a click. */
export function requestWebNotifications() {
  if (typeof Notification === 'undefined') return Promise.resolve('unsupported');
  return Notification.requestPermission();
}
