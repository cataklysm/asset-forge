import type { JobErrorCode, JobResult, JobStatus, JobView, ResourceClass } from '@assetforge/contracts';
import type { Job, NewJob } from '../job-types.js';

/** The persistent job queue of a workspace. Every transition is guarded by the status it starts from. */
export interface JobRepository {
  /**
   * One transaction. Inserts each job as `queued`, attempt 0; a job whose dedupe key is held by an active job (or by
   * an earlier job of the same call) is skipped.
   *
   * @param request the jobs and the time
   * @returns the inserted ids
   */
  enqueue(request: { jobs: readonly NewJob[]; now: string }): Promise<string[]>;
  /**
   * One job.
   *
   * @param id the job
   * @returns the job; null for an unknown id
   */
  get(id: string): Promise<Job | null>;
  /**
   * Every job in one status.
   *
   * @param status the status
   * @returns the jobs, oldest created_at first, then id
   */
  listByStatus(status: JobStatus): Promise<Job[]>;
  /**
   * Oldest job (created_at, id) of the class and one of `types` that is `queued`, or `retry_wait` with run_after <= now,
   * whose lane is not in `excludeLanes` (`null` in it excludes the jobs without a lane). Atomically sets `running`,
   * attempt + 1, started_at = now, clears run_after and the error.
   *
   * @param request the resource class, the job types, the time and the lanes to leave out
   * @returns the claimed job; null when none is due
   */
  claimNext(request: {
    resourceClass: ResourceClass;
    types: readonly string[];
    now: string;
    excludeLanes?: readonly (string | null)[];
  }): Promise<Job | null>;
  /**
   * When the next retry of these types is due.
   *
   * @param types the job types
   * @param excludeLanes the lanes to leave out
   * @returns the earliest run_after of `retry_wait` jobs of these types whose lane is not in `excludeLanes`; null when
   *   there is none
   */
  nextRunAfter(types: readonly string[], excludeLanes?: readonly (string | null)[]): Promise<string | null>;
  /**
   * running → succeeded | failed | cancelled, finished_at = now, message from JOB_ERROR_MESSAGES.
   * `settled` runs inside the transaction, once and only when the row changed; a throw rolls the end back.
   *
   * @param id the job
   * @param end the final status, the error code (null for none), the time and the optional `settled` step
   * @returns false when the row is not `running`
   */
  finish(
    id: string,
    end: {
      status: 'succeeded' | 'failed' | 'cancelled';
      errorCode: JobErrorCode | null;
      now: string;
      settled?: () => void;
    },
  ): Promise<boolean>;
  /**
   * running → retry_wait with run_after and the error.
   *
   * @param id the job
   * @param retry the error code, when the retry is due and the time
   * @returns false when the row is not `running`
   */
  scheduleRetry(id: string, retry: { errorCode: JobErrorCode; runAfter: string; now: string }): Promise<boolean>;
  /**
   * Sets file_id and result of a running job; `fileId` null clears it (a `filtered` download keeps no file).
   *
   * @param id the job
   * @param outcome the file, the result and the time
   * @returns false when the row is not `running` or the file does not exist
   */
  setOutcome(id: string, outcome: { fileId: string | null; result: JobResult | null; now: string }): Promise<boolean>;
  /**
   * queued | retry_wait jobs of these types in this lane (`null` is the jobs without one) whose run_after is null or
   * earlier than `until`: status retry_wait, run_after = until; attempt and error untouched.
   *
   * @param hold the job types, the lane, the end of the hold and the time
   * @returns how many jobs were held
   */
  holdLane(hold: { types: readonly string[]; lane: string | null; until: string; now: string }): Promise<number>;
  /**
   * running → queued, attempt − 1 (not below 0), started_at cleared.
   *
   * @param id the job
   * @param now the time
   * @returns false when the row is not `running`
   */
  release(id: string, now: string): Promise<boolean>;
  /**
   * queued | retry_wait | waiting_remote → cancelled, for one job or for all. `settled` runs inside the transaction
   * with each cancelled job; a throw rolls every cancel back.
   *
   * @param cancel the job (absent: all), the time and the optional `settled` step
   * @returns how many jobs were cancelled
   */
  cancelPending(cancel: { id?: string; now: string; settled?: (job: Job) => void }): Promise<number>;
  /**
   * One transaction over the jobs of one file: when one of them is `running` and of a type in `refuseRunning`,
   * changes nothing and answers `refused: true`; otherwise every queued, retry_wait or waiting_remote job of the
   * file becomes cancelled like `cancelPending` (with `settled` per job, a throw rolls every cancel back).
   *
   * @param cancel the file, the job types whose running job refuses the cancel, the time and the optional `settled`
   *   step
   * @returns whether the cancel was refused and how many jobs were cancelled
   */
  cancelPendingOfFile(cancel: {
    fileId: string;
    refuseRunning: readonly string[];
    now: string;
    settled?: (job: Job) => void;
  }): Promise<{ refused: boolean; cancelled: number }>;
  /**
   * failed | cancelled → queued with attempt 0, error, run_after, started_at and finished_at cleared; for one job or
   * for all, newest created_at first, skipping a job whose dedupe key is held by an active job and a job of one of
   * `excludeTypes`. Clears `result`, and for `FILE_DOWNLOAD_JOB` jobs `file_id`.
   *
   * @param retry the job (absent: all), the time and the job types never retried
   * @returns how many jobs were queued again
   */
  retry(retry: { id?: string; now: string; excludeTypes?: readonly string[] }): Promise<number>;
  /**
   * Deletes every succeeded, failed or cancelled job.
   *
   * @returns how many jobs were deleted
   */
  clearFinished(): Promise<number>;
  /**
   * The size of the queue per status.
   *
   * @returns the number of jobs in every status
   */
  counts(): Promise<Record<JobStatus, number>>;
  /**
   * Newest created_at first, then id descending; with `lane` only the jobs of that lane (null: the jobs without one). `fileName` is the file's
   * original name, `providerId` the lane, `providerName` and `model` come from `analysisJobFields` of the payload,
   * `url` and `host` from `downloadJobFields`, `result` from the stored column. A `FILE_DOWNLOAD_JOB` answers
   * `providerId`, `providerName` and `model` null. `ids` narrows the list to those jobs within the other filters.
   *
   * @param filter the page, and the status, lane and ids to narrow it to
   * @returns the page and the total
   */
  list(filter: {
    limit: number;
    offset: number;
    status?: JobStatus;
    lane?: string | null;
    ids?: readonly string[];
  }): Promise<{ items: JobView[]; total: number }>;
  /**
   * Jobs of this type in `queued` or `retry_wait`, counted per lane; lanes without such a job are left out.
   *
   * @param type the job type
   * @returns the lane and its number of waiting jobs, per lane
   */
  waitingByLane(type: string): Promise<{ lane: string | null; waiting: number }[]>;
  /**
   * The payload of the newest job (created_at, then id) of this type and lane in any status.
   *
   * @param type the job type
   * @param lane the lane; `null` is the jobs without one
   * @returns the raw payload; null when there is none
   */
  latestPayloadOfLane(type: string, lane: string | null): Promise<unknown | null>;
  /**
   * Jobs of this type and lane in `queued`, `retry_wait`, `running` or `waiting_remote`.
   *
   * @param type the job type
   * @param lane the lane
   * @returns how many there are
   */
  countActiveInLane(type: string, lane: string): Promise<number>;
  /**
   * One transaction. Every job of this type and `fromLane` in `queued` or `retry_wait` gets `toLane`, the payload
   * `rewrite` answers, status `queued`, attempt 0, and run_after and the error cleared.
   *
   * @param reroute the job type, the source lane (`null` is the jobs without one), the target lane, the payload
   *   rewrite and the time
   * @returns how many jobs moved
   */
  rerouteWaiting(reroute: {
    type: string;
    fromLane: string | null;
    toLane: string;
    rewrite: (payload: unknown) => unknown;
    now: string;
  }): Promise<number>;
  /**
   * One transaction. Every active job of this type without a lane gets `lane` and the payload `rewrite` answers;
   * a row for which `rewrite` answers null is left as it is. Status and attempt stay.
   *
   * @param assignment the job type, the lane, the payload rewrite and the time
   * @returns how many jobs changed
   */
  assignLane(assignment: {
    type: string;
    lane: string;
    rewrite: (payload: unknown) => unknown | null;
    now: string;
  }): Promise<number>;
  /**
   * The active or latest job of this type for the file: the newest active job (created_at, then id)
   * when there is one, otherwise the newest job whatever its status.
   *
   * @param fileId the file
   * @param type the job type
   * @returns the job; null when there is none
   */
  latestForFile(fileId: string, type: string): Promise<Job | null>;
  /**
   * Every job of the file in `queued`, `retry_wait`, `running` or `waiting_remote`.
   *
   * @param fileId the file
   * @returns the active jobs
   */
  activeForFile(fileId: string): Promise<Job[]>;
}
