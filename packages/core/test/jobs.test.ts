import { describe, expect, it } from 'vitest';
import type { JobStatus } from '@assetforge/contracts';
import {
  cancelAllJobs,
  cancelJob,
  clearFinishedJobs,
  countJobs,
  InvalidOperationError,
  JobError,
  listJobs,
  NotFoundError,
  retryFailedJobs,
  retryJob,
  WorkspaceManager,
  type JobControl,
  type WorkspaceSession,
} from '../src/index.js';
import { createFakeHost, trashForTest, type InMemoryDatabase } from './fakes.js';

const ROOT = '/ws/a';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
const T0 = '2026-01-01T00:00:00.000Z';

/** A complete inbox file row; jobs are only queued for a file that exists. */
async function addFile(db: InMemoryDatabase, fileId: string): Promise<void> {
  await db.files.insertPending({
    id: fileId,
    storageId: 'storage',
    originalName: `${fileId}.png`,
    relativePath: `inbox/${fileId}_${fileId}.png`,
    mimeType: 'image/png',
    importedAt: T0,
    kind: 'image',
  });
  await db.files.markComplete(fileId, { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
}

class FakeControl implements JobControl {
  readonly cancelled: string[] = [];
  cancelAllCalls = 0;
  wake(): void {}
  async cancel(jobId: string): Promise<void> {
    this.cancelled.push(jobId);
  }
  async cancelAll(): Promise<number> {
    this.cancelAllCalls++;
    return 5;
  }
}

async function setup() {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const db = fake.databases.get(summary.id)!;
  const session: WorkspaceSession = await manager.read(async (s) => s);
  let n = 0;
  /** Adds a job for `fileId` (its dedupe key derived from it, its file row created when missing) and sets its status. */
  const addJob = async (status: JobStatus, fileId = `file-${++n}`) => {
    const id = `job-${++n}`;
    if (db.files.records.get(fileId) === undefined) await addFile(db, fileId);
    await db.jobs.enqueue({
      jobs: [{ id, type: 'test', resourceClass: 'cpu', fileId, lane: null, payload: {}, dedupeKey: `test:${fileId}` }],
      now: T0,
    });
    db.jobs.rows.find((r) => r.id === id)!.status = status;
    return id;
  };
  return { db, session, addJob, control: new FakeControl() };
}

describe('job use cases', () => {
  it('counts retry_wait and waiting_remote together as waiting', async () => {
    const { session, addJob } = await setup();
    for (const s of [
      'queued',
      'running',
      'running',
      'retry_wait',
      'waiting_remote',
      'failed',
      'cancelled',
      'succeeded',
    ] as const) {
      await addJob(s);
    }
    expect(await countJobs(session)).toEqual({
      queued: 1,
      running: 2,
      waiting: 2,
      failed: 1,
      cancelled: 1,
      succeeded: 1,
    });
  });

  it('lists jobs by status', async () => {
    const { session, addJob } = await setup();
    await addJob('queued');
    const failed = await addJob('failed');
    expect(await listJobs(session, { limit: 10, offset: 0, status: 'failed' })).toMatchObject({
      items: [{ id: failed }],
      total: 1,
    });
  });

  it('cancels a pending job through the control and leaves a finished one alone', async () => {
    const { session, addJob, control } = await setup();
    const queued = await addJob('queued');
    const done = await addJob('succeeded');
    await cancelJob(session, control, queued);
    await cancelJob(session, control, done);
    expect(control.cancelled).toEqual([queued]);
  });

  it('rejects cancelling an unknown job with not_found', async () => {
    const { session, control } = await setup();
    await expect(cancelJob(session, control, UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('cancels all jobs through the control and answers its count', async () => {
    const { db, session, addJob, control } = await setup();
    await addJob('queued');
    await addJob('running');
    expect(await cancelAllJobs(session, control)).toBe(5);
    expect(control.cancelAllCalls).toBe(1);
    expect(control.cancelled).toEqual([]);
    // The scheduler ends the jobs itself, with each handler's `settled`; the use case writes nothing.
    expect(db.jobs.rows.map((r) => r.status).sort()).toEqual(['queued', 'running']);
  });

  it('retries a failed job', async () => {
    const { db, session, addJob } = await setup();
    const failed = await addJob('failed');
    await retryJob(session, failed);
    expect(db.jobs.rows.find((r) => r.id === failed)).toMatchObject({ status: 'queued', attempt: 0 });
  });

  it('rejects retrying an unknown job, a queued job and a job whose file has an active job', async () => {
    const { session, addJob } = await setup();
    await expect(retryJob(session, UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
    const queued = await addJob('queued');
    await expect(retryJob(session, queued)).rejects.toBeInstanceOf(InvalidOperationError);
    const failed = await addJob('failed', 'shared');
    await addJob('queued', 'shared');
    await expect(retryJob(session, failed)).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it('retries every failed or cancelled job and clears the finished ones', async () => {
    const { db, session, addJob } = await setup();
    await addJob('failed');
    await addJob('cancelled');
    await addJob('succeeded');
    await addJob('queued');
    expect(await retryFailedJobs(session)).toBe(2);
    await addJob('failed');
    expect(await clearFinishedJobs(session)).toBe(2);
    expect(db.jobs.rows.map((r) => r.status)).toEqual(['queued', 'queued', 'queued']);
  });
});

describe('jobs of trashed files', () => {
  it('retryJob refuses a job whose file is in the trash', async () => {
    const { db, session, addJob } = await setup();
    const fileId = crypto.randomUUID();
    const failed = await addJob('failed', fileId);
    await trashForTest(session, [fileId]);
    const error = await retryJob(session, failed).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidOperationError);
    expect((error as Error).message).toBe('The file of this job is in the trash');
    expect(db.jobs.rows.find((r) => r.id === failed)!.status).toBe('failed');
  });

  it('retryFailedJobs skips it and counts only the others', async () => {
    const { db, session, addJob } = await setup();
    const fileId = crypto.randomUUID();
    const trashedJob = await addJob('failed', fileId);
    await addJob('cancelled', crypto.randomUUID());
    await trashForTest(session, [fileId]);
    expect(await retryFailedJobs(session)).toBe(1);
    expect(db.jobs.rows.find((r) => r.id === trashedJob)!.status).toBe('failed');
  });
});

describe('JobError', () => {
  it('keeps a finite wait of zero or more and drops anything else', () => {
    expect(new JobError('download_throttled', { retryAfterMs: 90_000 }).retryAfterMs).toBe(90_000);
    expect(new JobError('download_throttled', { retryAfterMs: 0 }).retryAfterMs).toBe(0);
    expect(new JobError('download_throttled').retryAfterMs).toBeNull();
    expect(new JobError('download_throttled', { retryAfterMs: null }).retryAfterMs).toBeNull();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      expect(new JobError('download_throttled', { retryAfterMs: bad }).retryAfterMs).toBeNull();
    }
  });
});
