import { JOB_ERROR_MESSAGES, type JobErrorCode, type JobStatus, type ResourceClass } from '@assetforge/contracts';

/** A persistent job row. `payload` is the parsed JSON; each job type validates it with its own schema. */
export interface Job {
  id: string;
  type: string;
  resourceClass: ResourceClass;
  status: JobStatus;
  fileId: string | null;
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
  payload: unknown;
  dedupeKey: string | null;
}

/** The failure of a job run. Its message is always the fixed text of its code; the cause is never stored. */
export class JobError extends Error {
  readonly code: JobErrorCode;

  constructor(code: JobErrorCode, options?: { cause?: unknown }) {
    super(JOB_ERROR_MESSAGES[code], options);
    this.code = code;
    this.name = new.target.name;
  }
}

/** Runs the jobs of one type. */
export interface JobHandler {
  resourceClass: ResourceClass;
  /** What happens to a job found `running` when a workspace opens. `fail` is for paid work with an unclear outcome. */
  onInterrupted: 'requeue' | 'fail';
  /** Resolves on success; throws `JobError(code)` otherwise. Must stop soon after `signal` aborts. */
  run(job: Job, signal: AbortSignal): Promise<void>;
}

/** What use cases need of a running scheduler. */
export interface JobControl {
  /** Call after enqueue, retry or cancel, so the scheduler looks for work. */
  wake(): void;
  /** Aborts a running job, which then ends `cancelled`, or cancels a pending one. Resolves without waiting for the handler. */
  cancel(jobId: string): Promise<void>;
}
