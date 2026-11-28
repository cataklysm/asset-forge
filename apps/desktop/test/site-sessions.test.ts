import { EventEmitter } from 'node:events';
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron';
import type { SiteProfile } from '@assetforge/contracts';
import { describe, expect, it, vi } from 'vitest';
import { cookieHeader, createSiteAccess } from '../src/main/site-access.js';
import { EXTRACT_LIMITS, extractionCode, readExtraction } from '../src/main/site-extraction.js';
import { loginNavigationAllowed, loginTitle } from '../src/main/site-login-window.js';
import {
  createPageLoader,
  leftSiteHost,
  pageNavigationAllowed,
  PAGE_TIMING,
  type PageView,
} from '../src/main/site-page-loader.js';
import { createHostVetter, pageResourceBlocked, requestDecision } from '../src/main/site-request-filter.js';
import { createElectronSiteSessions, sitePartition } from '../src/main/site-sessions.js';

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
    for (const url of [
      'ftp://example.com/',
      'file:///C:/x',
      'chrome://settings',
      'ws://example.com/',
      'javascript:alert(1)',
      'nonsense',
    ]) {
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
    expect(
      cookieHeader([
        { name: 'a', value: '1' },
        { name: 'sid', value: 'x y' },
      ]),
    ).toBe('a=1; sid=x y');
    expect(cookieHeader([])).toBeNull();
    expect(
      cookieHeader([
        { name: 'bad', value: 'a\r\nb' },
        { name: 'x;y', value: '1' },
        { name: 'ok', value: '2' },
      ]),
    ).toBe('ok=2');
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
    expect(
      code.endsWith(`(${JSON.stringify(JSON.stringify({ queries: { thumbnails: query }, ...EXTRACT_LIMITS }))})`),
    ).toBe(true);
  });

  it('trusts nothing the page answers', () => {
    expect(readExtraction('x', ['a'])).toBeNull();
    expect(readExtraction({ invalid: 'other' }, ['a'])).toBeNull();
    expect(readExtraction({ invalid: 'a' }, ['a'])).toEqual({ kind: 'invalid', query: 'a' });
    const limits = { maxResults: 2, maxLength: 3 };
    expect(
      readExtraction(
        { results: { a: ['abcdef', 7, 'x', 'y'], extra: ['z'] }, counts: { a: 4, extra: 1 } },
        ['a', 'b'],
        limits,
      ),
    ).toEqual({ kind: 'results', results: { a: ['abc', 'x'], b: [] }, counts: { a: 4, b: 0 }, baseUrl: '' });
    const base = (baseUrl: unknown) => readExtraction({ results: {}, counts: {}, baseUrl }, ['a']);
    expect(base('https://example.com/g/')).toMatchObject({ baseUrl: 'https://example.com/g/' });
    expect(base(7)).toMatchObject({ baseUrl: '' });
    expect(base('x'.repeat(EXTRACT_LIMITS.maxLength + 1))).toMatchObject({ baseUrl: '' });
  });
});

/** A page view whose answers the test scripts. */
function fakeView(o: {
  navigate?: (url: string, onParsed?: () => void) => Promise<'loaded' | 'aborted' | 'failed'>;
  evaluate?: (call: number) => unknown;
}) {
  let left: ((url: string) => void) | null = null;
  let response: ((status: number) => void) | null = null;
  let calls = 0;
  const view: PageView & { stops: number; leave(url?: string): void; answer(status: number): void; calls(): number } = {
    stops: 0,
    navigate: o.navigate ?? (async () => 'loaded'),
    evaluate: async () => o.evaluate?.(++calls),
    stop() {
      view.stops++;
    },
    onLeftSite(listener) {
      left = listener;
    },
    onResponse(listener) {
      response = listener;
    },
    leave: (url = 'https://login.other.org/sign-in') => left?.(url),
    answer: (status) => response?.(status),
    calls: () => calls,
  };
  return view;
}

const fast = { pollMs: 5, settleMs: 60, totalMs: 300 };
const request = (signal = new AbortController().signal) => ({
  queries: { thumbnails: '//a', pagination: '//b' },
  waitFor: 'thumbnails',
  signal,
});

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
      baseUrl: '',
    });
    expect(view.calls()).toBe(3);
  });

  it('answers invalid_xpath with the query name', async () => {
    const loader = createPageLoader(fakeView({ evaluate: () => ({ invalid: 'pagination' }) }), 'example.com', fast);
    expect(await loader.load('https://example.com/g', request())).toEqual({
      ok: false,
      reason: 'invalid_xpath',
      query: 'pagination',
    });
  });

  it('answers no_match when the page loaded but nothing matches in time, and keeps asking after a failed evaluation', async () => {
    let calls = 0;
    const view = fakeView({});
    view.evaluate = async () => {
      calls++;
      if (calls === 1) throw new Error('context destroyed');
      return { results: { thumbnails: ['x'] }, counts: { thumbnails: 0 } };
    };
    const loader = createPageLoader(view, 'example.com', fast);
    expect(await loader.load('https://example.com/g', request())).toEqual({ ok: false, reason: 'no_match' });
    expect(calls).toBeGreaterThan(2);
  });

  it('answers no_match when the overall limit ends the poll of a loaded page', async () => {
    const view = fakeView({ evaluate: () => ({ results: {}, counts: { thumbnails: 0 } }) });
    const loader = createPageLoader(view, 'example.com', { ...fast, settleMs: 10_000, totalMs: 40 });
    expect(await loader.load('https://example.com/g', request())).toEqual({ ok: false, reason: 'no_match' });
  });

  it('answers timeout when the page never finishes loading', async () => {
    const loader = createPageLoader(fakeView({ navigate: () => new Promise(() => {}) }), 'example.com', {
      ...fast,
      totalMs: 30,
    });
    expect(await loader.load('https://example.com/g', request())).toEqual({ ok: false, reason: 'timeout' });
  });

  it('answers http_error with the main-frame status when an error page matches nothing', async () => {
    const view = fakeView({ evaluate: () => ({ results: {}, counts: { thumbnails: 0 } }) });
    view.navigate = async () => {
      view.answer(403);
      return 'loaded';
    };
    const loader = createPageLoader(view, 'example.com', fast);
    expect(await loader.load('https://example.com/g', request())).toEqual({
      ok: false,
      reason: 'http_error',
      status: 403,
    });

    // An error answer Chromium shows its own page for fails the navigation.
    view.navigate = async () => {
      view.answer(500);
      return 'failed';
    };
    expect(await loader.load('https://example.com/g', request())).toEqual({
      ok: false,
      reason: 'http_error',
      status: 500,
    });

    // Still loading when the limit ends it.
    view.navigate = () => {
      view.answer(503);
      return new Promise(() => {});
    };
    const slow = createPageLoader(view, 'example.com', { ...fast, totalMs: 30 });
    expect(await slow.load('https://example.com/g', request())).toEqual({
      ok: false,
      reason: 'http_error',
      status: 503,
    });
  });

  it('takes an error page that matches as a page, and ignores a status below 400, -1 and one between loads', async () => {
    const view = fakeView({ evaluate: () => ({ results: { thumbnails: ['/a'] }, counts: { thumbnails: 1 } }) });
    view.navigate = async () => {
      view.answer(404);
      return 'loaded';
    };
    const loader = createPageLoader(view, 'example.com', fast);
    expect((await loader.load('https://example.com/g', request())).ok).toBe(true);

    const empty = fakeView({ evaluate: () => ({ results: {}, counts: { thumbnails: 0 } }) });
    const emptyLoader = createPageLoader(empty, 'example.com', fast);
    empty.answer(500); // between loads: reaches no load
    empty.navigate = async () => {
      empty.answer(200);
      empty.answer(-1);
      return 'loaded';
    };
    expect(await emptyLoader.load('https://example.com/g', request())).toEqual({ ok: false, reason: 'no_match' });
    empty.navigate = async () => 'failed';
    expect(await emptyLoader.load('https://example.com/g', request())).toEqual({ ok: false, reason: 'failed' });
  });

  it('answers failed for a failed load and polls on after a load replaced within the site', async () => {
    expect(
      await createPageLoader(fakeView({ navigate: async () => 'failed' }), 'example.com', fast).load(
        'https://example.com/g',
        request(),
      ),
    ).toEqual({ ok: false, reason: 'failed' });
    const replaced = fakeView({
      navigate: async () => 'aborted',
      evaluate: () => ({ results: { thumbnails: ['/a'] }, counts: { thumbnails: 1 } }),
    });
    expect(await createPageLoader(replaced, 'example.com', fast).load('https://example.com/g', request())).toEqual({
      ok: true,
      results: { thumbnails: ['/a'], pagination: [] },
      baseUrl: '',
    });
  });

  it('answers left_site with the host for a URL off the site and for a refused navigation', async () => {
    const view = fakeView({ navigate: () => new Promise(() => {}) });
    const loader = createPageLoader(view, 'example.com', fast);
    expect(await loader.load('https://Other.org:8443/g', request())).toEqual({
      ok: false,
      reason: 'left_site',
      host: 'other.org',
    });
    const pending = loader.load('https://example.com/g', request());
    await new Promise((r) => setTimeout(r, 5));
    view.leave('https://LOGIN.other.org/sign-in?next=/g');
    expect(await pending).toEqual({ ok: false, reason: 'left_site', host: 'login.other.org' });
    const odd = loader.load('https://example.com/g', request());
    await new Promise((r) => setTimeout(r, 5));
    view.leave('not a url');
    expect(await odd).toEqual({ ok: false, reason: 'left_site', host: '' });
  });

  it('reads the host of a refused target for the answer', () => {
    expect(leftSiteHost('https://Login.Example.org/x')).toBe('login.example.org');
    expect(leftSiteHost('http://[::1]:8080/x')).toBe('[::1]');
    expect(leftSiteHost('data:text/html,x')).toBe('');
    expect(leftSiteHost('')).toBe('');
  });

  it('stops the page and answers at once on abort', async () => {
    const view = fakeView({ navigate: () => new Promise(() => {}) });
    const controller = new AbortController();
    const pending = createPageLoader(view, 'example.com', PAGE_TIMING).load(
      'https://example.com/g',
      request(controller.signal),
    );
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: 'failed' });
    expect(view.stops).toBe(1);
  });

  it('answers the base URL the page reports', async () => {
    const view = fakeView({
      evaluate: () => ({
        results: { thumbnails: ['page2'] },
        counts: { thumbnails: 1 },
        baseUrl: 'https://example.com/g/',
      }),
    });
    expect(await createPageLoader(view, 'example.com', fast).load('https://example.com/g', request())).toEqual({
      ok: true,
      results: { thumbnails: ['page2'], pagination: [] },
      baseUrl: 'https://example.com/g/',
    });
  });

  it('polls from the moment the document is parsed and takes a match once two polls saw the same counts', async () => {
    let finishLoad: (value: 'loaded') => void = () => {};
    const counts = [0, 2, 5, 5];
    const view = fakeView({
      navigate: (_url, onParsed) => {
        setTimeout(() => onParsed?.(), 0);
        return new Promise((resolve) => (finishLoad = resolve));
      },
      evaluate: (call) => {
        const n = counts[Math.min(call, counts.length) - 1]!;
        return { results: { thumbnails: Array.from({ length: n }, (_, i) => '/' + i) }, counts: { thumbnails: n } };
      },
    });
    const result = await createPageLoader(view, 'example.com', fast).load('https://example.com/g', request());
    // The load never finished: the list was still growing at the second poll and stood still at the fourth.
    expect(result).toMatchObject({ ok: true, results: { thumbnails: ['/0', '/1', '/2', '/3', '/4'] } });
    expect(view.calls()).toBe(4);
    expect(view.stops).toBe(1);
    finishLoad('loaded');
  });

  it('takes the first match at once after the load finished', async () => {
    const view = fakeView({ evaluate: () => ({ results: { thumbnails: ['/a'] }, counts: { thumbnails: 1 } }) });
    expect((await createPageLoader(view, 'example.com', fast).load('https://example.com/g', request())).ok).toBe(true);
    expect(view.calls()).toBe(1);
  });

  it('does not answer no_match while the load is still under way, and counts the wait from its end', async () => {
    let finishLoad: (value: 'loaded') => void = () => {};
    const view = fakeView({
      navigate: (_url, onParsed) => {
        onParsed?.();
        onParsed?.();
        return new Promise((resolve) => (finishLoad = resolve));
      },
      evaluate: () => ({ results: {}, counts: { thumbnails: 0 } }),
    });
    const timing = { pollMs: 5, settleMs: 30, totalMs: 2000 };
    let answer: unknown = null;
    const pending = createPageLoader(view, 'example.com', timing)
      .load('https://example.com/g', request())
      .then((r) => (answer = r));
    await new Promise((r) => setTimeout(r, 90));
    expect(answer).toBeNull();
    expect(view.calls()).toBeGreaterThan(2);
    finishLoad('loaded');
    await pending;
    expect(answer).toEqual({ ok: false, reason: 'no_match' });
  });

  it('stops the view after every load before the next one starts', async () => {
    let hang = true;
    const view = fakeView({
      navigate: () => (hang ? new Promise(() => {}) : Promise.resolve('loaded')),
      evaluate: () => ({ results: { thumbnails: ['/a'] }, counts: { thumbnails: 1 } }),
    });
    const loader = createPageLoader(view, 'example.com', { ...fast, totalMs: 30 });
    expect(await loader.load('https://example.com/1', request())).toEqual({ ok: false, reason: 'timeout' });
    expect(view.stops).toBe(1);
    const leaving = loader.load('https://example.com/2', request());
    await new Promise((r) => setTimeout(r, 5));
    view.leave();
    expect(await leaving).toEqual({ ok: false, reason: 'left_site', host: 'login.other.org' });
    expect(view.stops).toBe(2);
    hang = false;
    // A signal of an earlier load that arrives between two loads ends nothing.
    view.leave();
    // A page that answered loads nothing further.
    expect((await loader.load('https://example.com/3', request())).ok).toBe(true);
    expect(view.stops).toBe(3);
    view.navigate = async () => 'failed';
    expect(await loader.load('https://example.com/4', request())).toEqual({ ok: false, reason: 'failed' });
    expect(view.stops).toBe(4);
  });
});

describe('site access', () => {
  const store = { get: (id: string) => (id === profile.id ? profile : null) };

  it('answers null for an unknown profile and off the site, without asking the session', async () => {
    const sessions = { cookies: vi.fn(async () => [{ name: 'sid', value: 's' }]), userAgent: vi.fn(() => 'UA') };
    const access = createSiteAccess(store, sessions);
    expect(await access.siteOf(profile.id)).toBe(profile.site);
    expect(await access.siteOf('11111111-2222-4333-8444-555555555555')).toBeNull();
    expect(await access.headersFor('11111111-2222-4333-8444-555555555555', 'https://example.com/1.jpg')).toBeNull();
    expect(await access.headersFor(profile.id, 'https://cdn.other.org/1.jpg')).toBeNull();
    expect(await access.headersFor(profile.id, 'https://example.com.evil.org/1.jpg')).toBeNull();
    expect(sessions.cookies).not.toHaveBeenCalled();
  });

  it("answers the session's cookie header and user agent on the site", async () => {
    const sessions = {
      cookies: vi.fn(async () => [
        { name: 'sid', value: 's' },
        { name: 'b', value: '2' },
      ]),
      userAgent: () => 'UA',
    };
    const access = createSiteAccess(store, sessions);
    expect(await access.headersFor(profile.id, 'https://img.example.com/1.jpg')).toEqual({
      cookie: 'sid=s; b=2',
      userAgent: 'UA',
    });
    expect(sessions.cookies).toHaveBeenCalledWith(profile.id, 'https://img.example.com/1.jpg');
    const none = createSiteAccess(store, { cookies: async () => [], userAgent: () => 'UA' });
    expect(await none.headersFor(profile.id, 'https://example.com/1.jpg')).toEqual({ userAgent: 'UA' });
  });
});

// --- The Electron glue, against fakes of the few Electron calls it makes. ---

let nextContentsId = 1;

class FakeContents extends EventEmitter {
  id = nextContentsId++;
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
    baseUrl: 'https://example.com/g/',
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
  menuRemoved = 0;
  constructor(readonly options: BrowserWindowConstructorOptions) {
    super();
    this.title = options.title ?? '';
  }
  setTitle(title: string) {
    this.title = title;
  }
  removeMenu() {
    this.menuRemoved++;
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
type BeforeRequest =
  | null
  | ((d: { url: string; resourceType: string; webContentsId?: number }, cb: (r: { cancel?: boolean }) => void) => void);

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
    clearAuthCache: vi.fn(async () => {}),
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

const decide = (s: ReturnType<typeof fakeSession>, url: string, resourceType = 'mainFrame', webContentsId?: number) =>
  new Promise<{ cancel?: boolean }>((resolve) => s.beforeRequest!({ url, resourceType, webContentsId }, resolve));

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
    expect(prefs).toMatchObject({ disableDialogs: true, devTools: false });
    expect(prefs.preload).toBeUndefined();
    expect(prefs.session).toBe(e.session());
    expect(w.webContents.muted).toBe(true);
    expect(w.menuRemoved).toBe(1);
    let unloadForced = false;
    w.webContents.emit('will-prevent-unload', { preventDefault: () => (unloadForced = true) });
    expect(unloadForced).toBe(true);
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
    expect(w.options.webPreferences).toMatchObject({ disableDialogs: true, devTools: false });
    expect(w.options.webPreferences!.preload).toBeUndefined();
    expect(w.webContents.muted).toBe(true);
    expect(w.menuRemoved).toBe(1);
    let unloadForced = false;
    w.webContents.emit('will-prevent-unload', { preventDefault: () => (unloadForced = true) });
    expect(unloadForced).toBe(true);
    expect(w.webContents.openHandler!({ url: 'https://example.com/popup' })).toEqual({ action: 'deny' });
    expect(w.webContents.loaded).toEqual([]);

    const result = await page.loader.load('https://example.com/g', {
      queries: { thumbnails: '//a' },
      waitFor: 'thumbnails',
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ ok: true, results: { thumbnails: ['/1.jpg'] }, baseUrl: 'https://example.com/g/' });
    const [world, scripts] = w.webContents.executeJavaScriptInIsolatedWorld.mock.calls[0]!;
    expect(world).not.toBe(0);
    expect(scripts[0]!.code).toBe(extractionCode({ thumbnails: '//a' }));

    expect(w.webContents.navigate('will-navigate', 'https://img.example.com/')).toBe(false);
    expect(w.webContents.navigate('will-navigate', 'https://ads.other.org/', false)).toBe(false);

    // A redirect off the site during a load ends it as left_site.
    w.webContents.loadResult = () => new Promise(() => {});
    const pending = page.loader.load('https://example.com/h', {
      queries: { thumbnails: '//a' },
      waitFor: 'thumbnails',
      signal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(w.webContents.navigate('will-redirect', 'https://other.org/')).toBe(true);
    expect(await pending).toEqual({ ok: false, reason: 'left_site', host: 'other.org' });

    // The main-frame status of did-navigate reaches the running load.
    w.webContents.executeJavaScriptInIsolatedWorld.mockResolvedValue({
      results: { thumbnails: [] },
      counts: { thumbnails: 0 },
      baseUrl: '',
    });
    w.webContents.loadResult = async () => {
      w.webContents.emit('did-navigate', {}, 'https://example.com/i', 401, 'Unauthorized');
    };
    const refused = await page.loader.load('https://example.com/i', {
      queries: { thumbnails: '//a' },
      waitFor: 'thumbnails',
      signal: new AbortController().signal,
    });
    expect(refused).toEqual({ ok: false, reason: 'http_error', status: 401 });

    page.close();
    page.close();
    expect(w.destroyed).toBe(true);
  });

  it('fetches no image, media or font for a page window, and everything for the login window', async () => {
    const e = electron();
    e.site.openLogin(profile, 'https://example.com/login');
    const page = e.site.openPage(profile);
    const login = e.windows[0]!.webContents.id;
    const hidden = e.windows[1]!.webContents.id;
    const s = e.session();
    expect(pageResourceBlocked('image') && pageResourceBlocked('media') && pageResourceBlocked('font')).toBe(true);
    for (const type of ['image', 'media', 'font']) {
      expect(await decide(s, 'https://example.com/x', type, hidden)).toEqual({ cancel: true });
      expect(await decide(s, 'https://example.com/x', type, login)).toEqual({});
      expect(await decide(s, 'https://example.com/x', type)).toEqual({});
    }
    for (const type of ['mainFrame', 'subFrame', 'script', 'stylesheet', 'xhr']) {
      expect(await decide(s, 'https://example.com/x', type, hidden)).toEqual({});
    }
    // The address rule still decides everything else of a page window.
    expect(await decide(s, 'https://intranet.example/app.js', 'script', hidden)).toEqual({ cancel: true });
    // A closed page window is forgotten.
    page.close();
    expect(await decide(s, 'https://example.com/x', 'image', hidden)).toEqual({});
  });

  it('starts the poll at dom-ready of the committed document and drops its listeners after the load', async () => {
    const e = electron();
    const page = e.site.openPage(profile);
    const c = e.windows[0]!.webContents;
    const before = { commit: c.listenerCount('did-navigate'), ready: c.listenerCount('dom-ready') };
    let finishLoad: () => void = () => {};
    c.loadResult = () => new Promise((resolve) => (finishLoad = resolve));
    const pending = page.loader.load('https://example.com/g', {
      queries: { thumbnails: '//a' },
      waitFor: 'thumbnails',
      signal: new AbortController().signal,
    });
    // The document that is being replaced reports dom-ready: nothing is asked yet.
    c.emit('dom-ready');
    await new Promise((r) => setTimeout(r, 15));
    expect(c.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    c.emit('did-navigate', {}, 'https://example.com/g', 200, 'OK');
    c.emit('dom-ready');
    expect((await pending).ok).toBe(true);
    expect(c.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
    expect(c.stopped).toBe(1);
    finishLoad();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.listenerCount('did-navigate')).toBe(before.commit);
    expect(c.listenerCount('dom-ready')).toBe(before.ready);
    page.close();
  });

  it('maps a load replaced by another navigation to polling on and any other failure to failed', async () => {
    const e = electron();
    const page = e.site.openPage(profile);
    const w = e.windows[0]!;
    const r = { queries: { thumbnails: '//a' }, waitFor: 'thumbnails', signal: new AbortController().signal };
    w.webContents.loadResult = () =>
      Promise.reject(Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 }));
    expect((await page.loader.load('https://example.com/g', r)).ok).toBe(true);
    w.webContents.loadResult = () =>
      Promise.reject(Object.assign(new Error('ERR_NAME_NOT_RESOLVED'), { code: 'ERR_NAME_NOT_RESOLVED', errno: -105 }));
    expect(await page.loader.load('https://example.com/g', r)).toEqual({ ok: false, reason: 'failed' });
    page.close();
  });

  it('tells the crawl when its page window goes away', () => {
    const e = electron();
    let gone = 0;
    const page = e.site.openPage(profile, () => gone++);
    e.windows[0]!.destroy();
    expect(gone).toBe(1);
    page.close();
    expect(gone).toBe(1);
  });

  it('shuts down: destroys the login and every page window, tells each crawl, and opens no window afterwards', () => {
    const e = electron();
    e.site.openLogin(profile, 'https://example.com/login');
    let gone = 0;
    e.site.openPage(profile, () => gone++);
    e.site.shutdown();
    expect(e.windows.map((w) => w.destroyed)).toEqual([true, true]);
    expect(gone).toBe(1);
    expect(e.site.loginProfileId()).toBeNull();
    e.site.shutdown();
    expect(() => e.site.openLogin(profile, 'https://example.com/')).toThrow('Site logins are not available');
    expect(() => e.site.openPage(profile)).toThrow('Site logins are not available');
    expect(e.windows).toHaveLength(2);
  });

  it("answers the session's cookies and user agent and clears a session without logging details", async () => {
    const e = electron();
    expect(await e.site.cookies(profile.id, 'https://example.com/a')).toEqual([{ name: 'sid', value: 's' }]);
    expect(e.session().cookies.get).toHaveBeenCalledWith({ url: 'https://example.com/a' });
    expect(e.site.userAgent(profile.id)).toBe('Mozilla/5.0 Chrome Electron AssetForge/0.1.0');
    await e.site.clear(profile.id);
    expect(e.session().clearStorageData).toHaveBeenCalledTimes(1);
    expect(e.session().clearAuthCache).toHaveBeenCalledTimes(1);
    // A failed auth cache clear is logged the same way and does not stop the other clears.
    e.session().clearAuthCache.mockRejectedValueOnce(new Error('C:\\Users\\x\\secret'));
    await e.site.clear(profile.id);
    expect(e.session().clearCache).toHaveBeenCalledTimes(2);
    expect(e.log).toHaveBeenCalledTimes(1);
    expect(e.log).toHaveBeenLastCalledWith(`site profile ${profile.id}: session_clear_failed`);
    e.log.mockClear();
    e.session().clearStorageData.mockRejectedValueOnce(new Error('C:\\Users\\x\\secret'));
    await e.site.clear(profile.id);
    expect(e.log).toHaveBeenCalledWith(`site profile ${profile.id}: session_clear_failed`);
  });
});
