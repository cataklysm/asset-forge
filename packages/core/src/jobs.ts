import {
  FINISHED_JOB_STATUSES,
  IMAGE_GENERATE_JOB,
  JOB_ERROR_MESSAGES,
  type JobErrorCode,
  type JobStatus,
  type JobSummary,
  type JobView,
  type ResourceClass,
} from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError } from './errors.js';
import type { WorkspaceSession } from './session.js';

/** A persistent job row. `payload` is the parsed JSON; each job type validates it with its own schema. */
export interface Job {
  id: string;
  type: string;
  resourceClass: ResourceClass;
  status: JobStatus;
  fileId: string | null;
  /** The queue lane within the resource class (for analysis jobs the provider id); null for jobs without one. */
  lane: string | null;
  payload: unknown;
  dedupeKey: string | null;
  /** Number of started runs. */
  attempt: number;
  runAfter: string | null;
  errorCode: JobErrorCode | null;
  errorMessage: string | null;
  createdAt: string;
  /** Start of the latest run. */
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface NewJob {
  id: string;
  type: string;
  resourceClass: ResourceClass;
  fileId: string | null;
  lane: string | null;
  payload: unknown;
  dedupeKey: string | null;
}

/** The failure of a job run. Its message is always the fixed text of its code; the cause is never stored. */
export class JobError extends Error {
  readonly code: JobErrorCode;
  /** For a retryable code: wait at least this long before the next run and hold the job's lane until then. */
  readonly retryAfterMs: number | null;

  constructor(code: JobErrorCode, options?: { cause?: unknown; retryAfterMs?: number | null }) {
    super(JOB_ERROR_MESSAGES[code], options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    const wait = options?.retryAfterMs;
    // Only a finite wait of zero or more is kept; NaN, an infinity or a negative value would break the timer.
    this.retryAfterMs = typeof wait === 'number' && Number.isFinite(wait) && wait >= 0 ? wait : null;
    this.name = new.target.name;
  }
}

/** How a job ended. */
export type JobOutcome = { status: 'succeeded' } | { status: 'failed'; errorCode: JobErrorCode } | { status: 'cancelled' };

/** Runs the jobs of one type. */
export interface JobHandler {
  resourceClass: ResourceClass;
  /** What happens to a job found `running` when a workspace opens. `fail` is for paid work with an unclear outcome. */
  onInterrupted: 'requeue' | 'fail';
  /** The error code an interrupted job fails with under `onInterrupted: 'fail'`; `internal_error` when absent. */
  interruptedCode?: JobErrorCode;
  /** Resolves on success; throws `JobError(code)` otherwise. Must stop soon after `signal` aborts. */
  run(job: Job, signal: AbortSignal): Promise<void>;
  /**
   * Runs inside the transaction that ends the job, with the outcome it ends with. Synchronous; a throw
   * rolls the end back.
   */
  settled?(job: Job, outcome: JobOutcome): void;
}

/** What use cases need of a running scheduler. */
export interface JobControl {
  /** Call after enqueue, retry or cancel, so the scheduler looks for work. */
  wake(): void;
  /** Aborts a running job, which then ends `cancelled`, or cancels a pending one. Resolves without waiting for the handler. */
  cancel(jobId: string): Promise<void>;
  /** Cancels every pending job and aborts every running one. Answers how many. */
  cancelAll(): Promise<number>;
}

/** What a job handler changed outside its own job row. Calls must not throw; a handler guards them anyway. */
export interface JobEffects {
  fileChanged(fileId: string): void;
  /** A file was added to this asset; null is the inbox. */
  fileAdded(assetId: string | null): void;
}

/** Reports one effect; a throwing listener never fails the job that reports it. */
export function reportEffect(effects: JobEffects | undefined, report: (effects: JobEffects) => void): void {
  if (effects === undefined) return;
  try {
    report(effects);
  } catch {
    // The effects only drive list updates; the job's own outcome stands.
  }
}

const FINISHED: readonly JobStatus[] = FINISHED_JOB_STATUSES;

async function requireJob(s: WorkspaceSession, jobId: string): Promise<Job> {
  const job = await s.database.jobs.get(jobId);
  if (job === null) throw new NotFoundError(`Job ${jobId} does not exist`);
  return job;
}

/** Newest first; with `lane` only the jobs of that lane. */
export function listJobs(
  s: WorkspaceSession,
  q: { limit: number; offset: number; status?: JobStatus; lane?: string; ids?: readonly string[] },
): Promise<{ items: JobView[]; total: number }> {
  return s.database.jobs.list(q);
}

/** Jobs per status; `waiting` is `retry_wait` and `waiting_remote` together. */
export async function countJobs(s: WorkspaceSession): Promise<Omit<JobSummary, 'changes' | 'paused' | 'pausedHosts'>> {
  const c = await s.database.jobs.counts();
  return {
    queued: c.queued,
    running: c.running,
    waiting: c.retry_wait + c.waiting_remote,
    failed: c.failed,
    cancelled: c.cancelled,
    succeeded: c.succeeded,
  };
}

/** Cancels a pending or running job; a finished job is left alone. */
export async function cancelJob(s: WorkspaceSession, control: JobControl, jobId: string): Promise<void> {
  const job = await requireJob(s, jobId);
  if (FINISHED.includes(job.status)) return;
  await control.cancel(jobId);
}

/**
 * Cancels every pending job and aborts every running one through the scheduler, which ends each with its
 * handler's `settled`. Returns how many.
 */
export function cancelAllJobs(_s: WorkspaceSession, control: JobControl): Promise<number> {
  return control.cancelAll();
}

/** Queues a failed or cancelled job again; `invalid_operation` for any other status or when its file already has an active job. */
export async function retryJob(s: WorkspaceSession, jobId: string): Promise<void> {
  const job = await requireJob(s, jobId);
  if (job.status !== 'failed' && job.status !== 'cancelled') {
    throw new InvalidOperationError('Only a failed or cancelled job can be retried');
  }
  if (job.fileId !== null && (await s.database.files.get(job.fileId))?.deletedAt != null) {
    throw new InvalidOperationError('The file of this job is in the trash');
  }
  const retried = await s.database.jobs.retry({ id: jobId, now: s.now().toISOString() });
  if (retried === 0) throw new InvalidOperationError('The file of this job already has an active job');
}

/**
 * Queues every failed or cancelled job whose file has no active job. Returns how many. Generation jobs are
 * paid work and only ever run again through `retryGeneration`.
 */
export function retryFailedJobs(s: WorkspaceSession): Promise<number> {
  return s.database.jobs.retry({ now: s.now().toISOString(), excludeTypes: [IMAGE_GENERATE_JOB] });
}

/** Deletes every succeeded, failed or cancelled job. Returns how many. */
export function clearFinishedJobs(s: WorkspaceSession): Promise<number> {
  return s.database.jobs.clearFinished();
}
