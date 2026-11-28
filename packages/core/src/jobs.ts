import {
  FINISHED_JOB_STATUSES,
  IMAGE_GENERATE_JOB,
  type JobStatus,
  type JobSummary,
  type JobView,
  type ResourceClass,
} from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError } from './errors.js';
import type { CancelOptions, Job, JobControl } from './job-types.js';
import type { WorkspaceSession } from './session.js';

const FINISHED: readonly JobStatus[] = FINISHED_JOB_STATUSES;

/**
 * A job that must exist.
 *
 * @param session the open workspace
 * @param jobId the job
 * @returns it
 * @throws `NotFoundError` when it does not exist
 */
async function requireJob(session: WorkspaceSession, jobId: string): Promise<Job> {
  const job = await session.database.jobs.get(jobId);
  if (job === null) throw new NotFoundError(`Job ${jobId} does not exist`);
  return job;
}

/**
 * One page of jobs, newest first; with `lane` only the jobs of that lane, with `laneOutside` only the jobs of those
 * resource classes whose lane is set and not one of the given lanes.
 *
 * @param session the open workspace
 * @param query the page, and optionally the status, the lane, the lanes outside and the chosen ids
 * @returns the page and the total
 */
export function listJobs(
  session: WorkspaceSession,
  query: {
    limit: number;
    offset: number;
    status?: JobStatus;
    lane?: string;
    laneOutside?: { resourceClasses: readonly ResourceClass[]; lanes: readonly string[] };
    ids?: readonly string[];
  },
): Promise<{ items: JobView[]; total: number }> {
  return session.database.jobs.list(query);
}

/**
 * Jobs per status; `waiting` is `retry_wait` and `waiting_remote` together.
 *
 * @param session the open workspace
 * @returns the counts
 */
export async function countJobs(
  session: WorkspaceSession,
): Promise<Omit<JobSummary, 'changes' | 'paused' | 'pausedHosts'>> {
  const counts = await session.database.jobs.counts();
  return {
    queued: counts.queued,
    running: counts.running,
    waiting: counts.retry_wait + counts.waiting_remote,
    failed: counts.failed,
    cancelled: counts.cancelled,
    succeeded: counts.succeeded,
  };
}

/**
 * Cancels a pending or running job (with `pendingOnly` only a pending one); a finished job is left alone.
 *
 * @param session the open workspace
 * @param control the scheduler
 * @param jobId the job
 * @param options whether only a pending job is cancelled
 * @returns resolves once the cancel is written
 * @throws `NotFoundError` for an unknown job
 */
export async function cancelJob(
  session: WorkspaceSession,
  control: JobControl,
  jobId: string,
  options?: CancelOptions,
): Promise<void> {
  const job = await requireJob(session, jobId);
  if (FINISHED.includes(job.status)) return;
  await (options === undefined ? control.cancel(jobId) : control.cancel(jobId, options));
}

/**
 * Cancels every pending job and aborts every running one through the scheduler, which ends each with its
 * handler's `settled`.
 *
 * @param _session the open workspace; unused
 * @param control the scheduler
 * @returns how many
 */
export function cancelAllJobs(_session: WorkspaceSession, control: JobControl): Promise<number> {
  return control.cancelAll();
}

/**
 * Queues a failed or cancelled job again.
 *
 * @param session the open workspace
 * @param jobId the job
 * @returns resolves once it is queued
 * @throws `NotFoundError` for an unknown job; `InvalidOperationError` for any other status, a trashed file or when
 *   its file already has an active job
 */
export async function retryJob(session: WorkspaceSession, jobId: string): Promise<void> {
  const job = await requireJob(session, jobId);
  if (job.status !== 'failed' && job.status !== 'cancelled') {
    throw new InvalidOperationError('Only a failed or cancelled job can be retried');
  }
  await refuseTrashedFile(session, job.fileId);
  const retried = await session.database.jobs.retry({ id: jobId, now: session.now().toISOString() });
  if (retried > 0) return;
  // The repository skips a trashed file's job too; a trash that landed after the first look says so.
  await refuseTrashedFile(session, job.fileId);
  throw new InvalidOperationError('The file of this job already has an active job');
}

/**
 * Refuses a retry for a file in the trash.
 *
 * @param session the open workspace
 * @param fileId the job's file; null for a job without one
 * @returns resolves when the file is not in the trash
 * @throws `InvalidOperationError` when it is
 */
async function refuseTrashedFile(session: WorkspaceSession, fileId: string | null): Promise<void> {
  if (fileId === null) return;
  if ((await session.database.files.get(fileId))?.deletedAt != null) {
    throw new InvalidOperationError('The file of this job is in the trash');
  }
}

/**
 * Queues every failed or cancelled job whose file has no active job. Generation jobs are paid work and only ever
 * run again through `retryGeneration`.
 *
 * @param session the open workspace
 * @returns how many
 */
export function retryFailedJobs(session: WorkspaceSession): Promise<number> {
  return session.database.jobs.retry({ now: session.now().toISOString(), excludeTypes: [IMAGE_GENERATE_JOB] });
}

/**
 * Deletes every succeeded, failed or cancelled job.
 *
 * @param session the open workspace
 * @returns how many
 */
export function clearFinishedJobs(session: WorkspaceSession): Promise<number> {
  return session.database.jobs.clearFinished();
}
