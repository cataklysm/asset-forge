import { FILE_DOWNLOAD_JOB, FINISHED_JOB_STATUSES, JobStatusSchema, type JobStatus } from '@assetforge/contracts';
import type { Job, JobRepository, NewJob } from '@assetforge/core';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  min,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core';
import { listJobs } from './job-list.js';
import {
  errorOf,
  inLane,
  isActive,
  isWaiting,
  keyHeld,
  liveFile,
  notInLanes,
  notOfTrashedFile,
  toJob,
} from './job-rows.js';
import { file, job } from './schema.js';

/** A handle that can read and insert: the database or a transaction on it. */
type JobWriter = Pick<BetterSQLite3Database, 'select' | 'insert'>;

/** The statuses a job waits in before it runs; only these are cancelled as pending. */
const PENDING_STATUSES = ['queued', 'retry_wait', 'waiting_remote'] as const;

/**
 * Inserts the job as `queued`, attempt 0, unless its file is unknown or in the trash or its dedupe key is held.
 * Runs on the caller's transaction.
 *
 * @param transaction the caller's transaction (or the database)
 * @param newJob the job
 * @param now the creation time
 * @returns true when it was inserted
 */
export function insertJob(transaction: JobWriter, newJob: NewJob, now: string): boolean {
  // A job for a file that is unknown or in the trash is skipped like a held key.
  if (newJob.fileId !== null && !liveFile(transaction, newJob.fileId)) return false;
  if (newJob.dedupeKey !== null && keyHeld(transaction, newJob.dedupeKey)) return false;
  transaction
    .insert(job)
    .values({
      id: newJob.id,
      type: newJob.type,
      resourceClass: newJob.resourceClass,
      status: 'queued',
      fileId: newJob.fileId,
      // A caller that leaves the lane out stores null.
      providerId: newJob.lane ?? null,
      payload: JSON.stringify(newJob.payload),
      dedupeKey: newJob.dedupeKey,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return true;
}

/**
 * The job repository on the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createJobRepository(database: BetterSQLite3Database): JobRepository {
  return {
    latestForFile: (fileId, type) => latestForFile(database, fileId, type),
    activeForFile: (fileId) => activeForFile(database, fileId),
    enqueue: (input) => enqueue(database, input),
    get: (id) => getJob(database, id),
    listByStatus: (status) => listByStatus(database, status),
    claimNext: (input) => claimNext(database, input),
    nextRunAfter: (types, excludeLanes) => nextRunAfter(database, types, excludeLanes),
    finish: (id, input) => finish(database, id, input),
    scheduleRetry: (id, input) => scheduleRetry(database, id, input),
    setOutcome: (id, input) => setOutcome(database, id, input),
    holdLane: (input) => holdLane(database, input),
    release: (id, now) => release(database, id, now),
    cancelPending: (input) => cancelPending(database, input),
    cancelPendingOfFile: (input) => cancelPendingOfFile(database, input),
    retry: (input) => retry(database, input),
    clearFinished: () => clearFinished(database),
    counts: () => counts(database),
    list: (filter) => listJobs(database, filter),
    waitingByLane: (type) => waitingByLane(database, type),
    latestPayloadOfLane: (type, lane) => latestPayloadOfLane(database, type, lane),
    countActiveInLane: (type, lane) => countActiveInLane(database, type, lane),
    rerouteWaiting: (input) => rerouteWaiting(database, input),
    assignLane: (input) => assignLane(database, input),
  };
}

/**
 * Applies `set` to the job if it is `running`.
 *
 * @param database the workspace database; inside a transaction it is the same connection
 * @param id the job
 * @param set the columns to write
 * @returns true when a row changed
 */
function fromRunning(database: BetterSQLite3Database, id: string, set: SQLiteUpdateSetSource<typeof job>): boolean {
  return (
    database
      .update(job)
      .set(set)
      .where(and(eq(job.id, id), eq(job.status, 'running')))
      .run().changes > 0
  );
}

/**
 * The condition for one job, or none.
 *
 * @param id the job; undefined for every job
 * @returns the condition; undefined without an id
 */
function oneJob(id: string | undefined): SQL | undefined {
  return id === undefined ? undefined : eq(job.id, id);
}

/**
 * The newest job of a type for a file, an active one before any other.
 *
 * @param database the workspace database
 * @param fileId the file
 * @param type the job type
 * @returns the job; null when the file has none of that type
 */
async function latestForFile(database: BetterSQLite3Database, fileId: string, type: string): Promise<Job | null> {
  // Both statements walk job_file_id_type_created_at_idx backwards; the active one first.
  const newest = (...extra: SQL[]) =>
    database
      .select()
      .from(job)
      .where(and(eq(job.fileId, fileId), eq(job.type, type), ...extra))
      .orderBy(desc(job.createdAt), desc(job.id))
      .limit(1)
      .get();
  const row = newest(isActive) ?? newest();
  return row ? toJob(row) : null;
}

/**
 * The active jobs of a file, oldest first.
 *
 * @param database the workspace database
 * @param fileId the file
 * @returns the jobs
 */
async function activeForFile(database: BetterSQLite3Database, fileId: string): Promise<Job[]> {
  return database
    .select()
    .from(job)
    .where(and(eq(job.fileId, fileId), isActive))
    .orderBy(asc(job.createdAt), asc(job.id))
    .all()
    .map(toJob);
}

/**
 * Inserts the jobs in one transaction, skipping those `insertJob` refuses.
 *
 * @param database the workspace database
 * @param input the jobs and the creation time
 * @returns the ids of the inserted jobs
 */
async function enqueue(
  database: BetterSQLite3Database,
  { jobs, now }: Parameters<JobRepository['enqueue']>[0],
): Promise<string[]> {
  return database.transaction((transaction) => {
    const inserted: string[] = [];
    for (const newJob of jobs) {
      if (insertJob(transaction, newJob, now)) inserted.push(newJob.id);
    }
    return inserted;
  });
}

/**
 * One job.
 *
 * @param database the workspace database
 * @param id the job
 * @returns the job; null when it does not exist
 */
async function getJob(database: BetterSQLite3Database, id: string): Promise<Job | null> {
  const row = database.select().from(job).where(eq(job.id, id)).get();
  return row ? toJob(row) : null;
}

/**
 * The jobs in one status, oldest first.
 *
 * @param database the workspace database
 * @param status the status
 * @returns the jobs
 */
async function listByStatus(database: BetterSQLite3Database, status: JobStatus): Promise<Job[]> {
  return database
    .select()
    .from(job)
    .where(eq(job.status, status))
    .orderBy(asc(job.createdAt), asc(job.id))
    .all()
    .map(toJob);
}

/**
 * Claims the oldest waiting job of a resource class that is due and outside the excluded lanes: marks it running and
 * counts the attempt, in one transaction.
 *
 * @param database the workspace database
 * @param input the resource class, the job types, the time and the lanes to leave out
 * @returns the claimed job; null when none is due
 */
async function claimNext(
  database: BetterSQLite3Database,
  { resourceClass, types, now, excludeLanes }: Parameters<JobRepository['claimNext']>[0],
): Promise<Job | null> {
  if (types.length === 0) return null;
  return database.transaction((transaction) => {
    const next = transaction
      .select({ id: job.id })
      .from(job)
      .where(
        and(
          eq(job.resourceClass, resourceClass),
          inArray(job.type, [...types]),
          or(eq(job.status, 'queued'), and(eq(job.status, 'retry_wait'), lte(job.runAfter, now))),
          notInLanes(excludeLanes),
        ),
      )
      .orderBy(asc(job.createdAt), asc(job.id))
      .limit(1)
      .get();
    if (!next) return null;
    const row = transaction
      .update(job)
      .set({
        status: 'running',
        attempt: sql`${job.attempt} + 1`,
        startedAt: now,
        runAfter: null,
        ...errorOf(null),
        updatedAt: now,
      })
      .where(eq(job.id, next.id))
      .returning()
      .get();
    return toJob(row);
  });
}

/**
 * The earliest retry time among the jobs of these types waiting for their retry outside the excluded lanes.
 *
 * @param database the workspace database
 * @param types the job types
 * @param excludeLanes the lanes to leave out
 * @returns the time; null when none waits for a retry
 */
async function nextRunAfter(
  database: BetterSQLite3Database,
  types: readonly string[],
  excludeLanes: readonly (string | null)[] | undefined,
): Promise<string | null> {
  if (types.length === 0) return null;
  const row = database
    .select({ at: min(job.runAfter) })
    .from(job)
    .where(
      and(
        eq(job.status, 'retry_wait'),
        inArray(job.type, [...types]),
        isNotNull(job.runAfter),
        notInLanes(excludeLanes),
      ),
    )
    .get();
  return row?.at ?? null;
}

/**
 * Ends a running job and calls `settled` in the same transaction.
 *
 * @param database the workspace database
 * @param id the job
 * @param input the final status, the error code, the time and the hook
 * @returns true when the job was running and has ended
 */
async function finish(
  database: BetterSQLite3Database,
  id: string,
  { status, errorCode, now, settled }: Parameters<JobRepository['finish']>[1],
): Promise<boolean> {
  // `settled` runs on the same connection inside this transaction; a throw rolls the end back.
  return database.transaction(() => {
    const changed = fromRunning(database, id, { status, ...errorOf(errorCode), finishedAt: now, updatedAt: now });
    if (changed) settled?.();
    return changed;
  });
}

/**
 * Puts a running job into `retry_wait` until the given time.
 *
 * @param database the workspace database
 * @param id the job
 * @param input the error code, the retry time and the time
 * @returns true when the job was running
 */
async function scheduleRetry(
  database: BetterSQLite3Database,
  id: string,
  { errorCode, runAfter, now }: Parameters<JobRepository['scheduleRetry']>[1],
): Promise<boolean> {
  return fromRunning(database, id, { status: 'retry_wait', ...errorOf(errorCode), runAfter, updatedAt: now });
}

/**
 * Stores the file and the result of a running job; refused when the file does not exist.
 *
 * @param database the workspace database
 * @param id the job
 * @param input the file, the result and the time
 * @returns true when the job was running and the file exists
 */
async function setOutcome(
  database: BetterSQLite3Database,
  id: string,
  { fileId, result, now }: Parameters<JobRepository['setOutcome']>[1],
): Promise<boolean> {
  return database.transaction((transaction) => {
    if (
      fileId !== null &&
      transaction.select({ id: file.id }).from(file).where(eq(file.id, fileId)).get() === undefined
    )
      return false;
    return fromRunning(database, id, { fileId, result, updatedAt: now });
  });
}

/**
 * Holds the waiting jobs of these types in one lane until the given time; a later hold already stored stays.
 *
 * @param database the workspace database
 * @param input the job types, the lane, the end of the hold and the time
 * @returns the number of jobs held
 */
async function holdLane(
  database: BetterSQLite3Database,
  { types, lane, until, now }: Parameters<JobRepository['holdLane']>[0],
): Promise<number> {
  if (types.length === 0) return 0;
  return database
    .update(job)
    .set({ status: 'retry_wait', runAfter: until, updatedAt: now })
    .where(
      and(inArray(job.type, [...types]), inLane(lane), isWaiting, or(isNull(job.runAfter), lt(job.runAfter, until))),
    )
    .run().changes;
}

/**
 * Puts a running job back into the queue without spending the attempt.
 *
 * @param database the workspace database
 * @param id the job
 * @param now the time
 * @returns true when the job was running
 */
async function release(database: BetterSQLite3Database, id: string, now: string): Promise<boolean> {
  return fromRunning(database, id, {
    status: 'queued',
    attempt: sql`max(${job.attempt} - 1, 0)`,
    startedAt: null,
    updatedAt: now,
  });
}

/**
 * Cancels one pending job, or every pending job, and calls `settled` with each in the same transaction.
 *
 * @param database the workspace database
 * @param input the job (undefined for all), the time and the hook
 * @returns the number of jobs cancelled
 */
async function cancelPending(
  database: BetterSQLite3Database,
  { id, now, settled }: Parameters<JobRepository['cancelPending']>[0],
): Promise<number> {
  // `settled` runs with each cancelled job inside this transaction; a throw rolls every cancel back.
  return database.transaction((transaction) => {
    const rows = transaction
      .update(job)
      .set({ status: 'cancelled', finishedAt: now, updatedAt: now })
      .where(and(oneJob(id), inArray(job.status, [...PENDING_STATUSES])))
      .returning()
      .all();
    if (settled) for (const row of rows) settled(toJob(row));
    return rows.length;
  });
}

/**
 * Cancels the pending jobs of a file, unless a running job of a refusing type exists, and calls `settled` with each.
 *
 * @param database the workspace database
 * @param input the file, the types whose running job refuses, the time and the hook
 * @returns whether it was refused and the number of jobs cancelled
 */
async function cancelPendingOfFile(
  database: BetterSQLite3Database,
  { fileId, refuseRunning, now, settled }: Parameters<JobRepository['cancelPendingOfFile']>[0],
): Promise<{ refused: boolean; cancelled: number }> {
  // Synchronous, so no claim can turn a pending job of the file into a running one between check and cancel.
  return database.transaction((transaction) => {
    if (refuseRunning.length > 0) {
      const running = transaction
        .select({ id: job.id })
        .from(job)
        .where(and(eq(job.fileId, fileId), eq(job.status, 'running'), inArray(job.type, [...refuseRunning])))
        .limit(1)
        .get();
      if (running) return { refused: true, cancelled: 0 };
    }
    const rows = transaction
      .update(job)
      .set({ status: 'cancelled', finishedAt: now, updatedAt: now })
      .where(and(eq(job.fileId, fileId), inArray(job.status, [...PENDING_STATUSES])))
      .returning()
      .all();
    if (settled) for (const row of rows) settled(toJob(row));
    return { refused: false, cancelled: rows.length };
  });
}

/**
 * Requeues one failed or cancelled job, or all of them, newest first; jobs of a trashed file, of an excluded type or
 * whose dedupe key is held stay.
 *
 * @param database the workspace database
 * @param input the job (undefined for all), the time and the types to leave out
 * @returns the number of jobs requeued
 */
async function retry(
  database: BetterSQLite3Database,
  { id, now, excludeTypes }: Parameters<JobRepository['retry']>[0],
): Promise<number> {
  return database.transaction((transaction) => {
    const candidates = transaction
      .select({ id: job.id, type: job.type, dedupeKey: job.dedupeKey })
      .from(job)
      .where(
        and(
          oneJob(id),
          inArray(job.status, ['failed', 'cancelled']),
          notOfTrashedFile,
          excludeTypes === undefined || excludeTypes.length === 0 ? undefined : notInArray(job.type, [...excludeTypes]),
        ),
      )
      .orderBy(desc(job.createdAt), desc(job.id))
      .all();
    let requeued = 0;
    for (const candidate of candidates) {
      // An earlier candidate of this loop holds the key once it is requeued.
      if (candidate.dedupeKey !== null && keyHeld(transaction, candidate.dedupeKey)) continue;
      transaction
        .update(job)
        .set({
          status: 'queued',
          attempt: 0,
          ...errorOf(null),
          runAfter: null,
          startedAt: null,
          finishedAt: null,
          result: null,
          // A download produces its file anew; an earlier run's file is no longer this job's.
          ...(candidate.type === FILE_DOWNLOAD_JOB ? { fileId: null } : {}),
          updatedAt: now,
        })
        .where(eq(job.id, candidate.id))
        .run();
      requeued++;
    }
    return requeued;
  });
}

/**
 * Deletes every finished job.
 *
 * @param database the workspace database
 * @returns the number of jobs deleted
 */
async function clearFinished(database: BetterSQLite3Database): Promise<number> {
  return database
    .delete(job)
    .where(inArray(job.status, [...FINISHED_JOB_STATUSES]))
    .run().changes;
}

/**
 * The number of jobs per status, zero for a status without jobs.
 *
 * @param database the workspace database
 * @returns the counts
 */
async function counts(database: BetterSQLite3Database): Promise<Record<JobStatus, number>> {
  const result = Object.fromEntries(JobStatusSchema.options.map((status) => [status, 0])) as Record<JobStatus, number>;
  const rows = database.select({ status: job.status, n: count() }).from(job).groupBy(job.status).all();
  for (const { status, n } of rows) result[status] = n;
  return result;
}

/**
 * The number of waiting jobs of a type per lane.
 *
 * @param database the workspace database
 * @param type the job type
 * @returns one entry per lane with waiting jobs
 */
async function waitingByLane(
  database: BetterSQLite3Database,
  type: string,
): Promise<{ lane: string | null; waiting: number }[]> {
  return database
    .select({ lane: job.providerId, waiting: count() })
    .from(job)
    .where(and(eq(job.type, type), isWaiting))
    .groupBy(job.providerId)
    .all();
}

/**
 * The payload of the newest job of a type in a lane.
 *
 * @param database the workspace database
 * @param type the job type
 * @param lane the lane; null for the jobs without one
 * @returns the parsed payload; null when the lane has no such job
 */
async function latestPayloadOfLane(
  database: BetterSQLite3Database,
  type: string,
  lane: string | null,
): Promise<unknown | null> {
  const row = database
    .select({ payload: job.payload })
    .from(job)
    .where(and(eq(job.type, type), inLane(lane)))
    .orderBy(desc(job.createdAt), desc(job.id))
    .limit(1)
    .get();
  return row ? (JSON.parse(row.payload) as unknown) : null;
}

/**
 * The number of active jobs of a type in a lane.
 *
 * @param database the workspace database
 * @param type the job type
 * @param lane the lane
 * @returns the count
 */
async function countActiveInLane(database: BetterSQLite3Database, type: string, lane: string): Promise<number> {
  return (
    database
      .select({ n: count() })
      .from(job)
      .where(and(eq(job.type, type), eq(job.providerId, lane), isActive))
      .get()?.n ?? 0
  );
}

/**
 * Moves the waiting jobs of a type from one lane to another, rewriting each payload, as fresh queued jobs.
 *
 * @param database the workspace database
 * @param input the job type, both lanes, the payload rewrite and the time
 * @returns the number of jobs moved
 */
async function rerouteWaiting(
  database: BetterSQLite3Database,
  { type, fromLane, toLane, rewrite, now }: Parameters<JobRepository['rerouteWaiting']>[0],
): Promise<number> {
  // `rewrite` runs inside the transaction, so a throw rolls every row back.
  return database.transaction((transaction) => {
    const rows = transaction
      .select({ id: job.id, payload: job.payload })
      .from(job)
      .where(and(eq(job.type, type), inLane(fromLane), isWaiting))
      .orderBy(asc(job.createdAt), asc(job.id))
      .all();
    let moved = 0;
    for (const row of rows) {
      const payload = JSON.stringify(rewrite(JSON.parse(row.payload) as unknown));
      moved += transaction
        .update(job)
        .set({
          providerId: toLane,
          payload,
          status: 'queued',
          attempt: 0,
          runAfter: null,
          ...errorOf(null),
          updatedAt: now,
        })
        .where(and(eq(job.id, row.id), isWaiting))
        .run().changes;
    }
    return moved;
  });
}

/**
 * Gives the active jobs of a type without a lane this lane, rewriting each payload; a job whose rewrite answers null
 * stays without one.
 *
 * @param database the workspace database
 * @param input the job type, the lane, the payload rewrite and the time
 * @returns the number of jobs assigned
 */
async function assignLane(
  database: BetterSQLite3Database,
  { type, lane, rewrite, now }: Parameters<JobRepository['assignLane']>[0],
): Promise<number> {
  return database.transaction((transaction) => {
    const rows = transaction
      .select({ id: job.id, payload: job.payload })
      .from(job)
      .where(and(eq(job.type, type), isNull(job.providerId), isActive))
      .orderBy(asc(job.createdAt), asc(job.id))
      .all();
    let changed = 0;
    for (const row of rows) {
      const payload = rewrite(JSON.parse(row.payload) as unknown);
      if (payload === null) continue;
      changed += transaction
        .update(job)
        .set({ providerId: lane, payload: JSON.stringify(payload), updatedAt: now })
        .where(and(eq(job.id, row.id), isNull(job.providerId), isActive))
        .run().changes;
    }
    return changed;
  });
}
