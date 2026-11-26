import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { JOB_ERROR_MESSAGES, type ResourceClass } from '@assetforge/contracts';
import type { NewJob, WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';
const T2 = '2026-01-01T00:00:02.000Z';
const T3 = '2026-01-01T00:00:03.000Z';
const T9 = '2026-01-01T00:00:09.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STORAGE_ID = uuid(1);
const FILE_ID = uuid(2);
const TYPE = 'vision.analyze_file';

let dir: string;
let db: WorkspaceDatabase;
let handle: Database.Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-jobs-'));
  const pragma = vi.spyOn(Database.prototype, 'pragma');
  try {
    db = await openWorkspaceDatabase(join(dir, 'ws.db'), MIGRATIONS_FOLDER);
    handle = pragma.mock.contexts[0] as Database.Database;
  } finally {
    pragma.mockRestore();
  }
  await db.storages.ensurePrimary({ id: STORAGE_ID, createdAt: T0 });
  await db.files.insertPending({
    id: FILE_ID,
    storageId: STORAGE_ID,
    originalName: 'Pump.png',
    relativePath: `inbox/${FILE_ID}/Pump.png`,
    mimeType: 'image/png',
    importedAt: T0,
    kind: 'image',
  });
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

const newJob = (n: number, o: Partial<NewJob> = {}): NewJob => ({
  id: uuid(n),
  type: TYPE,
  resourceClass: 'local_gpu',
  fileId: null,
  payload: { version: 1 },
  dedupeKey: null,
  ...o,
});

const enqueue = (now: string, ...jobs: NewJob[]) => db.jobs.enqueue({ jobs, now });
const claim = (now: string, resourceClass: ResourceClass = 'local_gpu', types: string[] = [TYPE]) =>
  db.jobs.claimNext({ resourceClass, types, now });

/** Enqueues a `remote_api` job at `now`, claims it and finishes it; other classes are not touched. */
async function finishedJob(
  n: number,
  now: string,
  dedupeKey: string | null = null,
  status: 'failed' | 'succeeded' = 'failed',
): Promise<void> {
  await enqueue(now, newJob(n, { dedupeKey, resourceClass: 'remote_api' }));
  expect((await claim(now, 'remote_api'))?.id).toBe(uuid(n));
  await db.jobs.finish(uuid(n), { status, errorCode: status === 'failed' ? 'provider_rejected' : null, now });
}
const failedJob = (n: number, now: string, dedupeKey: string | null = null) => finishedJob(n, now, dedupeKey);

describe('job repository', () => {
  test('enqueue inserts queued jobs with attempt 0 and keeps the payload', async () => {
    expect(await enqueue(T0, newJob(10, { fileId: FILE_ID, payload: { version: 1, extra: [1, 2] } }))).toEqual([uuid(10)]);
    expect(await db.jobs.get(uuid(10))).toEqual({
      id: uuid(10),
      type: TYPE,
      resourceClass: 'local_gpu',
      status: 'queued',
      fileId: FILE_ID,
      payload: { version: 1, extra: [1, 2] },
      dedupeKey: null,
      attempt: 0,
      runAfter: null,
      errorCode: null,
      errorMessage: null,
      createdAt: T0,
      startedAt: null,
      finishedAt: null,
      updatedAt: T0,
    });
    expect(await db.jobs.get(uuid(99))).toBeNull();
  });

  test('enqueue skips a job whose dedupe key is held, within one call and across calls', async () => {
    expect(await enqueue(T0, newJob(10, { dedupeKey: 'k' }), newJob(11, { dedupeKey: 'k' }), newJob(12, { dedupeKey: 'other' }))).toEqual([
      uuid(10),
      uuid(12),
    ]);
    expect(await enqueue(T1, newJob(13, { dedupeKey: 'k' }), newJob(14))).toEqual([uuid(14)]);
    expect(await db.jobs.get(uuid(11))).toBeNull();
    expect(await db.jobs.get(uuid(13))).toBeNull();
  });

  test('a job with the dedupe key of a finished job is accepted', async () => {
    await enqueue(T0, newJob(10, { dedupeKey: 'k' }));
    await claim(T0);
    expect(await db.jobs.finish(uuid(10), { status: 'succeeded', errorCode: null, now: T1 })).toBe(true);
    expect(await enqueue(T2, newJob(11, { dedupeKey: 'k' }))).toEqual([uuid(11)]);
  });

  test('the database refuses a second active job for one dedupe key', async () => {
    await enqueue(T0, newJob(10, { dedupeKey: 'k' }));
    expect(() =>
      handle
        .prepare(
          `insert into job (id, type, resource_class, status, payload, dedupe_key, attempt, created_at, updated_at)
           values (?, ?, 'local_gpu', 'retry_wait', '{}', 'k', 0, ?, ?)`,
        )
        .run(uuid(11), TYPE, T0, T0),
    ).toThrow(/UNIQUE/);
  });

  test('claimNext takes the oldest job by created_at, then id', async () => {
    await enqueue(T1, newJob(12));
    await enqueue(T0, newJob(11), newJob(10));
    const first = await claim(T2);
    expect(first).toMatchObject({ id: uuid(10), status: 'running', attempt: 1, startedAt: T2, updatedAt: T2 });
    expect((await claim(T2))?.id).toBe(uuid(11));
    expect((await claim(T2))?.id).toBe(uuid(12));
    expect(await claim(T2)).toBeNull();
  });

  test('claimNext ignores other resource classes and types not listed', async () => {
    await enqueue(T0, newJob(10, { resourceClass: 'cpu' }), newJob(11, { type: 'other.type' }));
    expect(await claim(T1)).toBeNull();
    expect(await claim(T1, 'local_gpu', [])).toBeNull();
    expect((await claim(T1, 'local_gpu', ['other.type', 'x']))?.id).toBe(uuid(11));
    expect((await claim(T1, 'cpu'))?.id).toBe(uuid(10));
  });

  test('claimNext takes a retry_wait job only once run_after is reached, and clears run_after and the error', async () => {
    await enqueue(T0, newJob(10));
    await claim(T0);
    expect(await db.jobs.scheduleRetry(uuid(10), { errorCode: 'provider_timeout', runAfter: T3, now: T1 })).toBe(true);
    expect(await db.jobs.get(uuid(10))).toMatchObject({
      status: 'retry_wait',
      runAfter: T3,
      errorCode: 'provider_timeout',
      errorMessage: JOB_ERROR_MESSAGES.provider_timeout,
      updatedAt: T1,
    });
    expect(await claim(T2)).toBeNull();
    expect(await claim(T3)).toMatchObject({
      id: uuid(10),
      status: 'running',
      attempt: 2,
      startedAt: T3,
      runAfter: null,
      errorCode: null,
      errorMessage: null,
    });
  });

  test('nextRunAfter is the earliest run_after of retry_wait jobs of the types', async () => {
    expect(await db.jobs.nextRunAfter([TYPE])).toBeNull();
    await enqueue(T0, newJob(10), newJob(11), newJob(12, { type: 'other.type' }));
    for (let i = 0; i < 3; i++) await claim(T0, 'local_gpu', [TYPE, 'other.type']);
    await db.jobs.scheduleRetry(uuid(10), { errorCode: 'provider_timeout', runAfter: T9, now: T0 });
    await db.jobs.scheduleRetry(uuid(11), { errorCode: 'provider_timeout', runAfter: T3, now: T0 });
    await db.jobs.scheduleRetry(uuid(12), { errorCode: 'provider_timeout', runAfter: T1, now: T0 });
    expect(await db.jobs.nextRunAfter([TYPE])).toBe(T3);
    expect(await db.jobs.nextRunAfter([TYPE, 'other.type'])).toBe(T1);
    expect(await db.jobs.nextRunAfter([])).toBeNull();
  });

  test('finish, scheduleRetry and release return false for a job that is not running', async () => {
    await enqueue(T0, newJob(10));
    expect(await db.jobs.finish(uuid(10), { status: 'succeeded', errorCode: null, now: T1 })).toBe(false);
    expect(await db.jobs.scheduleRetry(uuid(10), { errorCode: 'provider_timeout', runAfter: T2, now: T1 })).toBe(false);
    expect(await db.jobs.release(uuid(10), T1)).toBe(false);
    expect(await db.jobs.finish(uuid(99), { status: 'succeeded', errorCode: null, now: T1 })).toBe(false);
    expect(await db.jobs.get(uuid(10))).toMatchObject({ status: 'queued', updatedAt: T0 });
  });

  test('release after a claim puts the job back with attempt 0', async () => {
    await enqueue(T0, newJob(10));
    await claim(T1);
    expect(await db.jobs.release(uuid(10), T2)).toBe(true);
    expect(await db.jobs.get(uuid(10))).toMatchObject({ status: 'queued', attempt: 0, startedAt: null, updatedAt: T2 });
  });

  test('finish stores the fixed message of the error code', async () => {
    await enqueue(T0, newJob(10), newJob(11));
    await claim(T0);
    await claim(T0);
    expect(await db.jobs.finish(uuid(10), { status: 'failed', errorCode: 'provider_timeout', now: T1 })).toBe(true);
    expect(await db.jobs.get(uuid(10))).toMatchObject({
      status: 'failed',
      errorCode: 'provider_timeout',
      errorMessage: JOB_ERROR_MESSAGES.provider_timeout,
      finishedAt: T1,
      updatedAt: T1,
    });
    expect(await db.jobs.finish(uuid(11), { status: 'succeeded', errorCode: null, now: T2 })).toBe(true);
    expect(await db.jobs.get(uuid(11))).toMatchObject({ status: 'succeeded', errorCode: null, errorMessage: null, finishedAt: T2 });
  });

  test('cancelPending cancels one or all pending jobs and leaves running and finished ones alone', async () => {
    await enqueue(T0, newJob(10), newJob(11), newJob(12), newJob(13), newJob(14));
    await claim(T0); // 10 running
    await claim(T0); // 11 → retry_wait
    await db.jobs.scheduleRetry(uuid(11), { errorCode: 'provider_timeout', runAfter: T9, now: T0 });
    await claim(T0); // 12 → succeeded
    await db.jobs.finish(uuid(12), { status: 'succeeded', errorCode: null, now: T0 });

    expect(await db.jobs.cancelPending({ id: uuid(13), now: T1 })).toBe(1);
    expect(await db.jobs.get(uuid(13))).toMatchObject({ status: 'cancelled', finishedAt: T1, updatedAt: T1 });
    expect(await db.jobs.cancelPending({ id: uuid(10), now: T1 })).toBe(0);

    expect(await db.jobs.cancelPending({ now: T2 })).toBe(2); // 11 and 14
    expect((await db.jobs.get(uuid(11)))?.status).toBe('cancelled');
    expect((await db.jobs.get(uuid(14)))?.status).toBe('cancelled');
    expect((await db.jobs.get(uuid(10)))?.status).toBe('running');
    expect(await db.jobs.get(uuid(12))).toMatchObject({ status: 'succeeded', finishedAt: T0 });
  });

  test('retry requeues a failed or cancelled job with attempt and error reset', async () => {
    await failedJob(10, T0);
    await enqueue(T1, newJob(11));
    await db.jobs.cancelPending({ id: uuid(11), now: T1 });

    expect(await db.jobs.retry({ id: uuid(10), now: T2 })).toBe(1);
    expect(await db.jobs.get(uuid(10))).toMatchObject({
      status: 'queued',
      attempt: 0,
      errorCode: null,
      errorMessage: null,
      runAfter: null,
      startedAt: null,
      finishedAt: null,
      updatedAt: T2,
    });
    expect(await db.jobs.retry({ id: uuid(10), now: T2 })).toBe(0); // no longer failed
    expect(await db.jobs.retry({ now: T3 })).toBe(1);
    expect((await db.jobs.get(uuid(11)))?.status).toBe('queued');
  });

  test('retry for all requeues only the newest of two failed jobs of one dedupe key', async () => {
    await failedJob(10, T0, 'k');
    await failedJob(11, T1, 'k');
    expect(await db.jobs.retry({ now: T2 })).toBe(1);
    expect((await db.jobs.get(uuid(11)))?.status).toBe('queued');
    expect((await db.jobs.get(uuid(10)))?.status).toBe('failed');
  });

  test('retry of one job whose dedupe key is held by an active job returns 0', async () => {
    await failedJob(10, T0, 'k');
    await enqueue(T1, newJob(11, { dedupeKey: 'k' }));
    expect(await db.jobs.retry({ id: uuid(10), now: T2 })).toBe(0);
    expect((await db.jobs.get(uuid(10)))?.status).toBe('failed');
  });

  test('counts has every status', async () => {
    await enqueue(T0, newJob(10), newJob(11), newJob(12));
    await claim(T0);
    await failedJob(13, T0);
    expect(await db.jobs.counts()).toEqual({
      queued: 2,
      running: 1,
      waiting_remote: 0,
      succeeded: 0,
      failed: 1,
      cancelled: 0,
      retry_wait: 0,
    });
  });

  test('listByStatus is oldest first, then id', async () => {
    await enqueue(T1, newJob(10));
    await enqueue(T0, newJob(12), newJob(11));
    expect((await db.jobs.listByStatus('queued')).map((j) => j.id)).toEqual([uuid(11), uuid(12), uuid(10)]);
    expect(await db.jobs.listByStatus('running')).toEqual([]);
  });

  test('clearFinished removes only finished jobs and returns their number', async () => {
    await enqueue(T0, newJob(10), newJob(11));
    await claim(T0); // 10 running
    await failedJob(12, T0);
    await enqueue(T0, newJob(13));
    await db.jobs.cancelPending({ id: uuid(13), now: T0 });
    await finishedJob(14, T0, null, 'succeeded');

    expect(await db.jobs.clearFinished()).toBe(3);
    expect((await db.jobs.list({ limit: 10, offset: 0 })).items.map((j) => j.id).sort()).toEqual([uuid(10), uuid(11)]);
    expect(await db.jobs.clearFinished()).toBe(0);
  });

  test('list is newest first with a status filter, a total and the file name', async () => {
    await enqueue(T0, newJob(10, { fileId: FILE_ID }), newJob(11));
    await enqueue(T1, newJob(12));
    await failedJob(13, T2);

    const all = await db.jobs.list({ limit: 2, offset: 0 });
    expect(all.total).toBe(4);
    expect(all.items.map((j) => j.id)).toEqual([uuid(13), uuid(12)]);
    const rest = await db.jobs.list({ limit: 2, offset: 2 });
    expect(rest.items.map((j) => j.id)).toEqual([uuid(11), uuid(10)]);
    expect(rest.items[1]).toEqual({
      id: uuid(10),
      type: TYPE,
      status: 'queued',
      attempt: 0,
      fileId: FILE_ID,
      fileName: 'Pump.png',
      errorCode: null,
      errorMessage: null,
      createdAt: T0,
      startedAt: null,
      finishedAt: null,
      runAfter: null,
    });
    expect(rest.items[0]).toMatchObject({ fileId: null, fileName: null });

    const failed = await db.jobs.list({ limit: 10, offset: 0, status: 'failed' });
    expect(failed).toMatchObject({ total: 1, items: [{ id: uuid(13), errorCode: 'provider_rejected', errorMessage: JOB_ERROR_MESSAGES.provider_rejected }] });
  });

  test('latestForFile returns the newest job of the type for the file, whatever its status', async () => {
    expect(await db.jobs.latestForFile(FILE_ID, TYPE)).toBeNull();
    await enqueue(T0, newJob(10, { fileId: FILE_ID }));
    expect((await claim(T1))?.id).toBe(uuid(10));
    await db.jobs.finish(uuid(10), { status: 'failed', errorCode: 'provider_rejected', now: T1 });
    expect(await db.jobs.latestForFile(FILE_ID, TYPE)).toMatchObject({ id: uuid(10), status: 'failed' });

    await enqueue(T2, newJob(12, { fileId: FILE_ID }), newJob(11, { fileId: FILE_ID }), newJob(13, { fileId: FILE_ID, type: 'other.type' }));
    await enqueue(T3, newJob(14));
    // Same created_at: the higher id wins.
    expect(await db.jobs.latestForFile(FILE_ID, TYPE)).toMatchObject({ id: uuid(12), status: 'queued' });
    expect(await db.jobs.latestForFile(FILE_ID, 'other.type')).toMatchObject({ id: uuid(13) });
    expect(await db.jobs.latestForFile(uuid(99), TYPE)).toBeNull();
  });
});
