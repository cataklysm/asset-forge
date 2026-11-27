import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileRecord, JobSummary, SiteProfile } from '@assetforge/contracts';
import { createUrlSource } from '@assetforge/storage';
import { createPageLoader, createSiteAccess, type PageView, type SiteSessions } from '../src/main/site-sessions.js';
import { createHarness, type Harness } from './analysis-harness.js';
import { pngOf } from './png-fixture.js';

// A site import end to end: a crawl over two gallery pages and their detail pages, the import, and the downloads with
// the profile's login. A real hidden window cannot run under ELECTRON_RUN_AS_NODE, so the page view is jsdom fed by
// plain HTTP, and the extraction script runs in the jsdom window as it would in the page's isolated world.

// jsdom ships no types here; only the constructor is used.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string; runScripts: 'outside-only' }) => { window: { eval(code: string): unknown; close(): void } };
};

const COOKIE_VALUE = 'secret-session-value';

interface Server {
  origin: string;
  requests: { path: string; headers: http.IncomingHttpHeaders }[];
  close(): Promise<void>;
}

/** An HTTP server on a loopback address (`127.0.0.1` or `::1`) with an ephemeral port. */
async function serve(route: (req: http.IncomingMessage, res: http.ServerResponse) => void, address = '127.0.0.1'): Promise<Server> {
  const requests: Server['requests'] = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url ?? '', headers: req.headers });
    route(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, address, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${address.includes(':') ? `[${address}]` : address}:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Plain GET without following redirects; the browser stand-in. */
function get(url: string): Promise<{ status: number; location: string | null; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null, body }));
      })
      .on('error', reject);
  });
}

/** A page view on jsdom; a redirect off the site is refused as the window's navigation guard refuses it. */
function jsdomView(site: string): PageView {
  let page: { window: { eval(code: string): unknown; close(): void } } | null = null;
  const left: (() => void)[] = [];
  return {
    async navigate(url) {
      let target = url;
      for (let hop = 0; hop < 5; hop++) {
        const answer = await get(target);
        if (answer.status >= 300 && answer.status < 400 && answer.location !== null) {
          target = new URL(answer.location, target).href;
          if (new URL(target).hostname !== site) {
            for (const listener of left) listener();
            return 'aborted';
          }
          continue;
        }
        if (answer.status !== 200) return 'failed';
        page?.window.close();
        page = new JSDOM(answer.body, { url: target, runScripts: 'outside-only' });
        return 'loaded';
      }
      return 'failed';
    },
    evaluate: async (code) => page?.window.eval(code),
    stop() {},
    onLeftSite: (listener) => left.push(listener),
  };
}

const active = (s: JobSummary) => s.queued + s.running + s.waiting;

describe('site import', () => {
  let h: Harness | undefined;
  const servers: Server[] = [];

  afterEach(async () => {
    await h?.close();
    h = undefined;
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it('crawls a paginated gallery, imports what it found and downloads with the login only on the site', async () => {
    // Off the site: the IPv6 loopback of this machine. It must never see the login.
    const cdn = await serve((req, res) => {
      if (req.url === '/files/3.png') res.writeHead(200, { 'Content-Type': 'image/png' }).end(pngOf(4, 4, 3));
      else res.writeHead(404).end();
    }, '::1');
    servers.push(cdn);
    const site = await serve((req, res) => {
      const url = req.url ?? '';
      const html = (body: string) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><html><body>${body}</body></html>`);
      if (url === '/robots.txt') res.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nDisallow: /private/\n');
      else if (url === '/gallery')
        html('<a class="thumb" href="/detail/1">1</a><a class="thumb" href="/detail/2">2</a><a class="next" href="/gallery?page=2">next</a>');
      else if (url === '/gallery?page=2') html(`<a class="thumb" href="/detail/3">3</a><a class="thumb" href="/private/4">4</a><a class="thumb" href="/away">5</a>`);
      else if (url === '/detail/1') html('<img id="full" src="/files/1.png">');
      else if (url === '/detail/2') html('<img id="full" src="/files/2.png">');
      else if (url === '/detail/3') html(`<img id="full" src="${cdn.origin}/files/3.png">`);
      else if (url === '/away') res.writeHead(302, { Location: `${cdn.origin}/files/9.png` }).end();
      else if (/^\/files\/[12]\.png$/.test(url)) {
        if (req.headers.cookie !== `sid=${COOKIE_VALUE}`) res.writeHead(403).end();
        else res.writeHead(200, { 'Content-Type': 'image/png' }).end(pngOf(4, 4, Number(url[7])));
      } else res.writeHead(404).end();
    });
    servers.push(site);

    let store: { get(id: string): SiteProfile | null } | null = null;
    const pagesOpened: string[] = [];
    let pagesClosed = 0;
    const sessions: SiteSessions = {
      openLogin: () => {
        throw new Error('No login window in this test');
      },
      loginProfileId: () => null,
      focusLogin: () => {},
      openPage(profile) {
        pagesOpened.push(profile.id);
        return { loader: createPageLoader(jsdomView(profile.site), profile.site, { pollMs: 5, settleMs: 1000, totalMs: 5000 }), close: () => void pagesClosed++ };
      },
      cookies: async () => [{ name: 'sid', value: COOKIE_VALUE }],
      userAgent: () => 'Browser agent/1.0',
      clear: async () => {},
    };
    h = await createHarness({
      remote: createUrlSource({ userAgent: 'AssetForge/test', allowAddress: () => true }),
      siteSessions: sessions,
      siteWait: async () => {},
    });
    const root = join(h.base, 'workspace');
    await mkdir(root, { recursive: true });
    await h.ok('workspace:create', { name: 'Sites', rootPath: root });

    const profile = await h.ok('sites:save', {
      url: `${site.origin}/gallery`,
      name: 'Local gallery',
      thumbnails: '//a[@class="thumb"]',
      pagination: '//a[@class="next"]',
      file: '//img[@id="full"]',
      kinds: ['image'],
      minBytes: 0,
      urlContains: '',
      maxPages: 20,
      maxFiles: 1000,
    });
    expect(profile.site).toBe('127.0.0.1');
    store = { get: (id) => (id === profile.id ? profile : null) };

    const crawl = await h.ok('sites:crawl', { profileId: profile.id, url: `${site.origin}/gallery` });
    expect(crawl).toMatchObject({
      files: [`${site.origin}/files/1.png`, `${site.origin}/files/2.png`, `${cdn.origin}/files/3.png`],
      pages: 2,
      disallowed: 1,
      cancelled: false,
      truncated: null,
    });
    expect(pagesOpened).toEqual([profile.id]);
    expect(pagesClosed).toBe(1);

    expect(await h.ok('sites:import', { crawlId: crawl.crawlId, target: null })).toEqual({
      queued: 3,
      alreadyImported: 0,
      alreadyQueued: 0,
      invalid: [],
    });
    await h.until((s) => active(s) === 0 && s.succeeded + s.failed === 3);
    const summary = await h.ok('jobs:summary', {});
    expect(summary.succeeded).toBe(3);

    const inbox = (await h.ok('files:list', { limit: 100, offset: 0, scope: { kind: 'inbox' } })).items as FileRecord[];
    expect(inbox.map((f) => f.originalName).sort()).toEqual(['1.png', '2.png', '3.png']);

    // The login goes to the site only, with the session's own user agent; robots.txt is read without it.
    const fileRequests = site.requests.filter((r) => r.path.startsWith('/files/'));
    expect(fileRequests).toHaveLength(2);
    for (const r of fileRequests) {
      expect(r.headers.cookie).toBe(`sid=${COOKIE_VALUE}`);
      expect(r.headers['user-agent']).toBe('Browser agent/1.0');
      expect(r.headers.referer).toBeUndefined();
    }
    const robots = site.requests.filter((r) => r.path === '/robots.txt');
    expect(robots).toHaveLength(1);
    expect(robots[0]!.headers.cookie).toBeUndefined();
    expect(robots[0]!.headers['user-agent']).toBe('AssetForge/test');
    const offSite = cdn.requests.filter((r) => r.path === '/files/3.png');
    expect(offSite).toHaveLength(1);
    expect(offSite[0]!.headers.cookie).toBeUndefined();
    expect(offSite[0]!.headers['user-agent']).toBe('AssetForge/test');

    // The cookie value is in no answer, no log line and no job row.
    for (const text of [...h.responses, ...h.logs]) expect(text).not.toContain(COOKIE_VALUE);
    const rows = await h.manager.read((s) => s.database.jobs.listByStatus('succeeded'));
    expect(JSON.stringify(rows)).not.toContain(COOKIE_VALUE);

    // The access as wired answers nothing for a URL off the site and nothing for an unknown profile.
    const access = createSiteAccess(store, sessions);
    expect(await access.headersFor(profile.id, `${cdn.origin}/files/3.png`)).toBeNull();
    expect(await access.has(crypto.randomUUID())).toBe(false);
  });
});
