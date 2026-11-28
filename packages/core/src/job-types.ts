import { JOB_ERROR_MESSAGES, type JobErrorCode, type JobStatus, type ResourceClass } from '@assetforge/contracts';

// The job model shared by the job port, the handlers and the job use cases: the row, the handler contract and
// what use cases need of a running scheduler.

/** A persistent job row. `payload` is the parsed JSON; each job type validates it with its own schema. */
export interface Job {
  /** The job id. */
  id: string;
  /** The job type, which picks the handler. */
  type: string;
  /** The resource class whose limit the job counts against. */
  resourceClass: ResourceClass;
  /** The technical job status. */
  status: JobStatus;
  /** The file the job works on; null for jobs without one. */
  fileId: string | null;
  /** The queue lane within the resource class (for analysis jobs the provider id); null for jobs without one. */
  lane: string | null;
  /** The parsed payload. */
  payload: unknown;
  /** At most one active job per key; null for jobs that are never deduplicated. */
  dedupeKey: string | null;
  /** Number of started runs. */
  attempt: number;
  /** The earliest time of the next run; null when it may run at once. */
  runAfter: string | null;
  /** The code of the latest failure. */
  errorCode: JobErrorCode | null;
  /** The fixed message of the latest failure. */
  errorMessage: string | null;
  /** When the job was queued. */
  createdAt: string;
  /** Start of the latest run. */
  startedAt: string | null;
  /** When the job ended. */
  finishedAt: string | null;
  /** When the row was last written. */
  updatedAt: string;
}

/** A job to be queued. */
export interface NewJob {
  /** The job id. */
  id: string;
  /** The job type. */
  type: string;
  /** The resource class whose limit the job counts against. */
  resourceClass: ResourceClass;
  /** The file the job works on; null for jobs without one. */
  fileId: string | null;
  /** The queue lane within the resource class; null for jobs without one. */
  lane: string | null;
  /** The payload, stored as JSON. */
  payload: unknown;
  /** At most one active job per key; null for jobs that are never deduplicated. */
  dedupeKey: string | null;
}

/** The failure of a job run. Its message is always the fixed text of its code; the cause is never stored. */
export class JobError extends Error {
  /** The error code stored on the job. */
  readonly code: JobErrorCode;
  /** For a retryable code: wait at least this long before the next run and hold the job's lane until then. */
  readonly retryAfterMs: number | null;

  /**
   * @param code the error code; the message is its fixed text
   * @param options the cause (kept on the error only, never stored) and the wait before the next run
   */
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
export type JobOutcome =
  { status: 'succeeded' } | { status: 'failed'; errorCode: JobErrorCode } | { status: 'cancelled' };

/** Runs the jobs of one type. */
export interface JobHandler {
  /** The resource class of the jobs it runs. */
  resourceClass: ResourceClass;
  /** What happens to a job found `running` when a workspace opens. `fail` is for paid work with an unclear outcome. */
  onInterrupted: 'requeue' | 'fail';
  /** The error code an interrupted job fails with under `onInterrupted: 'fail'`; `internal_error` when absent. */
  interruptedCode?: JobErrorCode;
  /**
   * Runs one job. Must stop soon after `signal` aborts.
   *
   * @param job the job
   * @param signal aborts the run
   * @returns resolves on success; throws `JobError(code)` otherwise
   */
  run(job: Job, signal: AbortSignal): Promise<void>;
  /**
   * Runs inside the transaction that ends the job, with the outcome it ends with. Synchronous; a throw
   * rolls the end back.
   *
   * @param job the job
   * @param outcome how it ends
   */
  settled?(job: Job, outcome: JobOutcome): void;
}

/** How a cancel treats a running job. */
export interface CancelOptions {
  /** Cancel the job only while it is pending; never abort a running one. */
  pendingOnly?: boolean;
}

/** What use cases need of a running scheduler. */
export interface JobControl {
  /** Call after enqueue, retry or cancel, so the scheduler looks for work. */
  wake(): void;
  /**
   * Aborts a running job, which then ends `cancelled`, or cancels a pending one. Resolves without waiting for the
   * handler. A run whose handler is already done keeps its outcome; the cancel waits until it is stored and then
   * cancels a retry it scheduled. With `pendingOnly` a running job is left alone: only a job still pending when the
   * cancel reaches the database ends, so a job claimed meanwhile keeps running. Rejects when the cancel cannot be
   * written.
   *
   * @param jobId the job
   * @param options whether only a pending job is cancelled
   * @returns resolves once the cancel is written
   */
  cancel(jobId: string, options?: CancelOptions): Promise<void>;
  /**
   * Cancels every pending job and aborts every running one.
   *
   * @returns how many
   */
  cancelAll(): Promise<number>;
}

/** What a job handler changed outside its own job row. Calls must not throw; a handler guards them anyway. */
export interface JobEffects {
  /**
   * A file's data changed.
   *
   * @param fileId the file
   */
  fileChanged(fileId: string): void;
  /**
   * A file was added to this asset.
   *
   * @param assetId the asset; null is the inbox
   */
  fileAdded(assetId: string | null): void;
}

/**
 * Reports one effect; a throwing listener never fails the job that reports it.
 *
 * @param effects the listener; nothing is reported without one
 * @param report calls the listener
 */
export function reportEffect(effects: JobEffects | undefined, report: (effects: JobEffects) => void): void {
  if (effects === undefined) return;
  try {
    report(effects);
  } catch {
    // The effects only drive list updates; the job's own outcome stands.
  }
}
