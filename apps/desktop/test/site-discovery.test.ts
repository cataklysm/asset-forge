import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteFileError, type PageLoader, type PageLoadResult, type RemoteFileSource } from '@assetforge/core';
import type { SiteSessions } from '../src/main/site-sessions';
import { createHarness, type Harness } from './analysis-harness';

const URL = 'https://example.com/gallery';
const profile = { url: URL, name: 'Example', thumbnails: '//a/@href', pagination: '', file: '', kinds: ['image'] as const,
  minBytes: 0, urlContains: '', maxPages: 20, maxFiles: 1000 };
const remote: RemoteFileSource = { open: async () => { throw new RemoteFileError('not_found'); } };

/** Browser sessions are mocked; requests and durable jobs use the real application wiring and SQLite. */
function sessions(load?: PageLoader['load']): SiteSessions {
  return {
    openLogin: () => {}, loginProfileId: () => null, focusLogin: () => {}, clear: async () => {},
    cookies: async () => [], userAgent: () => 'test',
    openPage: () => ({ loader: { load: load ?? (async (url): Promise<PageLoadResult> => ({
      ok: true, results: { thumbnails: ['/photo.jpg', '/download?id=53'], pagination: [] }, baseUrl: url, finalUrl: url,
    })) }, close: () => {} }),
  };
}

describe('durable gallery discovery', () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.close(); h = undefined; });
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
    for (const task of tasks) expect((await ready(task.crawlId)).result?.files).toContain('https://example.com/photo.jpg');
    const listed = await h!.ok('sites:listCrawls', {});
    expect(listed.total).toBe(5);
    expect(listed.items.every((task) => task.status === 'ready')).toBe(true);
    expect(listed.items.every((task) => !Object.hasOwn(task, 'candidates'))).toBe(true);
    const jobs = await h!.manager.read((session) => session.database.jobs.list({ limit: 100, offset: 0 }));
    expect(jobs.items.every((job) => job.type === 'site.crawl')).toBe(true);
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

  it('holds a throttled site for at least the shared fallback delay', async () => {
    const saved = await open(async () => ({ ok: false, reason: 'http_error', status: 429 }));
    const { crawlId } = await h!.ok('sites:enqueueCrawl', { profileId: saved.id, url: URL, target: null });
    await h!.until((summary) => summary.waiting === 1);
    const job = await h!.manager.read((session) => session.database.jobs.get(crawlId));
    expect(job?.errorCode).toBe('download_throttled');
    expect(Date.parse(job!.runAfter!) - Date.parse(job!.updatedAt)).toBeGreaterThanOrEqual(60_000);
  });
});
