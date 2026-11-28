import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron';
import { InvalidOperationError, type PageLoader } from '@assetforge/core';
import type { SiteProfile } from '@assetforge/contracts';
import { sessionRequestOptions, type SessionNetRequest, type SessionRequestOptions } from './session-request.js';
import { loginNavigationAllowed, loginTitle } from './site-login-window.js';
import { createPageLoader, pageNavigationAllowed, PAGE_TIMING, type PageTiming, type PageView } from './site-page-loader.js';
import { ISOLATED_WORLD_ID } from './site-extraction.js';
import { createHostVetter, type HostResolver } from './site-request-filter.js';
import { harden } from './site-session-hardening.js';
import { prepareWindow, windowOptions } from './site-window-options.js';

// The browser sessions of the site profiles (spec "Browser sessions"). Everything that decides something is a pure
// function here and tested as such; the Electron glue only wires those functions to a session and its windows.
// Electron is imported as types only: the session factory and the window constructor are injected, so this module
// also loads under ELECTRON_RUN_AS_NODE. Nothing here logs a URL or a cookie.

/** The partition of a profile's session; Chromium keeps its cookies under `userData`. */
export const sitePartition = (profileId: string): string => `persist:site-${profileId}`;

/** The sessions and windows of the site profiles, as the store and the handlers see them. */
export interface SiteSessions {
  /** Opens the visible login window of `profile` on `url`; the caller makes sure none is open. */
  openLogin(profile: SiteProfile, url: string): void;
  /** The profile whose login window is open, else null. */
  loginProfileId(): string | null;
  focusLogin(): void;
  /**
   * A hidden page window for one crawl; `close` destroys it and may be called more than once. `onGone` is called
   * once when the window goes away, whoever destroyed it, so the crawl can end.
   */
  openPage(profile: SiteProfile, onGone?: () => void): { loader: PageLoader; close(): void };
  /** The cookies the profile's session would send to `url`. */
  cookies(profileId: string, url: string): Promise<{ name: string; value: string }[]>;
  userAgent(profileId: string): string;
  /** Clears the stored data of the profile's session (cookies, storage, cache, HTTP auth). */
  clear(profileId: string): Promise<void>;
  /**
   * Starts one GET of `url` through the profile's hardened session: the session's cookies and user agent, no
   * Referer, no cache, redirects not followed (spec "Browser check"). Absent where no browser session exists.
   */
  request?(profileId: string, url: string): SessionNetRequest;
}

/** The Electron sessions, which also end with the app. */
export interface ElectronSiteSessions extends SiteSessions {
  /**
   * Destroys the login window and every page window (each crawl is told through its `onGone`, which aborts it) and
   * opens no window afterwards. Called when the main window is closed and when quitting begins: these windows would
   * otherwise keep the process, and its single-instance lock, alive. May be called more than once.
   */
  shutdown(): void;
}

const NO_WINDOWS = 'Site logins are not available';

export interface ElectronSiteSessionsDeps {
  fromPartition(partition: string): Session;
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  resolve?: HostResolver;
  /** One line with at most a profile id and a fixed code. */
  log?: (line: string) => void;
  timing?: PageTiming;
  /** Electron's `net.request`; without it the sessions offer no `request`. */
  netRequest?: (options: SessionRequestOptions) => SessionNetRequest;
}

/** Whether a failed `loadURL` was only replaced by another navigation (Chromium's ERR_ABORTED). */
function isAborted(error: unknown): boolean {
  const e = error as { code?: unknown; errno?: unknown } | null;
  return e?.code === 'ERR_ABORTED' || e?.errno === -3;
}

/** The Electron side of SiteSessions. */
export function createElectronSiteSessions(deps: ElectronSiteSessionsDeps): ElectronSiteSessions {
  const hardened = new Set<string>();
  const timing = deps.timing ?? PAGE_TIMING;
  let login: { profileId: string; window: BrowserWindow } | null = null;
  const pages = new Set<BrowserWindow>();
  /** The ids of the page windows' contents, for the request filter. */
  const pageContents = new Set<number>();
  let shutDown = false;
  const refuseAfterShutdown = (): void => {
    if (shutDown) throw new InvalidOperationError(NO_WINDOWS);
  };
  const destroy = (window: BrowserWindow): void => {
    if (!window.isDestroyed()) window.destroy();
  };

  const sessionOf = (profileId: string): Session => {
    const partition = sitePartition(profileId);
    const session = deps.fromPartition(partition);
    if (!hardened.has(partition)) {
      hardened.add(partition);
      harden(session, createHostVetter(deps.resolve), (contentsId) => pageContents.has(contentsId));
    }
    return session;
  };

  const netRequest = deps.netRequest;
  const request =
    netRequest === undefined
      ? undefined
      : (profileId: string, url: string): SessionNetRequest => {
          refuseAfterShutdown();
          return netRequest(sessionRequestOptions(sessionOf(profileId), url));
        };

  return {
    ...(request === undefined ? {} : { request }),
    openLogin(profile, url) {
      refuseAfterShutdown();
      const session = sessionOf(profile.id);
      const window = deps.createWindow(windowOptions(session, true, loginTitle(profile.name, url)));
      prepareWindow(window);
      const contents = window.webContents;
      const guard = (event: { url: string; isMainFrame?: boolean; preventDefault(): void }) => {
        if (!loginNavigationAllowed(event.url)) event.preventDefault();
      };
      contents.on('will-navigate', guard);
      contents.on('will-redirect', guard);
      contents.setWindowOpenHandler(({ url: target }) => {
        if (loginNavigationAllowed(target)) contents.loadURL(target).catch(() => {});
        return { action: 'deny' };
      });
      // Page titles never replace the profile name and host.
      window.on('page-title-updated', (event) => event.preventDefault());
      const retitle = (_event: unknown, current: string) => {
        if (!window.isDestroyed()) window.setTitle(loginTitle(profile.name, current));
      };
      contents.on('did-navigate', retitle);
      contents.on('did-navigate-in-page', retitle);
      const entry = { profileId: profile.id, window };
      login = entry;
      window.on('closed', () => {
        if (login === entry) login = null;
      });
      contents.loadURL(url).catch(() => {
        // The window shows Chromium's error page; nothing to report.
      });
    },
    loginProfileId: () => login?.profileId ?? null,
    focusLogin() {
      if (login === null || login.window.isDestroyed()) return;
      if (login.window.isMinimized()) login.window.restore();
      login.window.focus();
    },
    openPage(profile, onGone) {
      refuseAfterShutdown();
      const session = sessionOf(profile.id);
      const window = deps.createWindow(windowOptions(session, false, profile.name));
      prepareWindow(window);
      pages.add(window);
      const contents = window.webContents;
      const contentsId = contents.id;
      pageContents.add(contentsId);
      window.on('closed', () => {
        pages.delete(window);
        pageContents.delete(contentsId);
        onGone?.();
      });
      const leftListeners: ((url: string) => void)[] = [];
      const responseListeners: ((status: number) => void)[] = [];
      const guard = (event: { url: string; isMainFrame?: boolean; preventDefault(): void }) => {
        if (event.isMainFrame === false || pageNavigationAllowed(event.url, profile.site)) return;
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
      const view: PageView = {
        navigate: (url, onParsed) => {
          // `dom-ready` counts only after a main-frame document was committed since this call, so the page that
          // is being replaced cannot stand in for the new one.
          let committed = false;
          const onCommit = () => {
            committed = true;
          };
          const onReady = () => {
            if (committed) onParsed?.();
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
        },
        evaluate: (code) => contents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code }]),
        stop: () => {
          if (!contents.isDestroyed()) contents.stop();
        },
        onLeftSite: (listener) => leftListeners.push(listener),
        onResponse: (listener) => responseListeners.push(listener),
      };
      return {
        loader: createPageLoader(view, profile.site, timing),
        close: () => destroy(window),
      };
    },
    shutdown() {
      shutDown = true;
      const open = login;
      login = null;
      if (open !== null) destroy(open.window);
      for (const window of [...pages]) destroy(window);
    },
    async cookies(profileId, url) {
      const cookies = await sessionOf(profileId).cookies.get({ url });
      return cookies.map((c) => ({ name: c.name, value: c.value }));
    },
    userAgent: (profileId) => sessionOf(profileId).getUserAgent(),
    async clear(profileId) {
      const session = sessionOf(profileId);
      // Each clear is tried on its own; one line however many failed.
      let failed = false;
      for (const step of [() => session.clearStorageData(), () => session.clearCache(), () => session.clearAuthCache()]) {
        try {
          await step();
        } catch {
          failed = true;
        }
      }
      if (failed) deps.log?.(`site profile ${profileId}: session_clear_failed`);
    },
  };
}
