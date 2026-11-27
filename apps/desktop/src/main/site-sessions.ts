import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron';
import { z } from 'zod';
import { belongsToSite, type SiteProfile } from '@assetforge/contracts';
import type { PageLoader, PageLoadResult, RemoteRequestHeaders, SiteAccess } from '@assetforge/core';
import { isPublicAddress } from '@assetforge/storage';
import type { SiteProfileStore } from './site-profile-store.js';

// The browser sessions of the site profiles (spec "Browser sessions"). Everything that decides something is a pure
// function here and tested as such; the Electron glue only wires those functions to a session and its windows.
// Electron is imported as types only: the session factory and the window constructor are injected, so this module
// also loads under ELECTRON_RUN_AS_NODE. Nothing here logs a URL or a cookie.

/** The partition of a profile's session; Chromium keeps its cookies under `userData`. */
export const sitePartition = (profileId: string): string => `persist:site-${profileId}`;

/** How a page load waits: poll every `pollMs`, at most `settleMs` after the load finished, `totalMs` in all. */
export interface PageTiming {
  pollMs: number;
  settleMs: number;
  totalMs: number;
}
export const PAGE_TIMING: PageTiming = { pollMs: 250, settleMs: 10_000, totalMs: 30_000 };

/** Most values one query answers, and the longest value. */
export const EXTRACT_LIMITS = { maxResults: 20_000, maxLength: 10_000 };

/** The isolated world the XPath runs in; any id but 0 (the page's own world). */
const ISOLATED_WORLD_ID = 1777;

// ---------------------------------------------------------------------------------------------------------------
// Request filter

export type RequestDecision = 'allow' | 'refuse' | { host: string };

/** Sub-resource types that may be `data:` or `blob:`; a frame never may. */
const FRAME_TYPES = new Set(['mainFrame', 'subFrame']);

/**
 * The first step of the session's request filter: only http/https, plus `data:` and `blob:` for sub-resources. An
 * IP literal is decided at once by `isPublicAddress`; any other host has to be resolved (`{ host }`).
 */
export function requestDecision(url: string, resourceType: string): RequestDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'refuse';
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return FRAME_TYPES.has(resourceType) ? 'refuse' : 'allow';
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'refuse';
  if (parsed.username !== '' || parsed.password !== '') return 'refuse';
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === '') return 'refuse';
  if (isIP(host) !== 0) return isPublicAddress(host) ? 'allow' : 'refuse';
  return { host };
}

export type HostResolver = (host: string) => Promise<string[]>;

const systemResolver: HostResolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/** Hosts one session remembers before it starts over; a page never comes close. */
const HOST_CACHE_MAX = 10_000;

/**
 * Vets a host for a session: allowed only when it resolves to at least one address and every address passes
 * `isPublicAddress`. A verdict is kept for the session's life; a failed resolution refuses and is not kept, so the
 * next request asks again.
 */
export function createHostVetter(resolve: HostResolver = systemResolver): (host: string) => Promise<boolean> {
  const verdicts = new Map<string, Promise<boolean>>();
  return (host) => {
    const known = verdicts.get(host);
    if (known !== undefined) return known;
    if (verdicts.size >= HOST_CACHE_MAX) verdicts.clear();
    const verdict = resolve(host).then(
      (addresses) => addresses.length > 0 && addresses.every((address) => isPublicAddress(address)),
      () => {
        verdicts.delete(host);
        return false;
      },
    );
    verdicts.set(host, verdict);
    return verdict;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Cookies, titles, navigation

/** A cookie value Node would refuse in a header, or one that would split it. */
const UNSAFE_COOKIE = /[\u0000-\u001f\u007f;]/;

/** The `Cookie` header of the cookies a session would send: `name=value` joined by `; `; null without any. */
export function cookieHeader(cookies: readonly { name: string; value: string }[]): string | null {
  const parts = cookies
    .filter((c) => !UNSAFE_COOKIE.test(c.name) && !UNSAFE_COOKIE.test(c.value) && !c.name.includes('='))
    .map((c) => `${c.name}=${c.value}`);
  return parts.length === 0 ? null : parts.join('; ');
}

/** The login window's title: `<profile name> – <current host>`, the name alone without a host. */
export function loginTitle(name: string, url: string): string {
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    // Keep the name alone.
  }
  return host === '' ? name : `${name} – ${host}`;
}

/** The page window goes only where the profile's site is. */
export const pageNavigationAllowed = (url: string, site: string): boolean => belongsToSite(url, site);

/** The login window goes to any http/https URL; the request filter keeps it to public hosts. */
export function loginNavigationAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Extraction

/**
 * Runs in the page's isolated world. Takes its input as one JSON string, never as code: the expressions are data.
 * Answers `{ invalid: name }` for an expression that does not evaluate to nodes, otherwise `{ results, counts }`
 * (the strings per query and the number of nodes it matched). Kept as plain text so no bundler helper ends up in it.
 */
export const EXTRACT_SCRIPT = `function (input) {
  var data = JSON.parse(input);
  var results = {};
  var counts = {};
  var names = Object.keys(data.queries);
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var found;
    try {
      found = document.evaluate(data.queries[name], document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    } catch (error) {
      return { invalid: name };
    }
    var values = [];
    for (var j = 0; j < found.snapshotLength && values.length < data.maxResults; j++) {
      var node = found.snapshotItem(j);
      var value = null;
      if (node.nodeType === 1) {
        if (node.hasAttribute('href')) value = node.getAttribute('href');
        else if (node.hasAttribute('src')) value = node.getAttribute('src');
      } else if (node.nodeType === 2 || node.nodeType === 3) {
        value = node.nodeValue;
      }
      if (typeof value === 'string') values.push(value.slice(0, data.maxLength));
    }
    results[name] = values;
    counts[name] = found.snapshotLength;
  }
  return { results: results, counts: counts };
}`;

/** The code handed to the isolated world: the script applied to its input, the input a JSON string literal. */
export function extractionCode(queries: Record<string, string>, limits = EXTRACT_LIMITS): string {
  const input = JSON.stringify({ queries, maxResults: limits.maxResults, maxLength: limits.maxLength });
  return `(${EXTRACT_SCRIPT})(${JSON.stringify(input)})`;
}

const ExtractionSchema = z.union([
  z.object({ invalid: z.string() }),
  z.object({ results: z.record(z.string(), z.array(z.unknown())), counts: z.record(z.string(), z.number()) }),
]);

export type Extraction =
  | { kind: 'invalid'; query: string }
  | { kind: 'results'; results: Record<string, string[]>; counts: Record<string, number> };

/**
 * Reads what the page answered, trusting none of it: only the names asked for, only strings, cut at the limits
 * again. Null for anything else.
 */
export function readExtraction(raw: unknown, names: readonly string[], limits = EXTRACT_LIMITS): Extraction | null {
  const parsed = ExtractionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;
  if ('invalid' in data) return names.includes(data.invalid) ? { kind: 'invalid', query: data.invalid } : null;
  const results: Record<string, string[]> = {};
  const counts: Record<string, number> = {};
  for (const name of names) {
    const values = Object.hasOwn(data.results, name) ? data.results[name]! : [];
    results[name] = values
      .filter((value): value is string => typeof value === 'string')
      .slice(0, limits.maxResults)
      .map((value) => value.slice(0, limits.maxLength));
    const count = Object.hasOwn(data.counts, name) ? data.counts[name]! : 0;
    counts[name] = Number.isFinite(count) ? count : 0;
  }
  return { kind: 'results', results, counts };
}

// ---------------------------------------------------------------------------------------------------------------
// Page loader

/** A window's page as the loader drives it. */
export interface PageView {
  /** Navigates to `url`; `aborted` when another navigation replaced this one. */
  navigate(url: string): Promise<'loaded' | 'aborted' | 'failed'>;
  /** Runs `code` in the isolated world and answers its value. */
  evaluate(code: string): Promise<unknown>;
  stop(): void;
  /** Called whenever a main-frame navigation or redirect off the site was refused. */
  onLeftSite(listener: () => void): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The PageLoader of one page window (spec "The crawl", step 2). */
export function createPageLoader(view: PageView, site: string, timing: PageTiming = PAGE_TIMING): PageLoader {
  let leftListener: (() => void) | null = null;
  view.onLeftSite(() => leftListener?.());

  return {
    async load(url, r): Promise<PageLoadResult> {
      if (r.signal.aborted) return { ok: false, reason: 'failed' };
      if (!pageNavigationAllowed(url, site)) return { ok: false, reason: 'left_site' };
      const names = Object.keys(r.queries);
      const code = extractionCode(r.queries);

      let settle: (result: PageLoadResult) => void = () => {};
      const ended = new Promise<PageLoadResult>((resolve) => {
        settle = resolve;
      });
      let done = false;
      const finish = (result: PageLoadResult) => {
        if (done) return;
        done = true;
        settle(result);
      };
      const onAbort = () => {
        view.stop();
        finish({ ok: false, reason: 'failed' });
      };
      r.signal.addEventListener('abort', onAbort, { once: true });
      leftListener = () => finish({ ok: false, reason: 'left_site' });
      const overall = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timing.totalMs);

      const run = async () => {
        const loaded = await view.navigate(url);
        if (done) return;
        if (loaded === 'failed') {
          finish({ ok: false, reason: 'failed' });
          return;
        }
        // `aborted`: a navigation within the site replaced the first one; its page is polled the same way.
        const until = Date.now() + timing.settleMs;
        for (;;) {
          let raw: unknown;
          try {
            raw = await view.evaluate(code);
          } catch {
            raw = undefined; // The page was replaced meanwhile; ask again.
          }
          if (done) return;
          const extraction = raw === undefined ? null : readExtraction(raw, names);
          if (extraction?.kind === 'invalid') {
            finish({ ok: false, reason: 'invalid_xpath', query: extraction.query });
            return;
          }
          if (extraction !== null && (extraction.counts[r.waitFor] ?? 0) > 0) {
            finish({ ok: true, results: extraction.results });
            return;
          }
          if (Date.now() >= until) {
            finish({ ok: false, reason: 'timeout' });
            return;
          }
          await sleep(timing.pollMs);
          if (done) return;
        }
      };
      run().catch(() => finish({ ok: false, reason: 'failed' }));

      try {
        return await ended;
      } finally {
        clearTimeout(overall);
        r.signal.removeEventListener('abort', onAbort);
        leftListener = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions

/** The sessions and windows of the site profiles, as the store and the handlers see them. */
export interface SiteSessions {
  /** Opens the visible login window of `profile` on `url`; the caller makes sure none is open. */
  openLogin(profile: SiteProfile, url: string): void;
  /** The profile whose login window is open, else null. */
  loginProfileId(): string | null;
  focusLogin(): void;
  /** A hidden page window for one crawl; `close` destroys it and may be called more than once. */
  openPage(profile: SiteProfile): { loader: PageLoader; close(): void };
  /** The cookies the profile's session would send to `url`. */
  cookies(profileId: string, url: string): Promise<{ name: string; value: string }[]>;
  userAgent(profileId: string): string;
  /** Clears the stored data of the profile's session (cookies, storage, cache). */
  clear(profileId: string): Promise<void>;
}

/** The logins of the profiles for the download path (spec "Download"). */
export function createSiteAccess(store: Pick<SiteProfileStore, 'get'>, sessions: Pick<SiteSessions, 'cookies' | 'userAgent'>): SiteAccess {
  return {
    has: async (profileId) => store.get(profileId) !== null,
    async headersFor(profileId, url): Promise<RemoteRequestHeaders | null> {
      const profile = store.get(profileId);
      if (profile === null || !belongsToSite(url, profile.site)) return null;
      const cookie = cookieHeader(await sessions.cookies(profileId, url));
      const userAgent = sessions.userAgent(profileId);
      return cookie === null ? { userAgent } : { cookie, userAgent };
    },
  };
}

export interface ElectronSiteSessionsDeps {
  fromPartition(partition: string): Session;
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  resolve?: HostResolver;
  /** One line with at most a profile id and a fixed code. */
  log?: (line: string) => void;
  timing?: PageTiming;
}

/** The fields both windows share (spec "Browser sessions"); no preload, the user agent untouched. */
function windowOptions(session: Session, show: boolean, title: string): BrowserWindowConstructorOptions {
  return {
    show,
    title,
    width: 1100,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      spellcheck: false,
      // The crawl polls a hidden window; it must not be throttled as a background tab.
      backgroundThrottling: show,
    },
  };
}

/** Whether a failed `loadURL` was only replaced by another navigation (Chromium's ERR_ABORTED). */
function isAborted(error: unknown): boolean {
  const e = error as { code?: unknown; errno?: unknown } | null;
  return e?.code === 'ERR_ABORTED' || e?.errno === -3;
}

/** The Electron side of SiteSessions. */
export function createElectronSiteSessions(deps: ElectronSiteSessionsDeps): SiteSessions {
  const hardened = new Set<string>();
  const timing = deps.timing ?? PAGE_TIMING;
  let login: { profileId: string; window: BrowserWindow } | null = null;

  const sessionOf = (profileId: string): Session => {
    const partition = sitePartition(profileId);
    const session = deps.fromPartition(partition);
    if (!hardened.has(partition)) {
      hardened.add(partition);
      harden(session, createHostVetter(deps.resolve));
    }
    return session;
  };

  return {
    openLogin(profile, url) {
      const session = sessionOf(profile.id);
      const window = deps.createWindow(windowOptions(session, true, loginTitle(profile.name, url)));
      const contents = window.webContents;
      contents.setAudioMuted(true);
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
    openPage(profile) {
      const session = sessionOf(profile.id);
      const window = deps.createWindow(windowOptions(session, false, profile.name));
      const contents = window.webContents;
      contents.setAudioMuted(true);
      const leftListeners: (() => void)[] = [];
      const guard = (event: { url: string; isMainFrame?: boolean; preventDefault(): void }) => {
        if (event.isMainFrame === false || pageNavigationAllowed(event.url, profile.site)) return;
        event.preventDefault();
        for (const listener of leftListeners) listener();
      };
      contents.on('will-navigate', guard);
      contents.on('will-redirect', guard);
      // A popup is refused and, unlike in the login window, not loaded: the crawl decides where this window goes.
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const view: PageView = {
        navigate: (url) =>
          contents.loadURL(url).then(
            () => 'loaded' as const,
            (error: unknown) => (isAborted(error) ? ('aborted' as const) : ('failed' as const)),
          ),
        evaluate: (code) => contents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code }]),
        stop: () => {
          if (!contents.isDestroyed()) contents.stop();
        },
        onLeftSite: (listener) => leftListeners.push(listener),
      };
      return {
        loader: createPageLoader(view, profile.site, timing),
        close() {
          if (!window.isDestroyed()) window.destroy();
        },
      };
    },
    async cookies(profileId, url) {
      const cookies = await sessionOf(profileId).cookies.get({ url });
      return cookies.map((c) => ({ name: c.name, value: c.value }));
    },
    userAgent: (profileId) => sessionOf(profileId).getUserAgent(),
    async clear(profileId) {
      const session = sessionOf(profileId);
      try {
        await session.clearStorageData();
        await session.clearCache();
      } catch {
        deps.log?.(`site profile ${profileId}: session_clear_failed`);
      }
    },
  };
}

/** Hardens one session once: no permission, no download, only public http/https (spec "Browser sessions"). */
function harden(session: Session, vet: (host: string) => Promise<boolean>): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on('will-download', (event, item) => {
    event.preventDefault();
    item.cancel();
  });
  session.webRequest.onBeforeRequest((details, callback) => {
    const decision = requestDecision(details.url, details.resourceType);
    if (decision === 'allow') {
      callback({});
      return;
    }
    if (decision === 'refuse') {
      callback({ cancel: true });
      return;
    }
    vet(decision.host).then(
      (allowed) => callback(allowed ? {} : { cancel: true }),
      () => callback({ cancel: true }),
    );
  });
}
