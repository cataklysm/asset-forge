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
  lane: null,
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
    expect(await enqueue(T0, newJob(10, { fileId: FILE_ID, payload: { version: 1, extra: [1, 2] } }))).toEqual([
      uuid(10),
    ]);
    expect(await db.jobs.get(uuid(10))).toEqual({
      id: uuid(10),
      type: TYPE,
      resourceClass: 'local_gpu',
      status: 'queued',
      fileId: FILE_ID,
      lane: null,
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
    expect(
      await enqueue(
        T0,
        newJob(10, { dedupeKey: 'k' }),
        newJob(11, { dedupeKey: 'k' }),
        newJob(12, { dedupeKey: 'other' }),
      ),
    ).toEqual([uuid(10), uuid(12)]);
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
    expect(await db.jobs.get(uuid(11))).toMatchObject({
      status: 'succeeded',
      errorCode: null,
      errorMessage: null,
      finishedAt: T2,
    });
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

  test('finish runs settled once when the row changed and not for a job that is not running', async () => {
    await enqueue(T0, newJob(10));
    await claim(T0);
    const settled = vi.fn();
    expect(await db.jobs.finish(uuid(10), { status: 'succeeded', errorCode: null, now: T1, settled })).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(await db.jobs.finish(uuid(10), { status: 'failed', errorCode: 'provider_rejected', now: T2, settled })).toBe(
      false,
    );
    expect(settled).toHaveBeenCalledTimes(1);
  });

  test('a settled callback that throws rolls finish back', async () => {
    await enqueue(T0, newJob(10));
    await claim(T0);
    const settled = () => {
      throw new Error('boom');
    };
    await expect(
      db.jobs.finish(uuid(10), { status: 'failed', errorCode: 'provider_rejected', now: T1, settled }),
    ).rejects.toThrow('boom');
    expect(await db.jobs.get(uuid(10))).toMatchObject({ status: 'running', errorCode: null, finishedAt: null });
  });

  test('cancelPending runs settled with each cancelled job, and a throw rolls every cancel back', async () => {
    await enqueue(T0, newJob(10), newJob(11), newJob(12));
    await claim(T0); // 10 running
    const seen: [string, string][] = [];
    expect(await db.jobs.cancelPending({ now: T1, settled: (j) => seen.push([j.id, j.status]) })).toBe(2);
    expect(seen.sort()).toEqual([
      [uuid(11), 'cancelled'],
      [uuid(12), 'cancelled'],
    ]);

    await enqueue(T2, newJob(13), newJob(14));
    let calls = 0;
    const throwing = () => {
      if (++calls === 2) throw new Error('boom');
    };
    await expect(db.jobs.cancelPending({ now: T3, settled: throwing })).rejects.toThrow('boom');
    expect((await db.jobs.get(uuid(13)))?.status).toBe('queued');
    expect((await db.jobs.get(uuid(14)))?.status).toBe('queued');
  });

  test('cancelPendingOfFile refuses while a job of a listed type of the file runs and changes nothing', async () => {
    const gen = { type: 'image.generate', resourceClass: 'remote_api' as const, fileId: FILE_ID };
    await enqueue(T0, newJob(10, gen), newJob(11, { fileId: FILE_ID }), newJob(12, gen));
    await claim(T0, 'remote_api', ['image.generate']); // 10 running
    const settled = vi.fn();
    expect(
      await db.jobs.cancelPendingOfFile({ fileId: FILE_ID, refuseRunning: ['image.generate'], now: T1, settled }),
    ).toEqual({ refused: true, cancelled: 0 });
    expect(settled).not.toHaveBeenCalled();
    expect((await db.jobs.get(uuid(11)))?.status).toBe('queued');
    expect((await db.jobs.get(uuid(12)))?.status).toBe('queued');
    expect((await db.jobs.get(uuid(10)))?.status).toBe('running');
  });

  test('cancelPendingOfFile cancels only the pending jobs of the file, running settled per job', async () => {
    await enqueue(
      T0,
      newJob(10, { fileId: FILE_ID }),
      newJob(11, { fileId: FILE_ID }),
      newJob(12),
      newJob(13, { fileId: FILE_ID }),
    );
    await claim(T0); // 10 running: not of a refused type, so it stays and is not counted
    const seen: string[] = [];
    expect(
      await db.jobs.cancelPendingOfFile({
        fileId: FILE_ID,
        refuseRunning: ['image.generate'],
        now: T1,
        settled: (j) => seen.push(j.id),
      }),
    ).toEqual({ refused: false, cancelled: 2 });
    expect(seen.sort()).toEqual([uuid(11), uuid(13)]);
    expect(await db.jobs.get(uuid(11))).toMatchObject({ status: 'cancelled', finishedAt: T1 });
    expect((await db.jobs.get(uuid(10)))?.status).toBe('running');
    expect((await db.jobs.get(uuid(12)))?.status).toBe('queued');

    await enqueue(T2, newJob(14, { fileId: FILE_ID }), newJob(15, { fileId: FILE_ID }));
    let calls = 0;
    const throwing = () => {
      if (++calls === 2) throw new Error('boom');
    };
    await expect(
      db.jobs.cancelPendingOfFile({ fileId: FILE_ID, refuseRunning: [], now: T3, settled: throwing }),
    ).rejects.toThrow('boom');
    expect((await db.jobs.get(uuid(14)))?.status).toBe('queued');
    expect((await db.jobs.get(uuid(15)))?.status).toBe('queued');
  });

  test('retry with excludeTypes skips jobs of those types, for all and by id', async () => {
    await failedJob(10, T0);
    await enqueue(T0, newJob(11, { type: 'image.generate', resourceClass: 'remote_api' }));
    await db.jobs.cancelPending({ id: uuid(11), now: T1 });
    expect(await db.jobs.retry({ id: uuid(11), now: T2, excludeTypes: ['image.generate'] })).toBe(0);
    expect(await db.jobs.retry({ now: T2, excludeTypes: ['image.generate'] })).toBe(1);
    expect((await db.jobs.get(uuid(10)))?.status).toBe('queued');
    expect((await db.jobs.get(uuid(11)))?.status).toBe('cancelled');
    expect(await db.jobs.retry({ now: T3, excludeTypes: [] })).toBe(1);
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
      providerId: null,
      providerName: null,
      model: null,
      url: null,
      host: null,
      result: null,
    });
    expect(rest.items[0]).toMatchObject({ fileId: null, fileName: null });

    const failed = await db.jobs.list({ limit: 10, offset: 0, status: 'failed' });
    expect(failed).toMatchObject({
      total: 1,
      items: [{ id: uuid(13), errorCode: 'provider_rejected', errorMessage: JOB_ERROR_MESSAGES.provider_rejected }],
    });
  });

  test('latestForFile returns the newest job of the type for the file, whatever its status', async () => {
    expect(await db.jobs.latestForFile(FILE_ID, TYPE)).toBeNull();
    await enqueue(T0, newJob(10, { fileId: FILE_ID }));
    expect((await claim(T1))?.id).toBe(uuid(10));
    await db.jobs.finish(uuid(10), { status: 'failed', errorCode: 'provider_rejected', now: T1 });
    expect(await db.jobs.latestForFile(FILE_ID, TYPE)).toMatchObject({ id: uuid(10), status: 'failed' });

    await enqueue(
      T2,
      newJob(12, { fileId: FILE_ID }),
      newJob(11, { fileId: FILE_ID }),
      newJob(13, { fileId: FILE_ID, type: 'other.type' }),
    );
    await enqueue(T3, newJob(14));
    // Same created_at: the higher id wins.
    expect(await db.jobs.latestForFile(FILE_ID, TYPE)).toMatchObject({ id: uuid(12), status: 'queued' });
    expect(await db.jobs.latestForFile(FILE_ID, 'other.type')).toMatchObject({ id: uuid(13) });
    expect(await db.jobs.latestForFile(uuid(99), TYPE)).toBeNull();
  });

  test('latestForFile prefers a retried older job over a newer finished one', async () => {
    const forFile = (n: number) => newJob(n, { fileId: FILE_ID, resourceClass: 'remote_api' });
    await enqueue(T0, forFile(20));
    expect((await claim(T0, 'remote_api'))?.id).toBe(uuid(20));
    await db.jobs.finish(uuid(20), { status: 'failed', errorCode: 'provider_rejected', now: T0 });
    await enqueue(T2, forFile(21));
    expect((await claim(T2, 'remote_api'))?.id).toBe(uuid(21));
    await db.jobs.finish(uuid(21), { status: 'succeeded', errorCode: null, now: T2 });
    expect(await db.jobs.latestForFile(FILE_ID, TYPE)).toMatchObject({ id: uuid(21), status: 'succeeded' });

    expect(await db.jobs.retry({ id: uuid(20), now: T3 })).toBe(1);
    expect(await db.jobs.latestForFile(FILE_ID, TYPE)).toMatchObject({ id: uuid(20), status: 'queued' });

    // Among several active jobs the newest wins.
    await enqueue(T1, forFile(22));
    expect(await db.jobs.latestForFile(FILE_ID, TYPE)).toMatchObject({ id: uuid(22), status: 'queued' });
    await enqueue(T9, newJob(23, { fileId: FILE_ID, type: 'other.type' }));
    expect(await db.jobs.latestForFile(FILE_ID, TYPE)).toMatchObject({ id: uuid(22) });
  });
});

describe('jobs of trashed files', () => {
  const TRASHED_ID = uuid(3);

  /** A second, complete file of the workspace. */
  async function addOtherFile(): Promise<void> {
    await db.files.insertPending({
      id: TRASHED_ID,
      storageId: STORAGE_ID,
      originalName: 'Gone.png',
      relativePath: `inbox/${TRASHED_ID}/Gone.png`,
      mimeType: 'image/png',
      importedAt: T0,
      kind: 'image',
    });
    await db.files.markComplete(TRASHED_ID, { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
  }
  /** Moves that file to the trash through a committed `trash` move. */
  async function trash(): Promise<void> {
    await db.fileMoves.begin({
      fileId: TRASHED_ID,
      kind: 'trash',
      targetRelativePath: `.assetforge/trash/${TRASHED_ID}_Gone.png`,
      targetAssetId: null,
      targetRole: null,
      createdAt: T1,
    });
    await db.fileMoves.commit(TRASHED_ID);
  }
  /** Enqueues a `remote_api` job for the file and fails it. */
  async function failedFor(n: number, fileId: string | null, now: string): Promise<void> {
    await enqueue(now, newJob(n, { fileId, resourceClass: 'remote_api' }));
    expect((await claim(now, 'remote_api'))?.id).toBe(uuid(n));
    await db.jobs.finish(uuid(n), { status: 'failed', errorCode: 'provider_rejected', now });
  }

  test('activeForFile returns queued, retry_wait, running and waiting_remote jobs of the file only', async () => {
    await addOtherFile();
    await enqueue(
      T0,
      newJob(10, { fileId: FILE_ID }),
      newJob(11, { fileId: FILE_ID }),
      newJob(12, { fileId: FILE_ID }),
    );
    await enqueue(
      T0,
      newJob(13, { fileId: FILE_ID }),
      newJob(14, { fileId: FILE_ID }),
      newJob(15, { fileId: FILE_ID }),
    );
    await enqueue(T0, newJob(16, { fileId: TRASHED_ID }), newJob(17));
    const set = (n: number, status: string) =>
      handle.prepare('update job set status = ? where id = ?').run(status, uuid(n));
    set(10, 'running');
    set(11, 'retry_wait');
    set(12, 'waiting_remote');
    set(14, 'failed');
    set(15, 'cancelled');
    const active = await db.jobs.activeForFile(FILE_ID);
    expect(active.map((j) => [j.id, j.status])).toEqual([
      [uuid(10), 'running'],
      [uuid(11), 'retry_wait'],
      [uuid(12), 'waiting_remote'],
      [uuid(13), 'queued'],
    ]);
    await expect(db.jobs.activeForFile(uuid(99))).resolves.toEqual([]);
  });

  test('enqueue skips a trashed file', async () => {
    await addOtherFile();
    await trash();
    expect(await enqueue(T2, newJob(10, { fileId: FILE_ID }), newJob(11, { fileId: TRASHED_ID }))).toEqual([uuid(10)]);
    expect(handle.prepare('select id from job').all()).toEqual([{ id: uuid(10) }]);
  });

  test('enqueue skips an unknown file', async () => {
    expect(await enqueue(T2, newJob(10, { fileId: uuid(99) }), newJob(11))).toEqual([uuid(11)]);
    expect(handle.prepare('select id from job').all()).toEqual([{ id: uuid(11) }]);
  });

  test('retry by id returns 0 for a job of a trashed file', async () => {
    await addOtherFile();
    await failedFor(10, TRASHED_ID, T0);
    await trash();
    expect(await db.jobs.retry({ id: uuid(10), now: T2 })).toBe(0);
    expect(await db.jobs.get(uuid(10))).toMatchObject({ status: 'failed' });
  });

  test('retry of all failed skips jobs of trashed files', async () => {
    await addOtherFile();
    await failedFor(10, TRASHED_ID, T0);
    await failedFor(11, FILE_ID, T0);
    await failedFor(12, null, T0);
    await trash();
    expect(await db.jobs.retry({ now: T2 })).toBe(2);
    expect(await db.jobs.get(uuid(10))).toMatchObject({ status: 'failed' });
    expect(await db.jobs.get(uuid(11))).toMatchObject({ status: 'queued' });
    expect(await db.jobs.get(uuid(12))).toMatchObject({ status: 'queued' });
  });
});

describe('job lanes', () => {
  const LATER = '2026-01-01T01:00:00.000Z';
  const RA = '2026-01-01T00:05:00.000Z';
  const RB = '2026-01-01T00:10:00.000Z';

  /** A job of lane `lane` with id uuid(n). */
  const laned = (n: number, lane: string | null, payload: unknown = { version: 1 }, type = TYPE): NewJob =>
    newJob(n, { lane, payload, type });

  /** Enqueues the jobs one at a time, one second apart, so their order is the order given. */
  async function enqueueInOrder(...jobs: NewJob[]): Promise<void> {
    for (const [i, j] of jobs.entries()) {
      expect(await enqueue(new Date(Date.parse(T0) + i * 1000).toISOString(), j)).toEqual([j.id]);
    }
  }

  /** Puts a job into `status` directly, as a test fixture. */
  function setStatus(n: number, status: string, runAfter: string | null = null): void {
    const retrying = status === 'retry_wait';
    handle
      .prepare('update job set status = ?, run_after = ?, attempt = 2, error_code = ?, error_message = ? where id = ?')
      .run(
        status,
        runAfter,
        retrying ? 'provider_timeout' : null,
        retrying ? JOB_ERROR_MESSAGES.provider_timeout : null,
        uuid(n),
      );
  }

  const claimLanes = (excludeLanes?: (string | null)[]) =>
    db.jobs.claimNext({ resourceClass: 'local_gpu', types: [TYPE], now: LATER, excludeLanes });

  test('enqueue stores the lane in provider_id', async () => {
    await enqueueInOrder(laned(10, 'a'), laned(11, null));
    expect((await db.jobs.get(uuid(10)))?.lane).toBe('a');
    expect((await db.jobs.get(uuid(11)))?.lane).toBeNull();
    expect(handle.prepare('select id, provider_id from job order by id').all()).toEqual([
      { id: uuid(10), provider_id: 'a' },
      { id: uuid(11), provider_id: null },
    ]);
  });

  test('a job enqueued without a lane field stores null', async () => {
    const { lane: _lane, ...withoutLane } = newJob(10);
    await enqueue(T0, withoutLane as NewJob);
    expect((await db.jobs.get(uuid(10)))?.lane).toBeNull();
  });

  test('claimNext skips jobs of an excluded lane', async () => {
    await enqueueInOrder(laned(10, 'a'), laned(11, 'b'), laned(12, 'a'));
    expect((await claimLanes(['a']))?.id).toBe(uuid(11));
    expect(await claimLanes(['a', 'b'])).toBeNull();
    expect((await claimLanes())?.id).toBe(uuid(10));
  });

  test('claimNext with null excluded skips a job without lane', async () => {
    await enqueueInOrder(laned(10, null), laned(11, 'a'));
    expect((await claimLanes([null]))?.id).toBe(uuid(11));
    expect(await claimLanes([null])).toBeNull();
    expect((await claimLanes([]))?.id).toBe(uuid(10));
  });

  test('claimNext with only strings excluded still takes a job without lane', async () => {
    await enqueueInOrder(laned(10, null), laned(11, 'a'));
    expect((await claimLanes(['a']))?.id).toBe(uuid(10));
    expect(await claimLanes(['a'])).toBeNull();
    expect((await claimLanes(['b', null]))?.id).toBe(uuid(11));
  });

  test('nextRunAfter ignores a retry_wait job of an excluded lane', async () => {
    await enqueueInOrder(laned(10, 'a'), laned(11, 'b'), laned(12, null));
    setStatus(10, 'retry_wait', RA);
    setStatus(11, 'retry_wait', RB);
    setStatus(12, 'retry_wait', T9);
    expect(await db.jobs.nextRunAfter([TYPE])).toBe(T9);
    expect(await db.jobs.nextRunAfter([TYPE], [null])).toBe(RA);
    expect(await db.jobs.nextRunAfter([TYPE], [null, 'a'])).toBe(RB);
    expect(await db.jobs.nextRunAfter([TYPE], [null, 'a', 'b'])).toBeNull();
    expect(await db.jobs.nextRunAfter([TYPE], ['a', 'b'])).toBe(T9);
  });

  test('rerouteWaiting moves the queued and retry_wait jobs of a lane and leaves the others', async () => {
    await enqueueInOrder(
      laned(10, 'a', { n: 'q' }),
      laned(11, 'a', { n: 'w' }),
      laned(12, 'a'),
      laned(13, 'a'),
      laned(14, 'a'),
      laned(15, 'c'),
      laned(16, 'a', { version: 1 }, 'other.type'),
    );
    setStatus(11, 'retry_wait', RA);
    setStatus(12, 'running');
    setStatus(13, 'failed');
    setStatus(14, 'cancelled');

    const moved = await db.jobs.rerouteWaiting({
      type: TYPE,
      fromLane: 'a',
      toLane: 'b',
      rewrite: (p) => ({ ...(p as object), moved: true }),
      now: LATER,
    });

    expect(moved).toBe(2);
    for (const [n, name] of [
      [10, 'q'],
      [11, 'w'],
    ] as const) {
      expect(await db.jobs.get(uuid(n))).toMatchObject({
        lane: 'b',
        status: 'queued',
        attempt: 0,
        runAfter: null,
        errorCode: null,
        errorMessage: null,
        payload: { n: name, moved: true },
        updatedAt: LATER,
      });
    }
    expect(await db.jobs.get(uuid(12))).toMatchObject({ lane: 'a', status: 'running', attempt: 2 });
    expect(await db.jobs.get(uuid(13))).toMatchObject({ lane: 'a', status: 'failed' });
    expect(await db.jobs.get(uuid(14))).toMatchObject({ lane: 'a', status: 'cancelled' });
    expect((await db.jobs.get(uuid(15)))?.lane).toBe('c');
    expect((await db.jobs.get(uuid(16)))?.lane).toBe('a');
    expect(
      await db.jobs.rerouteWaiting({ type: TYPE, fromLane: 'a', toLane: 'b', rewrite: (p) => p, now: LATER }),
    ).toBe(0);
  });

  test('rerouteWaiting leaves a running job of the source lane uncounted and a second call moves 0', async () => {
    await enqueueInOrder(laned(10, 'a', { n: 1 }), laned(11, 'a', { n: 2 }));
    expect((await claimLanes())?.id).toBe(uuid(10));
    const rewrite = vi.fn((p: unknown) => ({ ...(p as object), moved: true }));

    expect(await db.jobs.rerouteWaiting({ type: TYPE, fromLane: 'a', toLane: 'b', rewrite, now: LATER })).toBe(1);
    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(await db.jobs.get(uuid(10))).toMatchObject({
      lane: 'a',
      status: 'running',
      attempt: 1,
      payload: { n: 1 },
      startedAt: LATER,
    });
    expect(await db.jobs.get(uuid(11))).toMatchObject({ lane: 'b', status: 'queued', payload: { n: 2, moved: true } });

    expect(await db.jobs.rerouteWaiting({ type: TYPE, fromLane: 'a', toLane: 'b', rewrite, now: LATER })).toBe(0);
    expect(await db.jobs.countActiveInLane(TYPE, 'a')).toBe(1);
  });

  test('rerouteWaiting whose rewrite throws on the second row changes no row', async () => {
    await enqueueInOrder(laned(10, 'a', { n: 1 }), laned(11, 'a', { n: 2 }), laned(12, 'a', { n: 3 }));
    setStatus(11, 'retry_wait', RA);
    const before = handle.prepare('select * from job order by id').all();
    let calls = 0;
    const rewrite = (p: unknown) => {
      calls++;
      if (calls === 2) throw new Error('boom');
      return { ...(p as object), moved: true };
    };

    await expect(
      db.jobs.rerouteWaiting({ type: TYPE, fromLane: 'a', toLane: 'b', rewrite, now: LATER }),
    ).rejects.toThrow('boom');
    expect(calls).toBe(2);
    expect(handle.prepare('select * from job order by id').all()).toEqual(before);
  });

  test('rerouteWaiting from null moves the jobs without lane', async () => {
    await enqueueInOrder(laned(10, null), laned(11, 'a'));
    expect(
      await db.jobs.rerouteWaiting({ type: TYPE, fromLane: null, toLane: 'b', rewrite: (p) => p, now: LATER }),
    ).toBe(1);
    expect((await db.jobs.get(uuid(10)))?.lane).toBe('b');
    expect((await db.jobs.get(uuid(11)))?.lane).toBe('a');
  });

  test('assignLane gives active jobs without lane a lane, unless rewrite answers null', async () => {
    await enqueueInOrder(
      laned(10, null, { keep: false }),
      laned(11, null, { keep: false }),
      laned(12, null, { keep: true }),
      laned(13, null, { keep: false }),
      laned(14, 'a', { keep: false }),
      laned(15, null, { keep: false }, 'other.type'),
    );
    setStatus(11, 'retry_wait', RA);
    setStatus(13, 'succeeded');

    const changed = await db.jobs.assignLane({
      type: TYPE,
      lane: 'b',
      rewrite: (p) => ((p as { keep: boolean }).keep ? null : { ...(p as object), laned: true }),
      now: LATER,
    });

    expect(changed).toBe(2);
    expect(await db.jobs.get(uuid(10))).toMatchObject({
      lane: 'b',
      status: 'queued',
      attempt: 0,
      payload: { keep: false, laned: true },
      updatedAt: LATER,
    });
    expect(await db.jobs.get(uuid(11))).toMatchObject({
      lane: 'b',
      status: 'retry_wait',
      attempt: 2,
      runAfter: RA,
      errorCode: 'provider_timeout',
      payload: { keep: false, laned: true },
    });
    expect(await db.jobs.get(uuid(12))).toMatchObject({ lane: null, payload: { keep: true }, updatedAt: T2 });
    expect(await db.jobs.get(uuid(13))).toMatchObject({ lane: null, payload: { keep: false } });
    expect(await db.jobs.get(uuid(14))).toMatchObject({ lane: 'a', payload: { keep: false } });
    expect(await db.jobs.get(uuid(15))).toMatchObject({ lane: null, payload: { keep: false } });
  });

  test('waitingByLane counts queued and retry_wait jobs per lane', async () => {
    await enqueueInOrder(
      laned(10, 'a'),
      laned(11, 'a'),
      laned(12, 'a'),
      laned(13, null),
      laned(14, 'b'),
      laned(15, 'a', { version: 1 }, 'other.type'),
    );
    setStatus(11, 'retry_wait', LATER);
    setStatus(12, 'running');
    setStatus(14, 'failed');
    const waiting = await db.jobs.waitingByLane(TYPE);
    expect(waiting).toHaveLength(2);
    expect(waiting).toEqual(
      expect.arrayContaining([
        { lane: 'a', waiting: 2 },
        { lane: null, waiting: 1 },
      ]),
    );
    expect(await db.jobs.waitingByLane('none')).toEqual([]);
  });

  test('countActiveInLane counts every active job of the lane', async () => {
    await enqueueInOrder(
      laned(10, 'a'),
      laned(11, 'a'),
      laned(12, 'a'),
      laned(13, 'a'),
      laned(14, 'b'),
      laned(15, 'a', {}, 'other.type'),
    );
    setStatus(11, 'running');
    setStatus(12, 'waiting_remote');
    setStatus(13, 'cancelled');
    expect(await db.jobs.countActiveInLane(TYPE, 'a')).toBe(3);
    expect(await db.jobs.countActiveInLane(TYPE, 'b')).toBe(1);
    expect(await db.jobs.countActiveInLane(TYPE, 'c')).toBe(0);
  });

  test('latestPayloadOfLane answers the payload of the newest job of the lane in any status', async () => {
    await enqueueInOrder(
      laned(10, 'a', { n: 1 }),
      laned(11, 'a', { n: 2 }),
      laned(12, 'b', { n: 3 }),
      laned(13, null, { n: 4 }),
    );
    setStatus(11, 'failed');
    expect(await db.jobs.latestPayloadOfLane(TYPE, 'a')).toEqual({ n: 2 });
    expect(await db.jobs.latestPayloadOfLane(TYPE, null)).toEqual({ n: 4 });
    expect(await db.jobs.latestPayloadOfLane(TYPE, 'c')).toBeNull();
    expect(await db.jobs.latestPayloadOfLane('other.type', 'a')).toBeNull();
  });

  test('latestPayloadOfLane breaks a created_at tie by the higher id', async () => {
    await enqueue(T0, laned(10, 'a', { n: 10 }), laned(11, 'a', { n: 11 }));
    expect(await db.jobs.latestPayloadOfLane(TYPE, 'a')).toEqual({ n: 11 });
  });

  test('list filters by lane and carries provider id, provider name and model', async () => {
    const v4 = { version: 4, model: 'm4', mode: 'apply', prompt: null, providerName: 'RunPod' };
    await enqueueInOrder(
      laned(10, 'a', v4),
      laned(11, 'b', { version: 2, model: 'm2', mode: 'apply' }),
      laned(12, null),
    );

    const all = await db.jobs.list({ limit: 10, offset: 0 });
    expect(all.total).toBe(3);
    expect(all.items.map((i) => [i.id, i.providerId, i.providerName, i.model])).toEqual([
      [uuid(12), null, null, null],
      [uuid(11), 'b', null, 'm2'],
      [uuid(10), 'a', 'RunPod', 'm4'],
    ]);

    const a = await db.jobs.list({ limit: 10, offset: 0, lane: 'a' });
    expect(a.total).toBe(1);
    expect(a.items[0]).toMatchObject({
      id: uuid(10),
      providerId: 'a',
      providerName: 'RunPod',
      model: 'm4',
      createdAt: T0,
    });
    expect(await db.jobs.list({ limit: 10, offset: 0, lane: 'a', status: 'failed' })).toEqual({ items: [], total: 0 });
    expect((await db.jobs.list({ limit: 10, offset: 0, lane: 'b' })).items[0]?.createdAt).toBe(T1);
  });

  test('list narrows to the given ids within the status and lane filters', async () => {
    await enqueueInOrder(laned(10, 'a'), laned(11, 'a'), laned(12, 'b'));

    const chosen = await db.jobs.list({ limit: 10, offset: 0, ids: [uuid(10), uuid(12)] });
    expect(chosen.total).toBe(2);
    expect(chosen.items.map((i) => i.id)).toEqual([uuid(12), uuid(10)]);
    expect(
      (await db.jobs.list({ limit: 10, offset: 0, ids: [uuid(10), uuid(12)], lane: 'a' })).items.map((i) => i.id),
    ).toEqual([uuid(10)]);
    expect(await db.jobs.list({ limit: 10, offset: 0, ids: [uuid(10)], status: 'failed' })).toEqual({
      items: [],
      total: 0,
    });
    expect(await db.jobs.list({ limit: 10, offset: 0, ids: [uuid(99)] })).toEqual({ items: [], total: 0 });
  });

  test('retry keeps the lane and the payload', async () => {
    await enqueue(T0, newJob(10, { lane: 'a', payload: { n: 1 }, resourceClass: 'remote_api' }));
    expect((await claim(T0, 'remote_api'))?.id).toBe(uuid(10));
    await db.jobs.finish(uuid(10), { status: 'failed', errorCode: 'provider_rejected', now: T1 });
    expect(await db.jobs.retry({ id: uuid(10), now: T2 })).toBe(1);
    expect(await db.jobs.get(uuid(10))).toMatchObject({ status: 'queued', lane: 'a', payload: { n: 1 } });
  });
});

describe('download jobs', () => {
  const DL = 'file.download';
  const LATER = '2026-01-01T01:00:00.000Z';
  const UNTIL = '2026-01-01T00:30:00.000Z';
  const download = (n: number, url: string, o: Partial<NewJob> = {}): NewJob =>
    newJob(n, {
      type: DL,
      resourceClass: 'io',
      lane: new URL(url).host,
      payload: { v: 1, url, target: null, skipDuplicates: true },
      ...o,
    });
  const claimIo = (now: string) => db.jobs.claimNext({ resourceClass: 'io', types: [DL], now });

  test('setOutcome on a running job sets the file and the result, visible in list', async () => {
    await enqueue(T0, download(10, 'https://example.org/a.png'));
    expect(await db.jobs.setOutcome(uuid(10), { fileId: FILE_ID, result: 'already_present', now: T1 })).toBe(false);
    expect((await claimIo(T1))?.id).toBe(uuid(10));
    expect(await db.jobs.setOutcome(uuid(10), { fileId: uuid(999), result: null, now: T1 })).toBe(false);
    expect(await db.jobs.setOutcome(uuid(10), { fileId: FILE_ID, result: 'already_present', now: T2 })).toBe(true);
    expect(await db.jobs.get(uuid(10))).toMatchObject({ status: 'running', fileId: FILE_ID, updatedAt: T2 });
    const { items } = await db.jobs.list({ limit: 10, offset: 0 });
    expect(items[0]).toMatchObject({ id: uuid(10), fileId: FILE_ID, fileName: 'Pump.png', result: 'already_present' });
  });

  test('setOutcome with a null file records a filtered download without a file', async () => {
    await enqueue(T0, download(10, 'https://example.org/a.png'));
    expect(await db.jobs.setOutcome(uuid(10), { fileId: null, result: 'filtered', now: T1 })).toBe(false);
    await claimIo(T1);
    expect(await db.jobs.setOutcome(uuid(10), { fileId: null, result: 'filtered', now: T2 })).toBe(true);
    expect(await db.jobs.get(uuid(10))).toMatchObject({ status: 'running', fileId: null, updatedAt: T2 });
    expect((await db.jobs.list({ limit: 1, offset: 0 })).items[0]).toMatchObject({
      fileId: null,
      fileName: null,
      result: 'filtered',
    });
  });

  test('list answers host and url of a download job and no provider', async () => {
    await enqueue(T0, download(10, 'https://Example.org:8443/a.png'));
    await enqueue(T1, newJob(11, { lane: 'p1', payload: { version: 2, model: 'm2', mode: 'apply' } }));
    const { items } = await db.jobs.list({ limit: 10, offset: 0 });
    expect(items.map((i) => [i.id, i.providerId, i.providerName, i.model, i.host, i.url, i.result])).toEqual([
      [uuid(11), 'p1', null, 'm2', null, null, null],
      [uuid(10), null, null, null, 'example.org:8443', 'https://Example.org:8443/a.png', null],
    ]);
  });

  test('retry of a download job clears the result and the file', async () => {
    await enqueue(T0, download(10, 'https://example.org/a.png'));
    await claimIo(T0);
    await db.jobs.setOutcome(uuid(10), { fileId: FILE_ID, result: 'already_present', now: T1 });
    await db.jobs.finish(uuid(10), { status: 'cancelled', errorCode: null, now: T1 });
    expect(await db.jobs.retry({ id: uuid(10), now: T2 })).toBe(1);
    expect(await db.jobs.get(uuid(10))).toMatchObject({ status: 'queued', fileId: null });
    expect((await db.jobs.list({ limit: 1, offset: 0 })).items[0]).toMatchObject({
      fileId: null,
      fileName: null,
      result: null,
    });
  });

  test('retry of another job keeps its file', async () => {
    await enqueue(T0, newJob(10, { fileId: FILE_ID, resourceClass: 'remote_api' }));
    await claim(T0, 'remote_api');
    await db.jobs.finish(uuid(10), { status: 'failed', errorCode: 'provider_rejected', now: T1 });
    expect(await db.jobs.retry({ id: uuid(10), now: T2 })).toBe(1);
    expect(await db.jobs.get(uuid(10))).toMatchObject({ status: 'queued', fileId: FILE_ID });
  });

  test('holdLane moves the waiting jobs of one lane until a time and claimNext skips them until then', async () => {
    await enqueue(T0, download(10, 'https://a/1'));
    await enqueue(T1, download(11, 'https://a/2'));
    await enqueue(T2, download(12, 'https://b/1'));
    await enqueue(T3, download(13, 'https://a/3'));
    await enqueue(T3, download(14, 'https://a/4'));
    await enqueue(T3, download(15, 'https://a/5', { type: 'other.type' }));
    // 13 runs, 14 already waits longer than the hold.
    handle.prepare("update job set status = 'running', attempt = 1 where id = ?").run(uuid(13));
    handle
      .prepare(
        "update job set status = 'retry_wait', run_after = ?, attempt = 2, error_code = 'provider_timeout' where id = ?",
      )
      .run(LATER, uuid(14));
    // 11 waits shorter than the hold, with an error.
    handle
      .prepare(
        "update job set status = 'retry_wait', run_after = ?, attempt = 1, error_code = 'provider_timeout', error_message = ? where id = ?",
      )
      .run(T3, JOB_ERROR_MESSAGES.provider_timeout, uuid(11));

    expect(await db.jobs.holdLane({ types: [DL], lane: 'a', until: UNTIL, now: T9 })).toBe(2);
    expect(await db.jobs.get(uuid(10))).toMatchObject({
      status: 'retry_wait',
      runAfter: UNTIL,
      attempt: 0,
      errorCode: null,
      updatedAt: T9,
    });
    expect(await db.jobs.get(uuid(11))).toMatchObject({
      status: 'retry_wait',
      runAfter: UNTIL,
      attempt: 1,
      errorCode: 'provider_timeout',
      errorMessage: JOB_ERROR_MESSAGES.provider_timeout,
    });
    expect(await db.jobs.get(uuid(12))).toMatchObject({ status: 'queued', runAfter: null });
    expect(await db.jobs.get(uuid(13))).toMatchObject({ status: 'running' });
    expect(await db.jobs.get(uuid(14))).toMatchObject({ status: 'retry_wait', runAfter: LATER });
    expect(await db.jobs.get(uuid(15))).toMatchObject({ status: 'queued' });

    expect((await claimIo(T9))?.id).toBe(uuid(12));
    expect(await claimIo(T9)).toBeNull();
    expect((await claimIo(UNTIL))?.id).toBe(uuid(10));
    expect((await claimIo(UNTIL))?.id).toBe(uuid(11));
    expect(await claimIo(UNTIL)).toBeNull();
  });

  test('holdLane with lane null holds the jobs without a lane only', async () => {
    await enqueue(T0, download(10, 'https://a/1', { lane: null }));
    await enqueue(T1, download(11, 'https://a/2'));
    expect(await db.jobs.holdLane({ types: [DL], lane: null, until: UNTIL, now: T2 })).toBe(1);
    expect(await db.jobs.get(uuid(10))).toMatchObject({ status: 'retry_wait', runAfter: UNTIL });
    expect(await db.jobs.get(uuid(11))).toMatchObject({ status: 'queued' });
    expect(await db.jobs.holdLane({ types: [], lane: 'a', until: UNTIL, now: T2 })).toBe(0);
  });
});
