import { describe, expect, it } from 'vitest';
import type { JobStatus } from '@assetforge/contracts';
import {
  cancelAllJobs,
  cancelJob,
  clearFinishedJobs,
  countJobs,
  InvalidOperationError,
  listJobs,
  NotFoundError,
  retryFailedJobs,
  retryJob,
  WorkspaceManager,
  type JobControl,
  type WorkspaceSession,
} from '../src/index.js';
import { createFakeHost } from './fakes.js';

const ROOT = '/ws/a';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
const T0 = '2026-01-01T00:00:00.000Z';

class FakeControl implements JobControl {
  readonly cancelled: string[] = [];
  wake(): void {}
  async cancel(jobId: string): Promise<void> {
    this.cancelled.push(jobId);
  }
}

async function setup() {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const db = fake.databases.get(summary.id)!;
  const session: WorkspaceSession = await manager.read(async (s) => s);
  let n = 0;
  /** Adds a job for `fileId` (its dedupe key derived from it) and sets its status. */
  const addJob = async (status: JobStatus, fileId = `file-${++n}`) => {
    const id = `job-${++n}`;
    await db.jobs.enqueue({
      jobs: [{ id, type: 'test', resourceClass: 'cpu', fileId, payload: {}, dedupeKey: `test:${fileId}` }],
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
    for (const s of ['queued', 'running', 'running', 'retry_wait', 'waiting_remote', 'failed', 'cancelled', 'succeeded'] as const) {
      await addJob(s);
    }
    expect(await countJobs(session)).toEqual({ queued: 1, running: 2, waiting: 2, failed: 1, cancelled: 1, succeeded: 1 });
  });

  it('lists jobs by status', async () => {
    const { session, addJob } = await setup();
    await addJob('queued');
    const failed = await addJob('failed');
    expect(await listJobs(session, { limit: 10, offset: 0, status: 'failed' })).toMatchObject({ items: [{ id: failed }], total: 1 });
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

  it('cancels all pending jobs and aborts each running one once', async () => {
    const { db, session, addJob, control } = await setup();
    await addJob('queued');
    await addJob('retry_wait');
    await addJob('waiting_remote');
    const r1 = await addJob('running');
    const r2 = await addJob('running');
    await addJob('succeeded');
    expect(await cancelAllJobs(session, control)).toBe(5);
    expect([...control.cancelled].sort()).toEqual([r1, r2].sort());
    expect(db.jobs.rows.filter((r) => r.status === 'cancelled')).toHaveLength(3);
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
