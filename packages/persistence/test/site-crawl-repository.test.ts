import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { SiteCrawlProgress, SiteCrawlResult, SiteProfile } from '@assetforge/contracts';
import type { NewJob, WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const T0 = '2026-11-28T12:00:00.000Z';
const T1 = '2026-11-28T12:01:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const profile: SiteProfile = {
  id: uuid(1),
  name: 'Reference gallery',
  site: 'example.com',
  thumbnails: '//a/@href',
  pagination: '',
  file: '//img/@src',
  kinds: ['image'],
  minBytes: 0,
  urlContains: '',
  maxPages: 20,
  maxFiles: 1000,
};
const progress: SiteCrawlProgress = { pages: 0, files: 0, cancelling: false };
const result = (id: string): SiteCrawlResult => ({
  crawlId: id,
  files: ['https://example.com/original.jpg'],
  pages: 1,
  duplicates: 0,
  filtered: 0,
  disallowed: 0,
  invalid: 0,
  offSite: 0,
  pageFailures: 0,
  truncated: null,
  cancelled: false,
  problems: [],
  problemsDropped: 0,
});
const record = (n: number) => ({
  id: uuid(n),
  profile,
  galleryUrl: `https://example.com/gallery/${n}`,
  target: { assetId: uuid(100), role: 'reference' as const },
  targetAssetName: 'Captured asset',
  progress,
  result: null as SiteCrawlResult | null,
  checkpoint: null as unknown,
  importedAt: null as string | null,
  completedAt: null as string | null,
  createdAt: T0,
  updatedAt: T0,
});

let dir: string;
let path: string;
let db: WorkspaceDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-crawls-'));
  path = join(dir, 'workspace.db');
  db = await openWorkspaceDatabase(path, MIGRATIONS_FOLDER);
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('durable site crawl results', () => {
  test('removes only finished review metadata and preserves the technical job', async () => {
    const row = record(10);
    await db.siteCrawls.insert(row, {
      id: row.id, type: 'site.crawl', resourceClass: 'cpu', fileId: null, lane: 'example.com',
      payload: { v: 1, crawlId: row.id }, dedupeKey: null,
    });
    const repository = db.siteCrawls as typeof db.siteCrawls & { remove(id: string): Promise<boolean> };
    expect(repository).toHaveProperty('remove');
    await expect(repository.remove(row.id)).rejects.toMatchObject({ code: 'invalid_operation' });
    await db.jobs.claimNext({ resourceClass: 'cpu', types: ['site.crawl'], now: T0 });
    await db.jobs.finish(row.id, { status: 'succeeded', errorCode: null, now: T1 });
    const finishedJob = await db.jobs.get(row.id);
    expect(await repository.remove(row.id)).toBe(true);
    expect(await db.siteCrawls.get(row.id)).toBeNull();
    expect(await db.jobs.get(row.id)).toEqual(finishedJob);
    expect(await repository.remove(row.id)).toBe(false);
  });
  test('lists lightweight task headers without decoding full review results or checkpoints', async () => {
    const row = {
      ...record(10),
      result: { ...result(uuid(10)), cancelled: true },
      checkpoint: { pending: ['detail'] },
    };
    await db.siteCrawls.insert(row);
    const sqlite = new Database(path);
    try {
      // A schema-incompatible review payload must not affect periodic task-header reads.
      sqlite.prepare('UPDATE site_crawl SET result = ?, checkpoint = ? WHERE id = ?').run('{}', '{}', row.id);
    } finally {
      sqlite.close();
    }
    const { result: _result, checkpoint: _checkpoint, ...header } = row;
    expect(await db.siteCrawls.listSummaries({ limit: 20, offset: 0 })).toEqual({
      items: [{ ...header, cancelled: true }],
      total: 1,
    });
  });

  test('retains a successful discovery completion marker after reopening and job cleanup', async () => {
    const row = record(10);
    await db.siteCrawls.insert(row, {
      id: row.id,
      type: 'site.crawl',
      resourceClass: 'cpu',
      fileId: null,
      lane: 'example.com',
      payload: { v: 1 },
      dedupeKey: null,
    });
    await db.jobs.claimNext({ resourceClass: 'cpu', types: ['site.crawl'], now: T0 });
    await db.siteCrawls.update(row.id, { completedAt: T1, result: result(row.id), now: T1 });
    await db.jobs.finish(row.id, { status: 'succeeded', errorCode: null, now: T1 });
    await db.jobs.clearFinished();
    await db.close();
    db = await openWorkspaceDatabase(path, MIGRATIONS_FOLDER);
    expect(await db.jobs.get(row.id)).toBeNull();
    expect((await db.siteCrawls.get(row.id))?.completedAt).toBe(T1);
  });

  test('captures a discovery request and enqueues its job atomically', async () => {
    const row = record(10);
    const queued: NewJob = {
      id: row.id,
      type: 'site.crawl',
      resourceClass: 'cpu',
      fileId: null,
      lane: 'example.com',
      payload: { v: 1 },
      dedupeKey: null,
    };
    await db.siteCrawls.insert(row, queued);
    expect(await db.siteCrawls.get(row.id)).toEqual(row);
    expect(await db.jobs.get(row.id)).toMatchObject({ id: row.id, type: 'site.crawl', status: 'queued' });
    expect(await db.siteCrawls.hasActiveProfile(profile.id)).toBe(true);
  });

  test('rolls the captured request back when the associated job cannot be queued', async () => {
    const queued: NewJob = {
      id: uuid(10),
      type: 'site.crawl',
      resourceClass: 'cpu',
      fileId: null,
      lane: 'example.com',
      payload: { v: 1 },
      dedupeKey: 'existing-discovery',
    };
    await db.jobs.enqueue({ jobs: [queued], now: T0 });
    await expect(db.siteCrawls.insert(record(11), { ...queued, id: uuid(11) })).rejects.toThrow();
    expect(await db.siteCrawls.get(uuid(11))).toBeNull();
    expect((await db.siteCrawls.list({ limit: 20, offset: 0 })).total).toBe(0);
    expect(await db.jobs.get(uuid(11))).toBeNull();
  });

  test('retains five independent snapshots and paginates newest first', async () => {
    for (const n of [10, 11, 12, 13, 14]) await db.siteCrawls.insert(record(n));

    const page = await db.siteCrawls.list({ limit: 2, offset: 1 });
    expect(page.total).toBe(5);
    expect(page.items.map((item) => item.id)).toEqual([uuid(13), uuid(12)]);
    expect(await db.siteCrawls.get(uuid(10))).toEqual(record(10));
    expect(await db.siteCrawls.get(uuid(999))).toBeNull();
  });

  test('keeps progress, checkpoint, result and captured target across reopening', async () => {
    const row = record(10);
    await db.siteCrawls.insert(row);
    const checkpoint = { version: 1, pending: ['https://example.com/detail/2'], found: result(row.id).files };
    const partial = { pages: 3, files: 1, cancelling: false };
    await db.siteCrawls.update(row.id, { progress: partial, checkpoint, now: T1 });
    await db.siteCrawls.update(row.id, { result: result(row.id), importedAt: T1, now: T1 });
    await db.close();
    db = await openWorkspaceDatabase(path, MIGRATIONS_FOLDER);

    expect(await db.siteCrawls.get(row.id)).toEqual({
      ...row,
      progress: partial,
      checkpoint,
      result: result(row.id),
      importedAt: T1,
      updatedAt: T1,
    });
  });

  test('updates only one crawl, preserves other snapshots and permits clearing checkpoints', async () => {
    await db.siteCrawls.insert({ ...record(10), checkpoint: { version: 1 } });
    await db.siteCrawls.insert(record(11));
    expect(await db.siteCrawls.update(uuid(10), { checkpoint: null, now: T1 })).toBe(true);
    expect(await db.siteCrawls.update(uuid(999), { checkpoint: null, now: T1 })).toBe(false);
    expect((await db.siteCrawls.get(uuid(10)))?.checkpoint).toBeNull();
    expect(await db.siteCrawls.get(uuid(11))).toEqual(record(11));
  });

  test('preserves review results when finished job history is cleared', async () => {
    const row = { ...record(10), result: result(uuid(10)) };
    await db.jobs.enqueue({
      jobs: [
        {
          id: row.id,
          type: 'site.crawl',
          resourceClass: 'cpu',
          fileId: null,
          lane: 'site.crawl',
          payload: {},
          dedupeKey: null,
        },
      ],
      now: T0,
    });
    await db.siteCrawls.insert(row);
    const claimed = await db.jobs.claimNext({ resourceClass: 'cpu', types: ['site.crawl'], now: T0 });
    expect(claimed?.id).toBe(row.id);
    await db.jobs.finish(row.id, { status: 'succeeded', errorCode: null, now: T1 });
    await db.jobs.clearFinished();

    expect(await db.siteCrawls.get(row.id)).toEqual(row);
  });

  test('blocks deleting profiles with active discovery jobs, not finished results', async () => {
    const row = record(10);
    await db.siteCrawls.insert(row);
    expect(await db.siteCrawls.hasActiveProfile(profile.id)).toBe(false);
    await db.jobs.enqueue({
      jobs: [
        {
          id: row.id,
          type: 'site.crawl',
          resourceClass: 'cpu',
          fileId: null,
          lane: 'site.crawl',
          payload: {},
          dedupeKey: null,
        },
      ],
      now: T0,
    });
    expect(await db.siteCrawls.hasActiveProfile(profile.id)).toBe(true);
    expect(await db.siteCrawls.hasActiveProfile(uuid(999))).toBe(false);
    await db.jobs.claimNext({ resourceClass: 'cpu', types: ['site.crawl'], now: T0 });
    expect(await db.siteCrawls.hasActiveProfile(profile.id)).toBe(true);
    await db.jobs.finish(row.id, { status: 'succeeded', errorCode: null, now: T1 });
    expect(await db.siteCrawls.hasActiveProfile(profile.id)).toBe(false);
  });

  test('supports inbox targets and rejects storing profile fields outside the contract', async () => {
    const row = { ...record(10), target: null, targetAssetName: null };
    await db.siteCrawls.insert({ ...row, profile: { ...profile, cookie: 'must-not-persist' } } as typeof row);
    const saved = await db.siteCrawls.get(row.id);
    expect(saved).toEqual(row);
    expect(JSON.stringify(saved)).not.toContain('must-not-persist');
  });

  test('rejects invalid or excessive results without changing the saved review snapshot', async () => {
    const row = record(10);
    await db.siteCrawls.insert(row);
    await expect(
      db.siteCrawls.update(row.id, { progress: { pages: -1, files: 0, cancelling: false }, now: T1 }),
    ).rejects.toThrow();
    await expect(
      db.siteCrawls.update(row.id, {
        result: { ...result(row.id), files: Array(5001).fill('https://example.com/image.jpg') },
        now: T1,
      }),
    ).rejects.toThrow();
    expect(await db.siteCrawls.get(row.id)).toEqual(row);
  });
});
