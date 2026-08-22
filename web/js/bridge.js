/**
 * The dashboard's transport.
 *
 * The same page is served two ways, and the only difference between them is how
 * a message reaches the service worker:
 *
 *   chrome-extension://<id>/web/index.html   an extension page. `chrome.runtime`
 *                                            is fully wired, messages need no
 *                                            recipient, and `storage.onChanged`
 *                                            gives free live updates.
 *
 *   http://localhost:8080/                   a web page on an origin listed in
 *                                            the manifest's
 *                                            `externally_connectable.matches`.
 *                                            Chrome exposes a stub `chrome.runtime`
 *                                            there, but every message must name
 *                                            the extension id, and there is no
 *                                            storage event to listen to — so this
 *                                            mode polls.
 *
 * Everything above this module calls `request()` and `subscribe()` and never
 * learns which mode it is in.
 */

/** How often the website build re-reads state, absent a storage event. */
const POLL_MS = 15000;

const EXT_ID_KEY = 'market-dashboard.extension-id';

const runtime = (typeof chrome !== 'undefined' && chrome && chrome.runtime) || null;

/**
 * True when this page *is* the extension.
 *
 * `chrome.runtime.id` is present in both modes, so it cannot be the test. The
 * distinguishing fact is the scheme: only an extension page is served from
 * `chrome-extension:`, and only there does `chrome.storage` exist.
 */
export const isExtensionPage = Boolean(
  runtime && typeof chrome.storage !== 'undefined' && location.protocol === 'chrome-extension:'
);

/**
 * The extension to talk to, when this is a website.
 *
 * Resolved from `?ext=` first so the options page can hand the id over in a
 * link and nobody has to copy one out of chrome://extensions by hand. It is
 * remembered afterwards, so the query string is needed exactly once.
 */
// Declared before the functions that assign to it. `resolveExtensionId` calls
// `rememberExtensionId`, so initialising this from the call would write to the
// binding while it is still in its temporal dead zone — a ReferenceError that
// only fires on the one path that matters, the first visit carrying `?ext=`.
let extensionId = null;

function resolveExtensionId() {
  if (isExtensionPage) return runtime.id;
  let stored = null;
  try {
    stored = localStorage.getItem(EXT_ID_KEY);
  } catch {
    // Private mode, or storage blocked. Fall through to the query string.
  }
  const fromQuery = new URLSearchParams(location.search).get('ext');
  if (fromQuery && /^[a-p]{32}$/.test(fromQuery)) {
    rememberExtensionId(fromQuery);
    return fromQuery;
  }
  return stored;
}

export function rememberExtensionId(id) {
  try {
    localStorage.setItem(EXT_ID_KEY, id);
  } catch {
    // Not being able to remember it is survivable; the link still works.
  }
  extensionId = id;
}

export function forgetExtensionId() {
  try {
    localStorage.removeItem(EXT_ID_KEY);
  } catch {
    // Nothing to do.
  }
  extensionId = null;
}

extensionId = resolveExtensionId();

export const getExtensionId = () => extensionId;

/** Distinguishes "no extension configured" from "the call itself failed". */
export class NotConnectedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotConnectedError';
  }
}

/**
 * Sends one message and unwraps the worker's `{ok, data}` envelope.
 *
 * Mirrors `request()` in the popup, with the extension id threaded through on
 * the website path and `lastError` read before anything else — leaving it
 * unread logs a spurious "Unchecked runtime.lastError" in the console.
 */
export function request(type, payload) {
  return new Promise((resolve, reject) => {
    if (!runtime || !runtime.sendMessage) {
      reject(new NotConnectedError(
        'This browser has no extension bridge. Open the dashboard from the extension, or install it first.'
      ));
      return;
    }
    if (!isExtensionPage && !extensionId) {
      reject(new NotConnectedError('No extension connected yet.'));
      return;
    }

    const done = (response) => {
      if (chrome.runtime.lastError) {
        reject(new NotConnectedError(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new NotConnectedError(
          'The extension did not answer. It may be disabled, updating, or not installed.'
        ));
        return;
      }
      if (!response.ok) {
        reject(new Error(response.error || 'Unknown error'));
        return;
      }
      resolve(response.data);
    };

    try {
      if (isExtensionPage) runtime.sendMessage({ type, payload }, done);
      else runtime.sendMessage(extensionId, { type, payload }, done);
    } catch (error) {
      reject(new NotConnectedError(String((error && error.message) || error)));
    }
  });
}

/**
 * Asks the user to grant the extension access to some origins.
 *
 * Deliberately not a message to the worker. `chrome.permissions.request()` only
 * works from an extension page inside a real user gesture: a service worker has
 * no gesture to inherit, and a web page cannot supply one on the extension's
 * behalf. So the in-extension dashboard asks directly, and the website build
 * cannot ask at all — it says so instead of failing silently.
 *
 * Must be called synchronously from a click handler; an `await` before this
 * point spends the gesture.
 */
export function requestHostAccess(origins) {
  if (!isExtensionPage) {
    return Promise.reject(new NotConnectedError(
      'Site access can only be granted from the dashboard inside the extension. '
      + 'Open the extension\'s options page and press "Open dashboard" there.'
    ));
  }
  return chrome.permissions.request({ origins });
}

/**
 * Calls `onChange` whenever the extension's stored state may have moved.
 *
 * Inside the extension that is an event. On a website it is a poll, because
 * `chrome.storage` is not exposed across the external boundary. Either way the
 * caller gets a nudge and re-reads; neither path pushes data.
 *
 * Returns an unsubscribe function.
 */
export function subscribe(onChange) {
  if (isExtensionPage && chrome.storage && chrome.storage.onChanged) {
    const listener = (_changes, areaName) => {
      if (areaName === 'local') onChange('storage');
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  const timer = setInterval(() => onChange('poll'), POLL_MS);
  // A tab that has been in the background for an hour should not render an
  // hour-old price the moment it is looked at again.
  const onVisible = () => {
    if (document.visibilityState === 'visible') onChange('visible');
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
