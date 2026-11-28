import type { BrowserWindow, WebContents } from 'electron';
import { ISOLATED_WORLD_ID } from './site-extraction.js';
import { pageNavigationAllowed, type PageView } from './site-page-loader.js';
import type { NavigationEvent } from './site-window-options.js';

// The hidden page window of a crawl as a `PageView`: it stays on the profile's site and opens no popup.

/** How a navigation ended, as the page view reports it. */
type NavigationOutcome = 'loaded' | 'aborted' | 'failed';

/**
 * Whether a failed `loadURL` was only replaced by another navigation (Chromium's ERR_ABORTED).
 *
 * @param error what `loadURL` rejected with
 * @returns true for ERR_ABORTED
 */
function isAborted(error: unknown): boolean {
  const failure = error as { code?: unknown; errno?: unknown } | null;
  return failure?.code === 'ERR_ABORTED' || failure?.errno === -3;
}

/**
 * Guards a page window and makes it a page view: a main-frame navigation or redirect off the site is refused and
 * reported, the main frame's status is reported, and every popup is refused.
 *
 * @param window the page window, already prepared
 * @param site the profile's site
 * @returns the page view of the window
 */
export function createPageView(window: BrowserWindow, site: string): PageView {
  const contents = window.webContents;
  const leftListeners: ((url: string) => void)[] = [];
  const responseListeners: ((status: number) => void)[] = [];
  const guard = (event: NavigationEvent) => {
    if (event.isMainFrame === false || pageNavigationAllowed(event.url, site)) return;
    event.preventDefault();
    for (const listener of leftListeners) listener(event.url);
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  // Fired for the main frame only; the code is -1 for an answer that was not HTTP.
  contents.on('did-navigate', (_event, _url, httpResponseCode) => {
    for (const listener of responseListeners) listener(httpResponseCode);
  });
  // A popup is refused and, unlike in the login window, not loaded: the crawl decides where this window goes.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return {
    navigate: (url, onParsed) => navigatePage(contents, url, onParsed),
    evaluate: (code) => contents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code }]),
    currentUrl: () => (contents.isDestroyed() ? '' : contents.getURL()),
    stop: () => {
      if (!contents.isDestroyed()) contents.stop();
    },
    onLeftSite: (listener) => leftListeners.push(listener),
    onResponse: (listener) => responseListeners.push(listener),
  };
}

/**
 * Navigates the page window. `dom-ready` counts only after a main-frame document was committed since this call, so
 * the page that is being replaced cannot stand in for the new one.
 *
 * @param contents the window's contents
 * @param url the page to load
 * @param onParsed called when the new document is parsed
 * @returns how the navigation ended; its listeners are removed by then
 */
function navigatePage(
  contents: WebContents,
  url: string,
  onParsed: (() => void) | undefined,
): Promise<NavigationOutcome> {
  let isCommitted = false;
  const onCommit = () => {
    isCommitted = true;
  };
  const onReady = () => {
    if (isCommitted) onParsed?.();
  };
  contents.on('did-navigate', onCommit);
  contents.on('dom-ready', onReady);
  return contents
    .loadURL(url)
    .then(
      () => 'loaded' as const,
      (error: unknown) => (isAborted(error) ? ('aborted' as const) : ('failed' as const)),
    )
    .finally(() => {
      contents.off('did-navigate', onCommit);
      contents.off('dom-ready', onReady);
    });
}
