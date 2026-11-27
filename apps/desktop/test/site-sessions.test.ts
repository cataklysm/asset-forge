import { EventEmitter } from 'node:events';
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron';
import type { SiteProfile } from '@assetforge/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  cookieHeader,
  createElectronSiteSessions,
  createHostVetter,
  createPageLoader,
  createSiteAccess,
  EXTRACT_LIMITS,
  extractionCode,
  loginNavigationAllowed,
  loginTitle,
  pageNavigationAllowed,
  PAGE_TIMING,
  readExtraction,
  requestDecision,
  sitePartition,
  type PageView,
} from '../src/main/site-sessions.js';

const profile: SiteProfile = {
  id: '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f',
  site: 'example.com',
  name: 'Example',
  thumbnails: '//a',
  pagination: '',
  file: '',
  kinds: ['image'],
  minBytes: 0,
  urlContains: '',
  maxPages: 20,
  maxFiles: 1000,
};

describe('request filter', () => {
  it('lets only http and https through, data and blob only for sub-resources', () => {
    expect(requestDecision('https://www.example.com/a', 'mainFrame')).toEqual({ host: 'www.example.com' });
    expect(requestDecision('http://cdn.example.net/x.png', 'image')).toEqual({ host: 'cdn.example.net' });
    for (const url of ['ftp://example.com/', 'file:///C:/x', 'chrome://settings', 'ws://example.com/', 'javascript:alert(1)', 'nonsense']) {
      expect(requestDecision(url, 'mainFrame')).toBe('refuse');
    }
    expect(requestDecision('data:image/png;base64,AAAA', 'image')).toBe('allow');
    expect(requestDecision('blob:https://example.com/1', 'xhr')).toBe('allow');
    expect(requestDecision('data:text/html,<p>', 'mainFrame')).toBe('refuse');
    expect(requestDecision('data:text/html,<p>', 'subFrame')).toBe('refuse');
    expect(requestDecision('https://user:pw@example.com/', 'mainFrame')).toBe('refuse');
  });

  it('decides an address literal at once', () => {
    expect(requestDecision('https://93.184.216.34/', 'mainFrame')).toBe('allow');
    expect(requestDecision('http://127.0.0.1:8080/', 'image')).toBe('refuse');
    expect(requestDecision('http://192.168.1.10/', 'mainFrame')).toBe('refuse');
    expect(requestDecision('http://[::1]/', 'mainFrame')).toBe('refuse');
    expect(requestDecision('http://[::ffff:10.0.0.1]/', 'mainFrame')).toBe('refuse');
  });

  it('refuses a host with any address that is not public, and keeps the verdict', async () => {
    const answers: Record<string, string[]> = {
      'good.example': ['93.184.216.34'],
      'mixed.example': ['93.184.216.34', '10.0.0.1'],
      'local.example': ['127.0.0.1'],
      'empty.example': [],
    };
    const resolve = vi.fn(async (host: string) => answers[host] ?? []);
    const vet = createHostVetter(resolve);
    expect(await vet('good.example')).toBe(true);
    expect(await vet('mixed.example')).toBe(false);
    expect(await vet('local.example')).toBe(false);
    expect(await vet('empty.example')).toBe(false);
    expect(await vet('good.example')).toBe(true);
    expect(await vet('mixed.example')).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(4);
  });

  it('refuses a host it cannot resolve and asks again next time', async () => {
    let fail = true;
    const resolve = vi.fn(async () => {
      if (fail) throw new Error('ENOTFOUND');
      return ['93.184.216.34'];
    });
    const vet = createHostVetter(resolve);
    expect(await vet('flaky.example')).toBe(false);
    fail = false;
    expect(await vet('flaky.example')).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

describe('cookies, titles and navigation', () => {
  it('builds the cookie header and leaves out what cannot go into one', () => {
    expect(cookieHeader([{ name: 'a', value: '1' }, { name: 'sid', value: 'x y' }])).toBe('a=1; sid=x y');
    expect(cookieHeader([])).toBeNull();
    expect(cookieHeader([{ name: 'bad', value: 'a\r\nb' }, { name: 'x;y', value: '1' }, { name: 'ok', value: '2' }])).toBe('ok=2');
    expect(cookieHeader([{ name: 'bad', value: 'a;b' }])).toBeNull();
  });

  it('titles the login window with the profile name and the current host', () => {
    expect(loginTitle('Example', 'https://login.other.org/sign-in?x=1')).toBe('Example – login.other.org');
    expect(loginTitle('Example', 'http://example.com:8080/')).toBe('Example – example.com:8080');
    expect(loginTitle('Example', 'about:blank')).toBe('Example');
  });

  it('keeps the page window on the site and the login window on http and https', () => {
    expect(pageNavigationAllowed('https://img.example.com/1', 'example.com')).toBe(true);
    expect(pageNavigationAllowed('https://example.com.evil.org/', 'example.com')).toBe(false);
    expect(pageNavigationAllowed('https://other.org/', 'example.com')).toBe(false);
    expect(loginNavigationAllowed('https://accounts.other.org/')).toBe(true);
    expect(loginNavigationAllowed('file:///etc/passwd')).toBe(false);
    expect(loginNavigationAllowed('https://u:p@other.org/')).toBe(false);
  });
});

describe('extraction answer', () => {
  it('passes the expressions as data, never as code', () => {
    const query = `'); globalThis.pwned = 1; ('`;
    const code = extractionCode({ thumbnails: query });
    // The expression only appears inside the doubly encoded JSON input.
    expect(code.endsWith(`(${JSON.stringify(JSON.stringify({ queries: { thumbnails: query }, ...EXTRACT_LIMITS }))})`)).toBe(true);
  });

  it('trusts nothing the page answers', () => {
    expect(readExtraction('x', ['a'])).toBeNull();
    expect(readExtraction({ invalid: 'other' }, ['a'])).toBeNull();
    expect(readExtraction({ invalid: 'a' }, ['a'])).toEqual({ kind: 'invalid', query: 'a' });
    const limits = { maxResults: 2, maxLength: 3 };
    expect(
      readExtraction({ results: { a: ['abcdef', 7, 'x', 'y'], extra: ['z'] }, counts: { a: 4, extra: 1 } }, ['a', 'b'], limits),
    ).toEqual({ kind: 'results', results: { a: ['abc', 'x'], b: [] }, counts: { a: 4, b: 0 } });
  });
});

/** A page view whose answers the test scripts. */
function fakeView(o: {
  navigate?: (url: string) => Promise<'loaded' | 'aborted' | 'failed'>;
  evaluate?: (call: number) => unknown;
}) {
  let left: (() => void) | null = null;
  let calls = 0;
  const view: PageView & { stops: number; leave(): void; calls(): number } = {
    stops: 0,
    navigate: o.navigate ?? (async () => 'loaded'),
    evaluate: async () => o.evaluate?.(++calls),
    stop() {
      view.stops++;
    },
    onLeftSite(listener) {
      left = listener;
    },
    leave: () => left?.(),
    calls: () => calls,
  };
  return view;
}

const fast = { pollMs: 5, settleMs: 60, totalMs: 300 };
const request = (signal = new AbortController().signal) => ({ queries: { thumbnails: '//a', pagination: '//b' }, waitFor: 'thumbnails', signal });

describe('page loader', () => {
  it('waits until the waited-for query matches a node and answers every query', async () => {
    const view = fakeView({
      evaluate: (call) =>
        call < 3
          ? { results: { thumbnails: [], pagination: [] }, counts: { thumbnails: 0, pagination: 0 } }
          : { results: { thumbnails: ['/1.jpg'], pagination: ['?p=2'] }, counts: { thumbnails: 1, pagination: 1 } },
    });
    const loader = createPageLoader(view, 'example.com', fast);
    expect(await loader.load('https://example.com/g', request())).toEqual({
      ok: true,
      results: { thumbnails: ['/1.jpg'], pagination: ['?p=2'] },
    });
    expect(view.calls()).toBe(3);
  });

  it('answers invalid_xpath with the query name', async () => {
    const loader = createPageLoader(fakeView({ evaluate: () => ({ invalid: 'pagination' }) }), 'example.com', fast);
    expect(await loader.load('https://example.com/g', request())).toEqual({ ok: false, reason: 'invalid_xpath', query: 'pagination' });
  });

  it('answers timeout when nothing matches in time, and keeps asking after a failed evaluation', async () => {
    let calls = 0;
    const view = fakeView({});
    view.evaluate = async () => {
      calls++;
      if (calls === 1) throw new Error('context destroyed');
      return { results: { thumbnails: ['x'] }, counts: { thumbnails: 0 } };
    };
    const loader = createPageLoader(view, 'example.com', fast);
    expect(await loader.load('https://example.com/g', request())).toEqual({ ok: false, reason: 'timeout' });
    expect(calls).toBeGreaterThan(2);
  });

  it('answers timeout when the page never finishes loading', async () => {
    const loader = createPageLoader(fakeView({ navigate: () => new Promise(() => {}) }), 'example.com', { ...fast, totalMs: 30 });
    expect(await loader.load('https://example.com/g', request())).toEqual({ ok: false, reason: 'timeout' });
  });

  it('answers failed for a failed load and polls on after a load replaced within the site', async () => {
    expect(
      await createPageLoader(fakeView({ navigate: async () => 'failed' }), 'example.com', fast).load('https://example.com/g', request()),
    ).toEqual({ ok: false, reason: 'failed' });
    const replaced = fakeView({
      navigate: async () => 'aborted',
      evaluate: () => ({ results: { thumbnails: ['/a'] }, counts: { thumbnails: 1 } }),
    });
    expect(await createPageLoader(replaced, 'example.com', fast).load('https://example.com/g', request())).toEqual({
      ok: true,
      results: { thumbnails: ['/a'], pagination: [] },
    });
  });

  it('answers left_site for a URL off the site and for a refused navigation', async () => {
    const view = fakeView({ navigate: () => new Promise(() => {}) });
    const loader = createPageLoader(view, 'example.com', fast);
    expect(await loader.load('https://other.org/g', request())).toEqual({ ok: false, reason: 'left_site' });
    const pending = loader.load('https://example.com/g', request());
    await new Promise((r) => setTimeout(r, 5));
    view.leave();
    expect(await pending).toEqual({ ok: false, reason: 'left_site' });
  });

  it('stops the page and answers at once on abort', async () => {
    const view = fakeView({ navigate: () => new Promise(() => {}) });
    const controller = new AbortController();
    const pending = createPageLoader(view, 'example.com', PAGE_TIMING).load('https://example.com/g', request(controller.signal));
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: 'failed' });
    expect(view.stops).toBe(1);
  });
});

describe('site access', () => {
  const store = { get: (id: string) => (id === profile.id ? profile : null) };

  it('answers null for an unknown profile and off the site, without asking the session', async () => {
    const sessions = { cookies: vi.fn(async () => [{ name: 'sid', value: 's' }]), userAgent: vi.fn(() => 'UA') };
    const access = createSiteAccess(store, sessions);
    expect(await access.has(profile.id)).toBe(true);
    expect(await access.has('11111111-2222-4333-8444-555555555555')).toBe(false);
    expect(await access.headersFor('11111111-2222-4333-8444-555555555555', 'https://example.com/1.jpg')).toBeNull();
    expect(await access.headersFor(profile.id, 'https://cdn.other.org/1.jpg')).toBeNull();
    expect(await access.headersFor(profile.id, 'https://example.com.evil.org/1.jpg')).toBeNull();
    expect(sessions.cookies).not.toHaveBeenCalled();
  });

  it("answers the session's cookie header and user agent on the site", async () => {
    const sessions = { cookies: vi.fn(async () => [{ name: 'sid', value: 's' }, { name: 'b', value: '2' }]), userAgent: () => 'UA' };
    const access = createSiteAccess(store, sessions);
    expect(await access.headersFor(profile.id, 'https://img.example.com/1.jpg')).toEqual({ cookie: 'sid=s; b=2', userAgent: 'UA' });
    expect(sessions.cookies).toHaveBeenCalledWith(profile.id, 'https://img.example.com/1.jpg');
    const none = createSiteAccess(store, { cookies: async () => [], userAgent: () => 'UA' });
    expect(await none.headersFor(profile.id, 'https://example.com/1.jpg')).toEqual({ userAgent: 'UA' });
  });
});

// --- The Electron glue, against fakes of the few Electron calls it makes. ---

class FakeContents extends EventEmitter {
  muted = false;
  openHandler: ((d: { url: string }) => { action: string }) | null = null;
  loaded: string[] = [];
  loadResult: () => Promise<void> = async () => {};
  destroyed = false;
  stopped = 0;
  setAudioMuted(value: boolean) {
    this.muted = value;
  }
  setWindowOpenHandler(handler: (d: { url: string }) => { action: string }) {
    this.openHandler = handler;
  }
  loadURL(url: string) {
    this.loaded.push(url);
    return this.loadResult();
  }
  executeJavaScriptInIsolatedWorld = vi.fn(async (_world: number, _scripts: { code: string }[]) => ({
    results: { thumbnails: ['/1.jpg'] },
    counts: { thumbnails: 1 },
  }));
  isDestroyed() {
    return this.destroyed;
  }
  stop() {
    this.stopped++;
  }
  /** Emits a navigation event and answers whether it was refused. */
  navigate(event: 'will-navigate' | 'will-redirect', url: string, isMainFrame = true): boolean {
    let prevented = false;
    this.emit(event, { url, isMainFrame, preventDefault: () => (prevented = true) });
    return prevented;
  }
}

class FakeWindow extends EventEmitter {
  webContents = new FakeContents();
  title: string;
  destroyed = false;
  focused = 0;
  constructor(readonly options: BrowserWindowConstructorOptions) {
    super();
    this.title = options.title ?? '';
  }
  setTitle(title: string) {
    this.title = title;
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit('closed');
  }
  isMinimized() {
    return false;
  }
  restore() {}
  focus() {
    this.focused++;
  }
}

type PermissionRequest = null | ((c: unknown, p: string, cb: (ok: boolean) => void) => void);
type PermissionCheck = null | (() => boolean);
type BeforeRequest = null | ((d: { url: string; resourceType: string }, cb: (r: { cancel?: boolean }) => void) => void);

function fakeSession() {
  const events = new EventEmitter();
  const session = {
    permissionRequest: null as PermissionRequest,
    permissionCheck: null as PermissionCheck,
    beforeRequest: null as BeforeRequest,
    cleared: 0,
    setPermissionRequestHandler(h: PermissionRequest) {
      session.permissionRequest = h;
    },
    setPermissionCheckHandler(h: PermissionCheck) {
      session.permissionCheck = h;
    },
    on: (event: string, listener: (...args: unknown[]) => void) => events.on(event, listener),
    emit: (event: string, ...args: unknown[]) => events.emit(event, ...args),
    listenerCount: (event: string) => events.listenerCount(event),
    webRequest: {
      onBeforeRequest(h: BeforeRequest) {
        session.beforeRequest = h;
      },
    },
    cookies: { get: vi.fn(async (_filter: { url: string }) => [{ name: 'sid', value: 's', domain: 'example.com' }]) },
    getUserAgent: () => 'Mozilla/5.0 Chrome Electron AssetForge/0.1.0',
    clearStorageData: vi.fn(async () => {}),
    clearCache: vi.fn(async () => {}),
  };
  return session;
}

function electron(resolve = async (host: string) => (host === 'example.com' ? ['93.184.216.34'] : ['10.0.0.1'])) {
  const sessions = new Map<string, ReturnType<typeof fakeSession>>();
  const windows: FakeWindow[] = [];
  const fromPartition = vi.fn((partition: string) => {
    let s = sessions.get(partition);
    if (s === undefined) {
      s = fakeSession();
      sessions.set(partition, s);
    }
    return s as unknown as Session;
  });
  const createWindow = (options: BrowserWindowConstructorOptions) => {
    const w = new FakeWindow(options);
    windows.push(w);
    return w as unknown as BrowserWindow;
  };
  const log = vi.fn();
  const site = createElectronSiteSessions({ fromPartition, createWindow, resolve, log, timing: fast });
  return { site, sessions, windows, fromPartition, log, session: () => sessions.get(sitePartition(profile.id))! };
}

const decide = (s: ReturnType<typeof fakeSession>, url: string, resourceType = 'mainFrame') =>
  new Promise<{ cancel?: boolean }>((resolve) => s.beforeRequest!({ url, resourceType }, resolve));

describe('electron site sessions', () => {
  it('hardens each partition once: no permission, no download, only public hosts', async () => {
    const e = electron();
    e.site.openLogin(profile, 'https://example.com/');
    e.site.openPage(profile).close();
    await e.site.cookies(profile.id, 'https://example.com/');
    expect(e.fromPartition).toHaveBeenCalledWith('persist:site-3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f');
    const s = e.session();
    expect(s.listenerCount('will-download')).toBe(1);

    const permission = await new Promise<boolean>((resolve) => s.permissionRequest!(null, 'media', resolve));
    expect(permission).toBe(false);
    expect(s.permissionCheck!()).toBe(false);

    let cancelled = false;
    let prevented = false;
    s.emit('will-download', { preventDefault: () => (prevented = true) }, { cancel: () => (cancelled = true) });
    expect(prevented && cancelled).toBe(true);

    expect(await decide(s, 'https://example.com/')).toEqual({});
    expect(await decide(s, 'https://intranet.example/')).toEqual({ cancel: true });
    expect(await decide(s, 'file:///C:/Windows/win.ini')).toEqual({ cancel: true });
    expect(await decide(s, 'http://127.0.0.1:11434/api/tags', 'xhr')).toEqual({ cancel: true });
    expect(await decide(s, 'data:image/png;base64,AA', 'image')).toEqual({});
  });

  it('refuses a request when the resolver fails', async () => {
    const e = electron(async () => {
      throw new Error('ENOTFOUND');
    });
    e.site.openPage(profile).close();
    expect(await decide(e.session(), 'https://example.com/')).toEqual({ cancel: true });
  });

  it('opens a sandboxed login window that keeps its own title and goes only to http and https', async () => {
    const e = electron();
    e.site.openLogin(profile, 'https://example.com/login');
    const w = e.windows[0]!;
    const prefs = w.options.webPreferences!;
    expect(w.options.show).toBe(true);
    expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
    expect(prefs.preload).toBeUndefined();
    expect(prefs.session).toBe(e.session());
    expect(w.webContents.muted).toBe(true);
    expect(w.webContents.loaded).toEqual(['https://example.com/login']);
    expect(w.title).toBe('Example – example.com');
    expect(e.site.loginProfileId()).toBe(profile.id);

    let prevented = false;
    w.emit('page-title-updated', { preventDefault: () => (prevented = true) }, 'Sign in');
    expect(prevented).toBe(true);
    w.webContents.emit('did-navigate', {}, 'https://accounts.other.org/sso');
    expect(w.title).toBe('Example – accounts.other.org');

    expect(w.webContents.navigate('will-navigate', 'https://accounts.other.org/')).toBe(false);
    expect(w.webContents.navigate('will-redirect', 'file:///C:/x')).toBe(true);
    expect(w.webContents.openHandler!({ url: 'https://popup.other.org/' })).toEqual({ action: 'deny' });
    expect(w.webContents.loaded.at(-1)).toBe('https://popup.other.org/');
    expect(w.webContents.openHandler!({ url: 'file:///x' })).toEqual({ action: 'deny' });
    expect(w.webContents.loaded.at(-1)).toBe('https://popup.other.org/');

    e.site.focusLogin();
    expect(w.focused).toBe(1);
    w.destroy();
    expect(e.site.loginProfileId()).toBeNull();
  });

  it('opens a hidden page window that stays on the site and is destroyed by close', async () => {
    const e = electron();
    const page = e.site.openPage(profile);
    const w = e.windows[0]!;
    expect(w.options.show).toBe(false);
    expect(w.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(w.options.webPreferences!.preload).toBeUndefined();
    expect(w.webContents.muted).toBe(true);
    expect(w.webContents.openHandler!({ url: 'https://example.com/popup' })).toEqual({ action: 'deny' });
    expect(w.webContents.loaded).toEqual([]);

    const result = await page.loader.load('https://example.com/g', { queries: { thumbnails: '//a' }, waitFor: 'thumbnails', signal: new AbortController().signal });
    expect(result).toEqual({ ok: true, results: { thumbnails: ['/1.jpg'] } });
    const [world, scripts] = w.webContents.executeJavaScriptInIsolatedWorld.mock.calls[0]!;
    expect(world).not.toBe(0);
    expect(scripts[0]!.code).toBe(extractionCode({ thumbnails: '//a' }));

    expect(w.webContents.navigate('will-navigate', 'https://img.example.com/')).toBe(false);
    expect(w.webContents.navigate('will-navigate', 'https://ads.other.org/', false)).toBe(false);

    // A redirect off the site during a load ends it as left_site.
    w.webContents.loadResult = () => new Promise(() => {});
    const pending = page.loader.load('https://example.com/h', { queries: { thumbnails: '//a' }, waitFor: 'thumbnails', signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 5));
    expect(w.webContents.navigate('will-redirect', 'https://other.org/')).toBe(true);
    expect(await pending).toEqual({ ok: false, reason: 'left_site' });

    page.close();
    page.close();
    expect(w.destroyed).toBe(true);
  });

  it('maps a load replaced by another navigation to polling on and any other failure to failed', async () => {
    const e = electron();
    const page = e.site.openPage(profile);
    const w = e.windows[0]!;
    const r = { queries: { thumbnails: '//a' }, waitFor: 'thumbnails', signal: new AbortController().signal };
    w.webContents.loadResult = () => Promise.reject(Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 }));
    expect((await page.loader.load('https://example.com/g', r)).ok).toBe(true);
    w.webContents.loadResult = () => Promise.reject(Object.assign(new Error('ERR_NAME_NOT_RESOLVED'), { code: 'ERR_NAME_NOT_RESOLVED', errno: -105 }));
    expect(await page.loader.load('https://example.com/g', r)).toEqual({ ok: false, reason: 'failed' });
    page.close();
  });

  it("answers the session's cookies and user agent and clears a session without logging details", async () => {
    const e = electron();
    expect(await e.site.cookies(profile.id, 'https://example.com/a')).toEqual([{ name: 'sid', value: 's' }]);
    expect(e.session().cookies.get).toHaveBeenCalledWith({ url: 'https://example.com/a' });
    expect(e.site.userAgent(profile.id)).toBe('Mozilla/5.0 Chrome Electron AssetForge/0.1.0');
    await e.site.clear(profile.id);
    expect(e.session().clearStorageData).toHaveBeenCalledTimes(1);
    e.session().clearStorageData.mockRejectedValueOnce(new Error('C:\\Users\\x\\secret'));
    await e.site.clear(profile.id);
    expect(e.log).toHaveBeenCalledWith(`site profile ${profile.id}: session_clear_failed`);
  });
});
