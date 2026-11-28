import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron';
import { InvalidOperationError, type PageLoader } from '@assetforge/core';
import { SITE_DETAIL_CONCURRENCY, SITE_PAGE_TIMEOUT_MS, type SiteProfile } from '@assetforge/contracts';
import { sessionRequestOptions, type SessionNetRequest, type SessionRequestOptions } from './session-request.js';
import { createLoginWindow, loadLoginPage } from './site-login-window.js';
import { createPageLoader, PAGE_TIMING, type PageTiming } from './site-page-loader.js';
import { createPageView } from './site-page-window.js';
import { createPagePool } from './site-page-pool.js';
import { createHostVetter, type HostResolver } from './site-request-filter.js';
import { harden } from './site-session-hardening.js';
import { prepareWindow, windowOptions } from './site-window-options.js';

// The browser sessions of the site profiles (spec "Browser sessions"). Everything that decides something is a pure
// function in the neighbouring site-* files and tested as such; the Electron glue only wires those functions to a
// session and its windows. Electron is imported as types only: the session factory and the window constructor are
// injected, so this module also loads under ELECTRON_RUN_AS_NODE. Nothing here logs a URL or a cookie.

/**
 * The partition of a profile's session; Chromium keeps its cookies under `userData`.
 *
 * @param profileId the profile
 * @returns the persistent partition name
 */
export const sitePartition = (profileId: string): string => `persist:site-${profileId}`;

/** The sessions and windows of the site profiles, as the store and the handlers see them. */
export interface SiteSessions {
  /** Opens the visible login window of `profile` on `url`; the caller makes sure none is open. */
  openLogin(profile: SiteProfile, url: string): void;
  /** The profile whose login window is open, else null. */
  loginProfileId(): string | null;
  focusLogin(): void;
  /**
   * Independent hidden page windows for one crawl, bounded by its profile. `close` destroys them all and may be
   * called more than once. `onGone` is called once when the pool goes away, so the crawl can end.
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

/** The message of a window or request asked for after `shutdown`. */
const NO_WINDOWS = 'Site logins are not available';

/** What `createElectronSiteSessions` is wired with. */
export interface ElectronSiteSessionsDependencies {
  /** Electron's `session.fromPartition`. */
  fromPartition(partition: string): Session;
  /** Electron's `BrowserWindow` constructor. */
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  /** Resolves the hosts the request filter vets; defaults to the system resolver. */
  resolve?: HostResolver;
  /** One line with at most a profile id and a fixed code. */
  log?: (line: string) => void;
  /** The page loader's timing; defaults to `PAGE_TIMING`. */
  timing?: PageTiming;
  /** Electron's `net.request`; without it the sessions offer no `request`. */
  netRequest?: (options: SessionRequestOptions) => SessionNetRequest;
}

/** The state of the Electron sessions: what was hardened, which windows are open, and whether they ended. */
interface SessionsState {
  readonly dependencies: ElectronSiteSessionsDependencies;
  readonly timing: PageTiming;
  /** The partitions whose session was hardened. */
  readonly hardened: Set<string>;
  /** The open login window, at most one. */
  login: { profileId: string; window: BrowserWindow } | null;
  /** The open page windows. */
  readonly pages: Set<BrowserWindow>;
  /** The ids of the page windows' contents, for the request filter. */
  readonly pageContents: Set<number>;
  isShutDown: boolean;
}

/**
 * The Electron side of SiteSessions.
 *
 * @param dependencies the session factory, the window constructor and the optional resolver, log, timing and request
 * @returns the sessions of the site profiles
 */
export function createElectronSiteSessions(dependencies: ElectronSiteSessionsDependencies): ElectronSiteSessions {
  const state: SessionsState = {
    dependencies,
    timing: dependencies.timing ?? PAGE_TIMING,
    hardened: new Set(),
    login: null,
    pages: new Set(),
    pageContents: new Set(),
    isShutDown: false,
  };
  const request = sessionRequestOf(state);
  return {
    ...(request === undefined ? {} : { request }),
    openLogin: (profile, url) => openLogin(state, profile, url),
    loginProfileId: () => state.login?.profileId ?? null,
    focusLogin: () => focusLogin(state),
    openPage: (profile, onGone) =>
      createPagePool(
        (gone) => openPage(state, profile, gone),
        profile.detailConcurrency ?? SITE_DETAIL_CONCURRENCY.default,
        onGone,
      ),
    shutdown: () => shutdown(state),
    cookies: (profileId, url) => sessionCookies(state, profileId, url),
    userAgent: (profileId) => sessionOf(state, profileId).getUserAgent(),
    clear: (profileId) => clearSession(state, profileId),
  };
}

/**
 * Refuses a window or a request once the sessions ended.
 *
 * @param state the sessions' state
 * @throws InvalidOperationError after `shutdown`
 */
function refuseAfterShutdown(state: SessionsState): void {
  if (state.isShutDown) throw new InvalidOperationError(NO_WINDOWS);
}

/**
 * Destroys a window unless it is gone already.
 *
 * @param window the window
 */
function destroyWindow(window: BrowserWindow): void {
  if (!window.isDestroyed()) window.destroy();
}

/**
 * The session of a profile, hardened on first use.
 *
 * @param state the sessions' state
 * @param profileId the profile
 * @returns the session of the profile's partition
 */
function sessionOf(state: SessionsState, profileId: string): Session {
  const partition = sitePartition(profileId);
  const session = state.dependencies.fromPartition(partition);
  if (!state.hardened.has(partition)) {
    state.hardened.add(partition);
    harden(session, createHostVetter(state.dependencies.resolve), (contentsId) => state.pageContents.has(contentsId));
  }
  return session;
}

/**
 * The session request of the sessions, when Electron's `net.request` was given.
 *
 * @param state the sessions' state
 * @returns `SiteSessions.request`; undefined without `netRequest`
 */
function sessionRequestOf(state: SessionsState): SiteSessions['request'] {
  const netRequest = state.dependencies.netRequest;
  if (netRequest === undefined) return undefined;
  return (profileId: string, url: string): SessionNetRequest => {
    refuseAfterShutdown(state);
    return netRequest(sessionRequestOptions(sessionOf(state, profileId), url));
  };
}

/**
 * Opens the login window of a profile. It counts as open before it loads, and stops counting once it closed.
 *
 * @param state the sessions' state
 * @param profile the profile
 * @param url the page to open
 * @throws InvalidOperationError after `shutdown`
 */
function openLogin(state: SessionsState, profile: SiteProfile, url: string): void {
  refuseAfterShutdown(state);
  const session = sessionOf(state, profile.id);
  const window = createLoginWindow(state.dependencies.createWindow, session, profile, url);
  const entry = { profileId: profile.id, window };
  state.login = entry;
  window.on('closed', () => {
    if (state.login === entry) state.login = null;
  });
  loadLoginPage(window.webContents, url);
}

/**
 * Brings the login window to the front, if one is open.
 *
 * @param state the sessions' state
 */
function focusLogin(state: SessionsState): void {
  const login = state.login;
  if (login === null || login.window.isDestroyed()) return;
  if (login.window.isMinimized()) login.window.restore();
  login.window.focus();
}

/**
 * Opens a hidden page window for one crawl. Its contents count as a page for the request filter until it closed.
 *
 * @param state the sessions' state
 * @param profile the profile whose site the window stays on
 * @param onGone called once when the window goes away
 * @returns the page loader and the close of the window
 * @throws InvalidOperationError after `shutdown`
 */
function openPage(
  state: SessionsState,
  profile: SiteProfile,
  onGone: (() => void) | undefined,
): { loader: PageLoader; close(): void } {
  refuseAfterShutdown(state);
  const session = sessionOf(state, profile.id);
  const window = state.dependencies.createWindow(windowOptions(session, false, profile.name));
  prepareWindow(window);
  state.pages.add(window);
  const contentsId = window.webContents.id;
  state.pageContents.add(contentsId);
  window.on('closed', () => {
    state.pages.delete(window);
    state.pageContents.delete(contentsId);
    onGone?.();
  });
  const view = createPageView(window, profile.site);
  return {
    loader: createPageLoader(view, profile.site, {
      ...state.timing,
      totalMs:
        profile.pageTimeoutMs ??
        (state.dependencies.timing === undefined ? SITE_PAGE_TIMEOUT_MS.default : state.timing.totalMs),
    }),
    close: () => destroyWindow(window),
  };
}

/**
 * Ends the sessions: destroys the login window and every page window, and opens none afterwards.
 *
 * @param state the sessions' state
 */
function shutdown(state: SessionsState): void {
  state.isShutDown = true;
  const open = state.login;
  state.login = null;
  if (open !== null) destroyWindow(open.window);
  for (const window of [...state.pages]) destroyWindow(window);
}

/**
 * The cookies a profile's session would send to a URL.
 *
 * @param state the sessions' state
 * @param profileId the profile
 * @param url the URL
 * @returns name and value of each cookie
 */
async function sessionCookies(
  state: SessionsState,
  profileId: string,
  url: string,
): Promise<{ name: string; value: string }[]> {
  const cookies = await sessionOf(state, profileId).cookies.get({ url });
  return cookies.map((cookie) => ({ name: cookie.name, value: cookie.value }));
}

/**
 * Clears the stored data of a profile's session. Each clear is tried on its own; one log line however many failed.
 *
 * @param state the sessions' state
 * @param profileId the profile
 * @returns resolves when every clear was tried; never rejects for a failed clear
 */
async function clearSession(state: SessionsState, profileId: string): Promise<void> {
  const session = sessionOf(state, profileId);
  let isFailed = false;
  for (const step of [() => session.clearStorageData(), () => session.clearCache(), () => session.clearAuthCache()]) {
    try {
      await step();
    } catch {
      isFailed = true;
    }
  }
  if (isFailed) state.dependencies.log?.(`site profile ${profileId}: session_clear_failed`);
}
