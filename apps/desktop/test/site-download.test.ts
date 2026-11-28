import { EventEmitter } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { RemoteFileError, type RemoteFile, type RemoteFileSource } from '@assetforge/core';
import { SESSION_REQUEST_HEADERS, sessionRequestOptions, type SessionNetRequest } from '../src/main/session-request.js';
import { createSiteAccess } from '../src/main/site-access.js';
import { createSessionDownload } from '../src/main/site-download.js';
import { createElectronSiteSessions, sitePartition } from '../src/main/site-sessions.js';

const PROFILE = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';

/** What a fake request answers once it is sent. */
type Script =
  | { status: number; headers?: Record<string, string | string[]>; body?: Buffer | 'hang' }
  | { redirect: string; status?: number; headers?: Record<string, string[]> }
  | 'error'
  | 'hang';

/** A response as Electron's net IncomingMessage offers it: a Readable with a status and lower-case headers. */
function fakeResponse(status: number, headers: Record<string, string | string[]>, body: Buffer | 'hang'): PassThrough {
  const res = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string | string[]> };
  res.statusCode = status;
  res.headers = headers;
  if (body !== 'hang') res.end(body);
  return res;
}

class FakeNetRequest extends EventEmitter {
  aborted = 0;
  ended = false;
  response: PassThrough | null = null;
  constructor(
    readonly url: string,
    private readonly script: Script,
  ) {
    super();
  }
  abort() {
    this.aborted++;
  }
  end() {
    this.ended = true;
    setImmediate(() => this.play());
  }
  private play() {
    const s = this.script;
    if (s === 'hang') return;
    if (s === 'error') {
      this.emit('error', new Error('net::ERR_CONNECTION_RESET C:\\Users\\x'));
      return;
    }
    if ('redirect' in s) {
      this.emit('redirect', s.status ?? 302, 'GET', s.redirect, s.headers ?? {});
      // Electron reports a redirect that was neither followed nor aborted as an error.
      if (this.aborted === 0) this.emit('error', new Error('Redirect was cancelled'));
      return;
    }
    this.response = fakeResponse(s.status, s.headers ?? {}, s.body ?? Buffer.from('file'));
    this.emit('response', this.response);
  }
}

const publicLookup = async (host: string) => (host.endsWith('example.com') ? ['93.184.216.34'] : ['10.0.0.1']);

function setup(
  scripts: Script[],
  options: { lookup?: (host: string) => Promise<string[]>; limits?: Record<string, number> } = {},
) {
  const requests: FakeNetRequest[] = [];
  const request = vi.fn((_profileId: string, url: string) => {
    const r = new FakeNetRequest(url, scripts.shift() ?? 'hang');
    requests.push(r);
    return r as unknown as SessionNetRequest;
  });
  const offSite = {
    stream: new PassThrough(),
    finalUrl: 'x',
    contentType: null,
    contentLength: null,
    dispositionName: null,
  };
  const remote = { open: vi.fn(async (): Promise<RemoteFile> => offSite) } satisfies RemoteFileSource;
  const open = createSessionDownload({
    siteOf: (id) => (id === PROFILE ? 'example.com' : null),
    request,
    remote,
    lookup: options.lookup ?? publicLookup,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const asked: string[] = [];
  const headersFor = vi.fn(async (url: string) => {
    asked.push(url);
    return { cookie: 'sid=secret', userAgent: 'UA' };
  });
  return { open, request, requests, remote, offSite, asked, headersFor };
}

async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function failureOf(promise: Promise<unknown>): Promise<RemoteFileError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RemoteFileError);
  return error as RemoteFileError;
}

describe('session download', () => {
  it('opens an on-site file through the session and reads its answer like the Node source', async () => {
    const t = setup([
      {
        status: 200,
        headers: {
          'content-type': 'Image/JPEG; charset=binary',
          'content-length': '4',
          'content-disposition': 'attachment; filename="a b.jpg"',
        },
      },
    ]);
    const file = await t.open(PROFILE, 'https://img.example.com/1.jpg', new AbortController().signal, {
      headersFor: t.headersFor,
    });
    expect(t.request).toHaveBeenCalledWith(PROFILE, 'https://img.example.com/1.jpg');
    expect(t.asked).toEqual(['https://img.example.com/1.jpg']);
    expect(file).toMatchObject({
      finalUrl: 'https://img.example.com/1.jpg',
      contentType: 'image/jpeg',
      contentLength: 4,
      dispositionName: 'a b.jpg',
    });
    expect((await read(file.stream)).toString()).toBe('file');
    expect(t.remote.open).not.toHaveBeenCalled();
  });

  it('aborts an on-site redirect in its event and sends the next hop through the session again', async () => {
    const t = setup([{ redirect: 'https://example.com/b.jpg' }, { redirect: '/c.jpg', status: 307 }, { status: 200 }]);
    const file = await t.open(PROFILE, 'https://example.com/a.jpg', new AbortController().signal, {
      headersFor: t.headersFor,
    });
    expect(t.requests.map((r) => r.url)).toEqual([
      'https://example.com/a.jpg',
      'https://example.com/b.jpg',
      'https://example.com/c.jpg',
    ]);
    expect(t.requests[0]!.aborted).toBeGreaterThan(0);
    expect(t.requests[1]!.aborted).toBeGreaterThan(0);
    expect(t.asked).toEqual(['https://example.com/a.jpg', 'https://example.com/b.jpg', 'https://example.com/c.jpg']);
    expect(file.finalUrl).toBe('https://example.com/c.jpg');
  });

  it('hands the first hop off the site to the Node source with the same signal and options', async () => {
    const t = setup([{ redirect: 'https://cdn.other.org/1.jpg' }]);
    const signal = new AbortController().signal;
    const options = { headersFor: t.headersFor };
    const file = await t.open(PROFILE, 'https://example.com/a.jpg', signal, options);
    expect(file).toBe(t.offSite);
    expect(t.remote.open).toHaveBeenCalledWith('https://cdn.other.org/1.jpg', signal, options);
    expect(t.request).toHaveBeenCalledTimes(1);
    // The off-site hop is asked by the Node source itself, not here.
    expect(t.asked).toEqual(['https://example.com/a.jpg']);
  });

  it('never sends a URL off the site through the session', async () => {
    const t = setup([]);
    await t.open(PROFILE, 'https://example.com.evil.org/1.jpg', new AbortController().signal, {});
    expect(t.request).not.toHaveBeenCalled();
    expect(t.remote.open).toHaveBeenCalledTimes(1);
  });

  it('refuses a host with a non-public address before any request, and a host that does not resolve', async () => {
    const t = setup([], { lookup: async () => ['93.184.216.34', '192.168.1.5'] });
    expect(
      (await failureOf(t.open(PROFILE, 'https://example.com/1.jpg', new AbortController().signal, {}))).failure,
    ).toBe('address_refused');
    const none = setup([], { lookup: async () => [] });
    expect(
      (await failureOf(none.open(PROFILE, 'https://example.com/1.jpg', new AbortController().signal, {}))).failure,
    ).toBe('unreachable');
    const broken = setup([], {
      lookup: async () => {
        throw new Error('ENOTFOUND example.com');
      },
    });
    const error = await failureOf(broken.open(PROFILE, 'https://example.com/1.jpg', new AbortController().signal, {}));
    expect(error.failure).toBe('unreachable');
    expect(error.cause).toBeUndefined();
    expect(t.request).not.toHaveBeenCalled();
    expect(broken.request).not.toHaveBeenCalled();
  });

  it('vets an on-site redirect target again', async () => {
    const t = setup([{ redirect: 'https://inner.example.com/1.jpg' }], {
      lookup: async (host) => (host === 'example.com' ? ['93.184.216.34'] : ['127.0.0.1']),
    });
    expect(
      (await failureOf(t.open(PROFILE, 'https://example.com/a.jpg', new AbortController().signal, {}))).failure,
    ).toBe('address_refused');
    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it('maps the statuses like the Node source, a browser challenge first', async () => {
    const cases: [Script, string, number | null, number | null][] = [
      [{ status: 403, headers: { 'cf-mitigated': 'challenge' } }, 'challenge', 403, null],
      [{ status: 200, headers: { 'cf-mitigated': ['Challenge'] } }, 'challenge', 200, null],
      [{ redirect: 'https://example.com/x', headers: { 'cf-mitigated': ['challenge'] } }, 'challenge', 302, null],
      [{ status: 403 }, 'blocked', 403, null],
      [{ status: 401 }, 'blocked', 401, null],
      [{ status: 404 }, 'not_found', null, null],
      [{ status: 429, headers: { 'retry-after': '7' } }, 'throttled', null, 7000],
      [{ status: 502 }, 'unavailable', null, null],
      [{ status: 204 }, 'rejected', null, null],
      ['error', 'unreachable', null, null],
    ];
    for (const [script, kind, status, retryAfterMs] of cases) {
      const t = setup([script]);
      const error = await failureOf(t.open(PROFILE, 'https://example.com/a.jpg', new AbortController().signal, {}));
      expect([error.failure, error.status, error.retryAfterMs, error.cause]).toEqual([
        kind,
        status,
        retryAfterMs,
        undefined,
      ]);
      expect(error.message).toBe(`Remote file failure: ${kind}`);
      expect(t.request).toHaveBeenCalledTimes(1);
    }
  });

  it('gives no length for a body Chromium decoded, and checks an announced length against the limit', async () => {
    const t = setup([{ status: 200, headers: { 'content-encoding': 'gzip', 'content-length': '2' } }]);
    const file = await t.open(PROFILE, 'https://example.com/a.jpg', new AbortController().signal, {});
    expect(file.contentLength).toBeNull();
    expect((await read(file.stream)).toString()).toBe('file');
    const big = setup([{ status: 200, headers: { 'content-length': '11' } }], { limits: { maxBytes: 10 } });
    expect(
      (await failureOf(big.open(PROFILE, 'https://example.com/a.jpg', new AbortController().signal, {}))).failure,
    ).toBe('too_large');
    expect(big.requests[0]!.aborted).toBeGreaterThan(0);
  });

  it('fails the body past the size limit and after the idle time', async () => {
    const t = setup([{ status: 200, body: Buffer.alloc(11) }], { limits: { maxBytes: 10 } });
    const file = await t.open(PROFILE, 'https://example.com/a.jpg', new AbortController().signal, {});
    expect((await failureOf(read(file.stream))).failure).toBe('too_large');
    expect(t.requests[0]!.aborted).toBeGreaterThan(0);

    const idle = setup([{ status: 200, body: 'hang' }], { limits: { idleTimeoutMs: 20 } });
    const stalled = await idle.open(PROFILE, 'https://example.com/a.jpg', new AbortController().signal, {});
    expect((await failureOf(read(stalled.stream))).failure).toBe('unreachable');
  });

  it('fails a hop without an answer in time, and after too many redirects', async () => {
    const t = setup(['hang'], { limits: { headerTimeoutMs: 20 } });
    expect(
      (await failureOf(t.open(PROFILE, 'https://example.com/a.jpg', new AbortController().signal, {}))).failure,
    ).toBe('unreachable');
    expect(t.requests[0]!.aborted).toBeGreaterThan(0);
    const loop = setup(
      Array.from({ length: 10 }, (_, i) => ({ redirect: `https://example.com/${i}` })),
      { limits: { maxRedirects: 2 } },
    );
    expect(
      (await failureOf(loop.open(PROFILE, 'https://example.com/a.jpg', new AbortController().signal, {}))).failure,
    ).toBe('rejected');
    expect(loop.request).toHaveBeenCalledTimes(3);
  });

  it('rejects with the abort reason, before and during a hop and while the body is read', async () => {
    const reason = new Error('stopped');
    const before = setup([]);
    const aborted = new AbortController();
    aborted.abort(reason);
    await expect(before.open(PROFILE, 'https://example.com/a.jpg', aborted.signal, {})).rejects.toBe(reason);
    expect(before.request).not.toHaveBeenCalled();

    const during = setup(['hang']);
    const c = new AbortController();
    const pending = during.open(PROFILE, 'https://example.com/a.jpg', c.signal, {});
    await vi.waitFor(() => expect(during.request).toHaveBeenCalled());
    c.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(during.requests[0]!.aborted).toBeGreaterThan(0);

    const body = setup([{ status: 200, body: 'hang' }]);
    const b = new AbortController();
    const file = await body.open(PROFILE, 'https://example.com/a.jpg', b.signal, {});
    const reading = read(file.stream);
    b.abort(reason);
    await expect(reading).rejects.toBe(reason);
  });

  it('fails unreachable when the session cannot send, and rejected for a URL that is not http or https', async () => {
    const open = createSessionDownload({
      siteOf: () => 'example.com',
      request: () => {
        throw new Error('Site logins are not available');
      },
      remote: { open: vi.fn() },
      lookup: publicLookup,
    });
    expect(
      (await failureOf(open(PROFILE, 'https://example.com/a.jpg', new AbortController().signal, {}))).failure,
    ).toBe('unreachable');
    expect((await failureOf(open(PROFILE, 'ftp://example.com/a.jpg', new AbortController().signal, {}))).failure).toBe(
      'rejected',
    );
    expect(
      (await failureOf(open(PROFILE, 'https://u:p@example.com/a.jpg', new AbortController().signal, {}))).failure,
    ).toBe('rejected');
  });
});

describe('session request options', () => {
  it('lets the session send its cookies and user agent and sets no Cookie, User-Agent or Referer by hand', () => {
    const session = {} as Session;
    const options = sessionRequestOptions(session, 'https://example.com/a.jpg');
    expect(options).toEqual({
      method: 'GET',
      url: 'https://example.com/a.jpg',
      session,
      redirect: 'manual',
      useSessionCookies: true,
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      headers: { Accept: '*/*', 'Accept-Encoding': 'identity' },
    });
    expect(SESSION_REQUEST_HEADERS).toEqual({ Accept: '*/*', 'Accept-Encoding': 'identity' });
    expect(Object.keys(options)).not.toContain('credentials');
  });
});

type BeforeRequest = (
  d: { url: string; resourceType: string; webContentsId?: number },
  cb: (r: { cancel?: boolean }) => void,
) => void;

function fakeSession() {
  const events = new EventEmitter();
  const session = {
    beforeRequest: null as BeforeRequest | null,
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    on: (event: string, listener: (...args: unknown[]) => void) => events.on(event, listener),
    webRequest: {
      onBeforeRequest(h: BeforeRequest) {
        session.beforeRequest = h;
      },
    },
    cookies: { get: async () => [] },
    getUserAgent: () => 'UA',
  };
  return session;
}

function electronSessions(withNet: boolean) {
  const sessions = new Map<string, ReturnType<typeof fakeSession>>();
  const fromPartition = (partition: string) => {
    let s = sessions.get(partition);
    if (s === undefined) sessions.set(partition, (s = fakeSession()));
    return s as unknown as Session;
  };
  const netRequest = vi.fn(() => new FakeNetRequest('', 'hang') as unknown as SessionNetRequest);
  const site = createElectronSiteSessions({
    fromPartition,
    createWindow: (_o: BrowserWindowConstructorOptions) => {
      throw new Error('no window in this test');
    },
    resolve: async (host) => (host === 'example.com' ? ['93.184.216.34'] : ['10.0.0.1']),
    ...(withNet ? { netRequest } : {}),
  });
  return { site, netRequest, session: () => sessions.get(sitePartition(PROFILE))! };
}

const decide = (s: ReturnType<typeof fakeSession>, url: string, resourceType: string) =>
  new Promise<{ cancel?: boolean }>((resolve) => s.beforeRequest!({ url, resourceType }, resolve));

describe('electron session requests', () => {
  it("sends a request through the profile's hardened session, and none after shutdown", async () => {
    const e = electronSessions(true);
    e.site.request!(PROFILE, 'https://example.com/a.jpg');
    expect(e.netRequest).toHaveBeenCalledTimes(1);
    const [options] = e.netRequest.mock.calls[0] as unknown as [ReturnType<typeof sessionRequestOptions>];
    expect(options).toEqual(sessionRequestOptions(e.session() as unknown as Session, 'https://example.com/a.jpg'));
    // The request filter of that session also decides the session's own requests: they carry no contents id.
    expect(await decide(e.session(), 'https://example.com/a.jpg', 'other')).toEqual({});
    expect(await decide(e.session(), 'https://intranet.example/a.jpg', 'other')).toEqual({ cancel: true });
    expect(await decide(e.session(), 'http://127.0.0.1/a.jpg', 'other')).toEqual({ cancel: true });
    expect(await decide(e.session(), 'file:///C:/a.jpg', 'other')).toEqual({ cancel: true });
    e.site.shutdown();
    expect(() => e.site.request!(PROFILE, 'https://example.com/a.jpg')).toThrow('Site logins are not available');
    expect(e.netRequest).toHaveBeenCalledTimes(1);
  });

  it('offers no request without net.request', () => {
    expect(electronSessions(false).site.request).toBeUndefined();
  });

  it('gives the site access an open only with a session request and a plain source', async () => {
    const store = { get: (id: string) => (id === PROFILE ? ({ id, site: 'example.com' } as never) : null) };
    const plain = { cookies: async () => [], userAgent: () => 'UA' };
    const remote = { open: vi.fn() };
    expect(createSiteAccess(store, plain, { remote }).open).toBeUndefined();
    const e = electronSessions(true);
    expect(createSiteAccess(store, e.site).open).toBeUndefined();
    const access = createSiteAccess(store, e.site, { remote, lookup: async () => ['93.184.216.34'] });
    expect(access.open).toBeTypeOf('function');
    const c = new AbortController();
    const pending = access.open!(PROFILE, 'https://example.com/a.jpg', c.signal, {}).catch(() => {});
    await vi.waitFor(() => expect(e.netRequest).toHaveBeenCalledTimes(1));
    c.abort();
    await pending;
    expect(remote.open).not.toHaveBeenCalled();
  });
});
