import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteFileError, type PageLoader, type PageLoadResult, type RemoteFileSource } from '@assetforge/core';
import type { SiteSessions } from '../src/main/site-sessions';
import { createHarness, type Harness } from './analysis-harness';

const URL = 'https://example.com/gallery';
const profile = {
  url: URL,
  name: 'Example',
  thumbnails: '//a/@href',
  pagination: '',
  file: '',
  kinds: ['image'] as const,
  minBytes: 0,
  urlContains: '',
  maxPages: 20,
  maxFiles: 1000,
};
const remote: RemoteFileSource = {
  open: async () => {
    throw new RemoteFileError('not_found');
  },
};

/** Browser sessions are mocked; requests and durable jobs use the real application wiring and SQLite. */
function sessions(load?: PageLoader['load']): SiteSessions {
  return {
    openLogin: () => {},
    loginProfileId: () => null,
    focusLogin: () => {},
    clear: async () => {},
    cookies: async () => [],
    userAgent: () => 'test',
    openPage: () => ({
      loader: {
        load:
          load ??
          (async (url): Promise<PageLoadResult> => ({
            ok: true,
            results: { thumbnails: ['/photo.jpg', '/download?id=53'], pagination: [] },
            baseUrl: url,
            finalUrl: url,
          })),
      },
      close: () => {},
    }),
  };
}

describe('durable gallery discovery', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });
  async function open(load?: PageLoader['load']) {
    h = await createHarness({ remote, siteSessions: sessions(load), siteWait: async () => {} });
    const rootPath = join(h.base, 'workspace');
    await mkdir(rootPath, { recursive: true });
    await h.ok('workspace:create', { name: 'Test', rootPath });
    return h.ok('sites:save', { ...profile, kinds: [...profile.kinds] });
  }

  async function ready(crawlId: string) {
    for (let i = 0; i < 100; i++) {
      const task = await h!.ok('sites:getCrawl', { crawlId });
      if (task.status === 'ready') return task;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Discovery did not finish');
  }

  it('queues five galleries separately and retains each result for review without downloads', async () => {
    const saved = await open();
    const tasks = [];
    for (let i = 0; i < 5; i++) {
      tasks.push(await h!.ok('sites:enqueueCrawl', { profileId: saved.id, url: `${URL}/${i}`, target: null }));
    }
    expect(new Set(tasks.map((task) => task.crawlId)).size).toBe(5);
    for (const task of tasks)
      expect((await ready(task.crawlId)).result?.files).toContain('https://example.com/photo.jpg');
    const listed = await h!.ok('sites:listCrawls', {});
    expect(listed.total).toBe(5);
    expect(listed.items.every((task) => task.status === 'ready')).toBe(true);
    expect(listed.items.every((task) => !Object.hasOwn(task, 'candidates'))).toBe(true);
    const jobs = await h!.manager.read((session) => session.database.jobs.list({ limit: 100, offset: 0 }));
    expect(jobs.items.every((job) => job.type === 'site.crawl')).toBe(true);
  });

  it('removes an imported extraction without cancelling pending downloads or deleting its profile or files', async () => {
    const saved = await open();
    const fileId = await h!.importPng({ name: 'existing.png', width: 8, height: 8 });
    const { crawlId } = await h!.ok('sites:enqueueCrawl', { profileId: saved.id, url: URL, target: null });
    await ready(crawlId);
    h!.services.pause.pause('io', saved.site, 'download_browser_check');
    expect((await h!.ok('sites:import', { crawlId, selectedUrls: ['https://example.com/photo.jpg'] })).queued).toBe(1);
    expect((await h!.ok('sites:getCrawl', { crawlId })).status).toBe('imported');
    const before = await h!.manager.read((session) => session.database.jobs.listByStatus('queued'));
    expect(before).toHaveLength(1);
    expect(before[0]?.type).toBe('file.download');
    const removed = await h!.call('sites:removeCrawl' as Parameters<Harness['call']>[0], { crawlId });
    expect(removed).toEqual({ ok: true, value: { removed: true } });
    expect(await h!.ok('sites:listCrawls', {})).toEqual({ items: [], total: 0 });
    expect(await h!.manager.read((session) => session.database.jobs.listByStatus('queued'))).toEqual(before);
    expect(await h!.manager.read((session) => session.database.files.get(fileId))).not.toBeNull();
    expect((await h!.ok('sites:list', {})).profiles.some((item) => item.id === saved.id)).toBe(true);
    expect(await h!.call('sites:removeCrawl' as Parameters<Harness['call']>[0], { crawlId })).toEqual({
      ok: true,
      value: { removed: false },
    });
  });

  it('requires explicit cancellation before removing an active extraction', async () => {
    let started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const saved = await open(
      (_url, request) =>
        new Promise((resolve) => {
          started();
          request.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'failed' }), { once: true });
        }),
    );
    const { crawlId } = await h!.ok('sites:enqueueCrawl', { profileId: saved.id, url: URL, target: null });
    await begun;
    expect(await h!.call('sites:removeCrawl' as Parameters<Harness['call']>[0], { crawlId })).toMatchObject({
      ok: false,
      error: { code: 'invalid_operation' },
    });
    expect((await h!.ok('sites:getCrawl', { crawlId })).status).toBe('running');
    await h!.ok('sites:cancelCrawl', { crawlId });
    await h!.until((summary) => summary.cancelled === 1);
    expect(await h!.call('sites:removeCrawl' as Parameters<Harness['call']>[0], { crawlId })).toEqual({
      ok: true,
      value: { removed: true },
    });
  });

  it('imports cancelled partial results, permits profile edits and removes only the review entry', async () => {
    let blocked!: () => void;
    const secondDetail = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    const saved = await open((url, request) => {
      if (url === URL)
        return Promise.resolve({
          ok: true,
          results: { thumbnails: ['/detail/1', '/detail/2'], pagination: [] },
          baseUrl: url,
          finalUrl: url,
        });
      if (url.endsWith('/1'))
        return Promise.resolve({ ok: true, results: { file: ['/partial.jpg'] }, baseUrl: url, finalUrl: url });
      return new Promise((resolve) => {
        blocked();
        request.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'failed' }), { once: true });
      });
    });
    const initial = await h!.ok('sites:save', {
      ...profile,
      kinds: [...profile.kinds],
      id: saved.id,
      file: '//a/@href',
      detailConcurrency: 1,
      requestGapMs: 0,
    });
    const { crawlId } = await h!.ok('sites:enqueueCrawl', { profileId: saved.id, url: URL, target: null });
    await secondDetail;
    await h!.ok('sites:cancelCrawl', { crawlId });
    await h!.until((summary) => summary.cancelled === 1);
    const partial = await h!.ok('sites:getCrawl', { crawlId });
    expect(partial.status).toBe('cancelled');
    expect(partial.result?.files).toContain('https://example.com/partial.jpg');
    await h!.ok('sites:save', { ...initial, minBytes: 500, kinds: ['document'] });
    h!.services.pause.pause('io', saved.site, 'download_browser_check');
    expect((await h!.ok('sites:import', { crawlId, selectedUrls: ['https://example.com/partial.jpg'] })).queued).toBe(
      1,
    );
    const downloads = await h!.manager.read((session) => session.database.jobs.listByStatus('queued'));
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.payload).toMatchObject({ filter: { kinds: ['image'], minBytes: 0 } });
    expect(await h!.call('sites:removeCrawl' as Parameters<Harness['call']>[0], { crawlId })).toEqual({
      ok: true,
      value: { removed: true },
    });
    expect(await h!.manager.read((session) => session.database.jobs.listByStatus('queued'))).toEqual(downloads);
    expect((await h!.ok('sites:list', {})).profiles.find((item) => item.id === saved.id)).toMatchObject({
      minBytes: 500,
      kinds: ['document'],
    });
  });

  it('retains completed review results when the workspace is closed and reopened', async () => {
    const saved = await open();
    const { crawlId } = await h!.ok('sites:enqueueCrawl', { profileId: saved.id, url: URL, target: null });
    const result = await ready(crawlId);
    const summary = h!.manager.current()!;
    await h!.ok('workspace:close', {});
    await h!.ok('workspace:open', { rootPath: summary.rootPath });
    expect((await h!.ok('sites:getCrawl', { crawlId })).result).toEqual(result.result);
  });

  it('does not turn a login-blocked partial crawl into a ready result when job history is cleared', async () => {
    const saved = await open(async () => ({ ok: false, reason: 'http_error', status: 401 }));
    const { crawlId } = await h!.ok('sites:enqueueCrawl', { profileId: saved.id, url: URL, target: null });
    await h!.until((summary) => summary.failed === 1);
    expect((await h!.ok('sites:getCrawl', { crawlId })).status).toBe('failed');
    await h!.ok('jobs:clearFinished', {});
    expect((await h!.ok('sites:getCrawl', { crawlId })).status).toBe('failed');
  });

  it('recreates a cleared technical job when retrying its retained discovery', async () => {
    let authorized = false;
    const saved = await open(async (url) =>
      authorized
        ? { ok: true, results: { thumbnails: ['/photo.jpg'], pagination: [] }, baseUrl: url, finalUrl: url }
        : { ok: false, reason: 'http_error', status: 401 },
    );
    const { crawlId } = await h!.ok('sites:enqueueCrawl', { profileId: saved.id, url: URL, target: null });
    await h!.until((summary) => summary.failed === 1);
    await h!.ok('jobs:clearFinished', {});
    authorized = true;
    expect(await h!.ok('sites:retryCrawl', { crawlId })).toEqual({ retried: true });
    expect((await ready(crawlId)).result?.files).toContain('https://example.com/photo.jpg');
  });

  it('holds a throttled site for at least the shared fallback delay', async () => {
    const saved = await open(async () => ({ ok: false, reason: 'http_error', status: 429 }));
    const { crawlId } = await h!.ok('sites:enqueueCrawl', { profileId: saved.id, url: URL, target: null });
    await h!.until((summary) => summary.waiting === 1);
    const job = await h!.manager.read((session) => session.database.jobs.get(crawlId));
    expect(job?.errorCode).toBe('download_throttled');
    // The scheduler may stamp updatedAt just after calculating runAfter; allow timing drift, never the old 5 s fallback.
    expect(Date.parse(job!.runAfter!) - Date.parse(job!.updatedAt)).toBeGreaterThanOrEqual(59_000);
  });

  it('rechecks live names, retains skipped review, honors overrides and preserves the captured target', async () => {
    const saved = await open(async (url) => ({
      ok: true,
      results: { thumbnails: ['/photo.png', '/other.png', '/download?id=53'], pagination: [] },
      baseUrl: url,
      finalUrl: url,
    }));
    const [type] = await h!.ok('assetTypes:list', {});
    const asset = await h!.ok('assets:create', { name: 'Captured asset', typeId: type!.id });
    const other = await h!.ok('assets:create', { name: 'Other asset', typeId: type!.id });
    const target = { assetId: asset.id, role: 'reference' as const };
    const { crawlId } = await h!.ok('sites:enqueueCrawl', { profileId: saved.id, url: URL, target });
    const preview = await ready(crawlId);
    expect(preview.targetAssetName).toBe('Captured asset');
    expect(preview.candidates.find((candidate) => candidate.expectedName === 'photo.png')?.alreadyPresent).toBe(false);
    expect(preview.candidates.find((candidate) => candidate.url.includes('id=53'))?.expectedName).toBeNull();
    await h!.importPng({ name: 'photo.png', width: 8, height: 8, target });
    const photo = 'https://example.com/photo.png';
    const skipped = await h!.ok('sites:import', { crawlId, selectedUrls: [photo], skipExistingNames: true });
    expect(skipped.queued).toBe(0);
    expect((await h!.ok('sites:getCrawl', { crawlId })).status).toBe('ready');
    const forced = await h!.ok('sites:import', {
      crawlId,
      selectedUrls: [photo],
      skipExistingNames: true,
      includeExistingUrls: [photo],
      target: { assetId: other.id, role: 'concept' },
    });
    expect(forced.queued).toBe(1);
    const next = await h!.ok('sites:import', {
      crawlId,
      selectedUrls: ['https://example.com/other.png'],
      skipExistingNames: true,
    });
    expect(next.queued).toBe(1);
    const downloads = await h!.manager.read(async (session) => {
      const jobs = await session.database.jobs.list({ limit: 100, offset: 0 });
      return Promise.all(
        jobs.items.filter((job) => job.type === 'file.download').map((job) => session.database.jobs.get(job.id)),
      );
    });
    expect(downloads).toHaveLength(2);
    expect(downloads.every((job) => (job?.payload as { target: unknown }).target !== null)).toBe(true);
    for (const job of downloads) expect(job?.payload).toMatchObject({ target });
  });
});
