import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileRecord, JobSummary, JobView } from '@assetforge/contracts';
import { createUrlSource, type UrlSourceOptions } from '@assetforge/storage';
import type { SchedulerClock } from '../src/main/job-host.js';
import { createHarness, type Harness } from './analysis-harness.js';
import { pngOf } from './png-fixture.js';

// Records how the composition builds its URL source, and still builds the real one.
const sourceOptions = vi.hoisted(() => [] as unknown[]);
vi.mock('@assetforge/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assetforge/storage')>();
  return {
    ...actual,
    createUrlSource: (options: UrlSourceOptions) => {
      sourceOptions.push(options);
      return actual.createUrlSource(options);
    },
  };
});

type Route = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface TestServer {
  /** `127.0.0.1:<port>`: the lane of its downloads. */
  host: string;
  url(path: string): string;
  /** Every request it received, in order. */
  requests: { path: string; headers: http.IncomingHttpHeaders }[];
  /** Answers every request; serves `files` as PNG and 404 otherwise until replaced. */
  route: Route;
  files: Map<string, Buffer>;
  close(): Promise<void>;
}

/** An HTTP server on 127.0.0.1 with an ephemeral port. */
async function startServer(): Promise<TestServer> {
  const files = new Map<string, Buffer>();
  const serveFiles: Route = (req, res) => {
    const body = files.get(req.url ?? '');
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length }).end(body);
  };
  const server = http.createServer((req, res) => {
    test.requests.push({ path: req.url ?? '', headers: req.headers });
    test.route(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const test: TestServer = {
    host: `127.0.0.1:${port}`,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    requests: [],
    route: serveFiles,
    files,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return test;
}

/** A scheduler clock that only moves when the test advances it; due timers fire then. */
function manualClock(): SchedulerClock & { advance(ms: number): void } {
  let offset = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void; handle: ReturnType<typeof setTimeout> | null }>();
  const fire = (id: number) => {
    const timer = timers.get(id);
    if (timer === undefined) return;
    timers.delete(id);
    timer.fn();
  };
  return {
    now: () => new Date(Date.now() + offset),
    setTimer(fn, ms) {
      const id = ++next;
      const at = Date.now() + offset + Math.max(ms, 0);
      // A timer that is due already fires on its own, as a real one would.
      timers.set(id, { at, fn, handle: ms <= 0 ? setTimeout(() => fire(id), 0) : null });
      return id;
    },
    clearTimer(id) {
      const timer = timers.get(id as number);
      if (timer?.handle != null) clearTimeout(timer.handle);
      timers.delete(id as number);
    },
    advance(ms) {
      offset += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= Date.now() + offset) setTimeout(() => fire(id), 0);
    },
  };
}

const page = { limit: 100, offset: 0 };
const active = (s: JobSummary) => s.queued + s.running + s.waiting;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('URL import', () => {
  let h: Harness | undefined;
  const servers: TestServer[] = [];
  let clock: ReturnType<typeof manualClock>;
  /** While true, opening a workspace does not start its jobs. */
  let holdJobs = false;

  afterEach(async () => {
    await h?.close();
    h = undefined;
    await Promise.all(servers.splice(0).map((s) => s.close()));
    holdJobs = false;
  });

  async function server(): Promise<TestServer> {
    const s = await startServer();
    servers.push(s);
    return s;
  }

  const rootPath = () => join(h!.base, 'workspace');

  /** The harness with a URL source that may reach this machine, the manual clock and an open workspace. */
  async function open(o: { remote?: 'test' | 'app' } = {}): Promise<Harness> {
    clock = manualClock();
    const harness = await createHarness({
      clock,
      ...(o.remote === 'app'
        ? {}
        : { remote: createUrlSource({ userAgent: 'AssetForge/test', allowAddress: () => true }) }),
      host: {
        workspaceOpened: async () => {
          if (!holdJobs) await harness.services.workspaceOpened();
        },
      },
    });
    h = harness;
    await harness.ok('workspace:create', { name: 'Downloads', rootPath: rootPath() });
    return harness;
  }

  const jobs = async (): Promise<JobView[]> => (await h!.ok('jobs:list', page)).items;
  const files = async (scope: { kind: 'all' } | { kind: 'inbox' } | { kind: 'asset'; assetId: string }) =>
    (await h!.ok('files:list', { ...page, scope })).items as FileRecord[];
  const origins = (fileId: string) => h!.ok('files:origins', { fileId });

  it('downloads three URLs into the inbox, each file with its origin, and skips them the next time', async () => {
    const a = await server();
    const urls = ['/one.png', '/two.png', '/three.png'].map((path, i) => {
      a.files.set(path, pngOf(4, 4, i));
      return a.url(path);
    });
    const harness = await open();

    expect(await harness.ok('files:importUrls', { urls })).toEqual({
      queued: 3,
      alreadyImported: 0,
      alreadyQueued: 0,
      invalid: [],
    });
    await harness.until((s) => s.succeeded === 3 && active(s) === 0);

    const inbox = await files({ kind: 'inbox' });
    expect(inbox.map((f) => f.originalName).sort()).toEqual(['one.png', 'three.png', 'two.png']);
    for (const file of inbox) {
      expect(file.status).toBe('complete');
      expect((await origins(file.id)).map((o) => o.url)).toEqual([a.url(`/${file.originalName}`)]);
    }
    const list = await jobs();
    expect(list.map((j) => j.url).sort()).toEqual([...urls].sort());
    for (const job of list)
      expect(job).toMatchObject({ type: 'file.download', status: 'succeeded', host: a.host, result: null });
    expect(new Set(list.map((j) => j.fileId))).toEqual(new Set(inbox.map((f) => f.id)));

    for (const request of a.requests) {
      expect(request.headers['user-agent']).toBe('AssetForge/test');
      expect(request.headers['cookie']).toBeUndefined();
      expect(request.headers['referer']).toBeUndefined();
    }
    expect(a.requests).toHaveLength(3);

    expect(await harness.ok('files:importUrls', { urls })).toEqual({
      queued: 0,
      alreadyImported: 3,
      alreadyQueued: 0,
      invalid: [],
    });
    await pause(100);
    expect(a.requests).toHaveLength(3);
    expect(await jobs()).toHaveLength(3);

    // No URL ever reaches the main console.
    for (const line of harness.logs) expect(line).not.toContain(a.host);
  });

  it('gives identical bytes from a second URL to the existing file, and stores them again without skipDuplicates', async () => {
    const a = await server();
    const bytes = pngOf(4, 4, 9);
    for (const path of ['/first.png', '/second.png', '/third.png']) a.files.set(path, bytes);
    const harness = await open();

    await harness.ok('files:importUrls', { urls: [a.url('/first.png')] });
    await harness.until((s) => s.succeeded === 1 && active(s) === 0);
    await harness.ok('files:importUrls', { urls: [a.url('/second.png')] });
    await harness.until((s) => s.succeeded === 2 && active(s) === 0);

    const inbox = await files({ kind: 'all' });
    expect(inbox).toHaveLength(1);
    expect((await origins(inbox[0]!.id)).map((o) => o.url)).toEqual([a.url('/first.png'), a.url('/second.png')]);
    const second = (await jobs()).find((j) => j.url === a.url('/second.png'))!;
    expect(second).toMatchObject({ status: 'succeeded', result: 'already_present', fileId: inbox[0]!.id });

    await harness.ok('files:importUrls', { urls: [a.url('/third.png')], skipDuplicates: false });
    await harness.until((s) => s.succeeded === 3 && active(s) === 0);
    const all = await files({ kind: 'all' });
    expect(all).toHaveLength(2);
    const third = (await jobs()).find((j) => j.url === a.url('/third.png'))!;
    expect(third.result).toBeNull();
    expect(third.fileId).not.toBe(inbox[0]!.id);
    expect((await origins(third.fileId!)).map((o) => o.url)).toEqual([a.url('/third.png')]);
  });

  it('places a download in the target asset with its role', async () => {
    const a = await server();
    a.files.set('/door.png', pngOf(4, 4, 3));
    const harness = await open();
    const [type] = await harness.ok('assetTypes:list', {});
    const asset = await harness.ok('assets:create', { name: 'Door', typeId: type!.id });

    await harness.ok('files:importUrls', {
      urls: [a.url('/door.png')],
      target: { assetId: asset.id, role: 'reference' },
    });
    await harness.until((s) => s.succeeded === 1 && active(s) === 0);

    expect(await files({ kind: 'inbox' })).toEqual([]);
    expect(await files({ kind: 'asset', assetId: asset.id })).toMatchObject([
      { originalName: 'door.png', role: 'reference', assetId: asset.id, status: 'complete' },
    ]);
  });

  it('fails a 404 without leaving a file row', async () => {
    const a = await server();
    const harness = await open();

    await harness.ok('files:importUrls', { urls: [a.url('/missing.png')] });
    await harness.until((s) => s.failed === 1 && active(s) === 0);

    expect(await jobs()).toMatchObject([{ status: 'failed', errorCode: 'download_not_found', fileId: null }]);
    expect(await files({ kind: 'inbox' })).toEqual([]);
    expect(await files({ kind: 'all' })).toEqual([]);
    expect(a.requests).toHaveLength(1);
  });

  it('holds a throttled host while another host serves, and runs its jobs once the wait is over', async () => {
    const a = await server();
    const b = await server();
    a.files.set('/a1.png', pngOf(4, 4, 1));
    a.files.set('/a2.png', pngOf(4, 4, 2));
    b.files.set('/b1.png', pngOf(4, 4, 3));
    const serveA = a.route;
    a.route = (_req, res) => {
      res.writeHead(429, { 'Retry-After': '30' }).end();
    };
    const harness = await open();

    await harness.ok('files:importUrls', { urls: [a.url('/a1.png'), a.url('/a2.png'), b.url('/b1.png')] });
    await harness.until((s) => s.succeeded === 1 && s.waiting === 2 && s.running === 0 && s.queued === 0);

    const list = await jobs();
    expect(list.find((j) => j.host === b.host)).toMatchObject({ status: 'succeeded' });
    const ofA = list.filter((j) => j.host === a.host);
    expect(ofA).toHaveLength(2);
    for (const job of ofA) expect(job).toMatchObject({ status: 'retry_wait', errorCode: 'download_throttled' });
    expect((await files({ kind: 'inbox' })).map((f) => f.originalName)).toEqual(['b1.png']);
    expect((await harness.ok('jobs:summary', {})).pausedHosts).toEqual([]);

    // Nothing runs before the wait is over.
    const asked = a.requests.length;
    await pause(100);
    expect(a.requests).toHaveLength(asked);

    a.route = serveA;
    clock.advance(31_000);
    await harness.until((s) => s.succeeded === 3 && active(s) === 0);
    expect((await files({ kind: 'inbox' })).map((f) => f.originalName).sort()).toEqual(['a1.png', 'a2.png', 'b1.png']);
  });

  it('pauses a host after three refusals, keeps its further jobs queued and runs them after jobs:resumeHost', async () => {
    const a = await server();
    for (const n of [1, 2, 3, 4, 5]) a.files.set(`/r${n}.png`, pngOf(4, 4, n));
    const serveA = a.route;
    a.route = (_req, res) => {
      res.writeHead(403).end();
    };
    const harness = await open();

    await harness.ok('files:importUrls', { urls: [1, 2, 3].map((n) => a.url(`/r${n}.png`)) });
    const paused = await harness.until((s) => s.failed === 3 && active(s) === 0 && s.pausedHosts.length === 1);
    expect(paused.pausedHosts).toEqual([{ host: a.host, reason: 'download_forbidden' }]);
    expect(paused.paused).toEqual([]);
    for (const job of await jobs()) expect(job).toMatchObject({ status: 'failed', errorCode: 'download_forbidden' });

    a.route = serveA;
    await harness.ok('files:importUrls', { urls: [4, 5].map((n) => a.url(`/r${n}.png`)) });
    await pause(150);
    const held = await harness.ok('jobs:summary', {});
    expect(held).toMatchObject({ queued: 2, running: 0 });
    expect(a.requests).toHaveLength(3);

    expect(await harness.ok('jobs:resumeHost', { host: a.host })).toEqual({});
    const done = await harness.until((s) => s.succeeded === 2 && active(s) === 0);
    expect(done.pausedHosts).toEqual([]);
    expect((await files({ kind: 'inbox' })).map((f) => f.originalName).sort()).toEqual(['r4.png', 'r5.png']);
  });

  it('leaves no row of a download cut off by closing the workspace and downloads it again after reopening', async () => {
    const a = await server();
    const bytes = pngOf(64, 64, 7);
    a.files.set('/slow.png', bytes);
    const serveA = a.route;
    let arrived!: () => void;
    const first = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    // The first answer sends half of the body and then holds the rest.
    a.route = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length });
      res.write(bytes.subarray(0, bytes.length >> 1));
      arrived();
    };
    const harness = await open();

    await harness.ok('files:importUrls', { urls: [a.url('/slow.png')] });
    await first;
    await harness.until((s) => s.running === 1);

    holdJobs = true;
    await harness.ok('workspace:close', {});
    a.route = serveA;
    await harness.ok('workspace:open', { rootPath: rootPath() });

    expect(await files({ kind: 'all' })).toEqual([]);
    expect(await jobs()).toMatchObject([{ status: 'queued', fileId: null }]);

    holdJobs = false;
    await harness.services.workspaceOpened();
    await harness.until((s) => s.succeeded === 1 && active(s) === 0);
    const all = await files({ kind: 'all' });
    expect(all).toMatchObject([{ originalName: 'slow.png', status: 'complete', sizeBytes: bytes.length }]);
    expect((await origins(all[0]!.id)).map((o) => o.url)).toEqual([a.url('/slow.png')]);
    expect(a.requests).toHaveLength(2);
  });

  it('refuses this machine with the URL source the app builds', async () => {
    const a = await server();
    a.files.set('/x.png', pngOf(4, 4, 0));
    sourceOptions.length = 0;
    const harness = await open({ remote: 'app' });
    // The app's source: its user agent, no address policy of its own, so public addresses only.
    expect(sourceOptions).toEqual([{ userAgent: 'AssetForge/test' }]);

    await harness.ok('files:importUrls', { urls: [a.url('/x.png')] });
    await harness.until((s) => s.failed === 1 && active(s) === 0);

    expect(await jobs()).toMatchObject([{ status: 'failed', errorCode: 'download_address_refused', host: a.host }]);
    expect(await files({ kind: 'all' })).toEqual([]);
    expect(a.requests).toEqual([]);
  });
});
