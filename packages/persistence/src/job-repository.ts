import {
  ACTIVE_JOB_STATUSES,
  FINISHED_JOB_STATUSES,
  JOB_ERROR_MESSAGES,
  JobErrorCodeSchema,
  JobStatusSchema,
  analysisJobFields,
  type JobErrorCode,
  type JobStatus,
  type JobView,
} from '@assetforge/contracts';
import type { Job, JobRepository } from '@assetforge/core';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lte, min, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core';
import { file, job } from './schema.js';

type JobRow = typeof job.$inferSelect;

/** The stored code; a value outside the vocabulary (the column has no CHECK) reads as `internal_error`. */
const errorCodeOf = (value: string | null): JobErrorCode | null =>
  value === null ? null : JobErrorCodeSchema.catch('internal_error').parse(value);

const toJob = (row: JobRow): Job => ({
  id: row.id,
  type: row.type,
  resourceClass: row.resourceClass,
  status: row.status,
  fileId: row.fileId,
  lane: row.providerId,
  payload: JSON.parse(row.payload) as unknown,
  dedupeKey: row.dedupeKey,
  attempt: row.attempt,
  runAfter: row.runAfter,
  errorCode: errorCodeOf(row.errorCode),
  errorMessage: row.errorMessage,
  createdAt: row.createdAt,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  updatedAt: row.updatedAt,
});

const errorOf = (code: JobErrorCode | null) => ({ errorCode: code, errorMessage: code === null ? null : JOB_ERROR_MESSAGES[code] });

const isActive = inArray(job.status, [...ACTIVE_JOB_STATUSES]);
const isWaiting = inArray(job.status, ['queued', 'retry_wait']);

/** The jobs of this lane; `null` is the jobs without one. */
const inLane = (lane: string | null): SQL => (lane === null ? isNull(job.providerId) : eq(job.providerId, lane));

/**
 * The jobs whose lane is not excluded. SQL's `NOT IN` never matches null, so the null lane is handled on its
 * own: excluded through `IS NOT NULL`, kept through `IS NULL` beside the string values.
 */
function notInLanes(excludeLanes: readonly (string | null)[] | undefined): SQL | undefined {
  if (excludeLanes === undefined || excludeLanes.length === 0) return undefined;
  const values = excludeLanes.filter((l): l is string => l !== null);
  const otherValue = values.length === 0 ? undefined : notInArray(job.providerId, values);
  return excludeLanes.includes(null) ? and(isNotNull(job.providerId), otherValue) : or(isNull(job.providerId), otherValue);
}

/** True when an active job holds the key. */
function keyHeld(tx: Pick<BetterSQLite3Database, 'select'>, dedupeKey: string): boolean {
  return tx.select({ id: job.id }).from(job).where(and(eq(job.dedupeKey, dedupeKey), isActive)).limit(1).get() !== undefined;
}

/** True when the file exists and is not in the trash. */
function liveFile(tx: Pick<BetterSQLite3Database, 'select'>, fileId: string): boolean {
  return (
    tx
      .select({ id: file.id })
      .from(file)
      .where(and(eq(file.id, fileId), isNull(file.deletedAt)))
      .get() !== undefined
  );
}

/** A job without a file, or one whose file is not in the trash. */
const notOfTrashedFile = sql`not exists (select 1 from ${file} where ${file.id} = ${job.fileId} and ${file.deletedAt} is not null)`;

export function createJobRepository(db: BetterSQLite3Database): JobRepository {
  /** Applies `set` to the job if it is `running`; true when a row changed. */
  const fromRunning = (id: string, set: SQLiteUpdateSetSource<typeof job>): boolean =>
    db
      .update(job)
      .set(set)
      .where(and(eq(job.id, id), eq(job.status, 'running')))
      .run().changes > 0;

  const one = (id: string | undefined): SQL | undefined => (id === undefined ? undefined : eq(job.id, id));

  return {
    async latestForFile(fileId, type): Promise<Job | null> {
      // Both statements walk job_file_id_type_created_at_idx backwards; the active one first.
      const newest = (...extra: SQL[]) =>
        db
          .select()
          .from(job)
          .where(and(eq(job.fileId, fileId), eq(job.type, type), ...extra))
          .orderBy(desc(job.createdAt), desc(job.id))
          .limit(1)
          .get();
      const row = newest(isActive) ?? newest();
      return row ? toJob(row) : null;
    },
    async activeForFile(fileId): Promise<Job[]> {
      return db
        .select()
        .from(job)
        .where(and(eq(job.fileId, fileId), isActive))
        .orderBy(asc(job.createdAt), asc(job.id))
        .all()
        .map(toJob);
    },
    async enqueue({ jobs, now }): Promise<string[]> {
      return db.transaction((tx) => {
        const inserted: string[] = [];
        for (const j of jobs) {
          // A job for a file that is unknown or in the trash is skipped like a held key.
          if (j.fileId !== null && !liveFile(tx, j.fileId)) continue;
          if (j.dedupeKey !== null && keyHeld(tx, j.dedupeKey)) continue;
          tx.insert(job)
            .values({
              id: j.id,
              type: j.type,
              resourceClass: j.resourceClass,
              status: 'queued',
              fileId: j.fileId,
              // A caller that leaves the lane out stores null.
              providerId: j.lane ?? null,
              payload: JSON.stringify(j.payload),
              dedupeKey: j.dedupeKey,
              attempt: 0,
              createdAt: now,
              updatedAt: now,
            })
            .run();
          inserted.push(j.id);
        }
        return inserted;
      });
    },
    async get(id): Promise<Job | null> {
      const row = db.select().from(job).where(eq(job.id, id)).get();
      return row ? toJob(row) : null;
    },
    async listByStatus(status): Promise<Job[]> {
      return db.select().from(job).where(eq(job.status, status)).orderBy(asc(job.createdAt), asc(job.id)).all().map(toJob);
    },
    async claimNext({ resourceClass, types, now, excludeLanes }): Promise<Job | null> {
      if (types.length === 0) return null;
      return db.transaction((tx) => {
        const next = tx
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
        const row = tx
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
    },
    async nextRunAfter(types, excludeLanes): Promise<string | null> {
      if (types.length === 0) return null;
      const row = db
        .select({ at: min(job.runAfter) })
        .from(job)
        .where(and(eq(job.status, 'retry_wait'), inArray(job.type, [...types]), isNotNull(job.runAfter), notInLanes(excludeLanes)))
        .get();
      return row?.at ?? null;
    },
    async finish(id, { status, errorCode, now }): Promise<boolean> {
      return fromRunning(id, { status, ...errorOf(errorCode), finishedAt: now, updatedAt: now });
    },
    async scheduleRetry(id, { errorCode, runAfter, now }): Promise<boolean> {
      return fromRunning(id, { status: 'retry_wait', ...errorOf(errorCode), runAfter, updatedAt: now });
    },
    async release(id, now): Promise<boolean> {
      return fromRunning(id, {
        status: 'queued',
        attempt: sql`max(${job.attempt} - 1, 0)`,
        startedAt: null,
        updatedAt: now,
      });
    },
    async cancelPending({ id, now }): Promise<number> {
      return db
        .update(job)
        .set({ status: 'cancelled', finishedAt: now, updatedAt: now })
        .where(and(one(id), inArray(job.status, ['queued', 'retry_wait', 'waiting_remote'])))
        .run().changes;
    },
    async retry({ id, now }): Promise<number> {
      return db.transaction((tx) => {
        const candidates = tx
          .select({ id: job.id, dedupeKey: job.dedupeKey })
          .from(job)
          .where(and(one(id), inArray(job.status, ['failed', 'cancelled']), notOfTrashedFile))
          .orderBy(desc(job.createdAt), desc(job.id))
          .all();
        let requeued = 0;
        for (const c of candidates) {
          // An earlier candidate of this loop holds the key once it is requeued.
          if (c.dedupeKey !== null && keyHeld(tx, c.dedupeKey)) continue;
          tx.update(job)
            .set({ status: 'queued', attempt: 0, ...errorOf(null), runAfter: null, startedAt: null, finishedAt: null, updatedAt: now })
            .where(eq(job.id, c.id))
            .run();
          requeued++;
        }
        return requeued;
      });
    },
    async clearFinished(): Promise<number> {
      return db
        .delete(job)
        .where(inArray(job.status, [...FINISHED_JOB_STATUSES]))
        .run().changes;
    },
    async counts(): Promise<Record<JobStatus, number>> {
      const result = Object.fromEntries(JobStatusSchema.options.map((s) => [s, 0])) as Record<JobStatus, number>;
      const rows = db.select({ status: job.status, n: count() }).from(job).groupBy(job.status).all();
      for (const { status, n } of rows) result[status] = n;
      return result;
    },
    async list({ limit, offset, status, lane }): Promise<{ items: JobView[]; total: number }> {
      const where = and(status === undefined ? undefined : eq(job.status, status), lane === undefined ? undefined : eq(job.providerId, lane));
      return db.transaction(
        (tx) => {
          const rows = tx
            .select({ job, fileName: file.originalName })
            .from(job)
            .leftJoin(file, eq(file.id, job.fileId))
            .where(where)
            .orderBy(desc(job.createdAt), desc(job.id))
            .limit(limit)
            .offset(offset)
            .all();
          const total = tx.select({ n: count() }).from(job).where(where).get()?.n ?? 0;
          const items = rows.map(({ job: row, fileName }): JobView => ({
            ...analysisJobFields(JSON.parse(row.payload) as unknown),
            id: row.id,
            type: row.type,
            status: row.status,
            attempt: row.attempt,
            fileId: row.fileId,
            fileName,
            errorCode: errorCodeOf(row.errorCode),
            errorMessage: row.errorMessage,
            createdAt: row.createdAt,
            startedAt: row.startedAt,
            finishedAt: row.finishedAt,
            runAfter: row.runAfter,
            providerId: row.providerId,
          }));
          return { items, total };
        },
        { behavior: 'deferred' },
      );
    },
    async waitingByLane(type): Promise<{ lane: string | null; waiting: number }[]> {
      return db
        .select({ lane: job.providerId, waiting: count() })
        .from(job)
        .where(and(eq(job.type, type), isWaiting))
        .groupBy(job.providerId)
        .all();
    },
    async latestPayloadOfLane(type, lane): Promise<unknown | null> {
      const row = db
        .select({ payload: job.payload })
        .from(job)
        .where(and(eq(job.type, type), inLane(lane)))
        .orderBy(desc(job.createdAt), desc(job.id))
        .limit(1)
        .get();
      return row ? (JSON.parse(row.payload) as unknown) : null;
    },
    async countActiveInLane(type, lane): Promise<number> {
      return (
        db
          .select({ n: count() })
          .from(job)
          .where(and(eq(job.type, type), eq(job.providerId, lane), isActive))
          .get()?.n ?? 0
      );
    },
    async rerouteWaiting({ type, fromLane, toLane, rewrite, now }): Promise<number> {
      // `rewrite` runs inside the transaction, so a throw rolls every row back.
      return db.transaction((tx) => {
        const rows = tx
          .select({ id: job.id, payload: job.payload })
          .from(job)
          .where(and(eq(job.type, type), inLane(fromLane), isWaiting))
          .orderBy(asc(job.createdAt), asc(job.id))
          .all();
        let moved = 0;
        for (const r of rows) {
          const payload = JSON.stringify(rewrite(JSON.parse(r.payload) as unknown));
          moved += tx
            .update(job)
            .set({ providerId: toLane, payload, status: 'queued', attempt: 0, runAfter: null, ...errorOf(null), updatedAt: now })
            .where(and(eq(job.id, r.id), isWaiting))
            .run().changes;
        }
        return moved;
      });
    },
    async assignLane({ type, lane, rewrite, now }): Promise<number> {
      return db.transaction((tx) => {
        const rows = tx
          .select({ id: job.id, payload: job.payload })
          .from(job)
          .where(and(eq(job.type, type), isNull(job.providerId), isActive))
          .orderBy(asc(job.createdAt), asc(job.id))
          .all();
        let changed = 0;
        for (const r of rows) {
          const payload = rewrite(JSON.parse(r.payload) as unknown);
          if (payload === null) continue;
          changed += tx
            .update(job)
            .set({ providerId: lane, payload: JSON.stringify(payload), updatedAt: now })
            .where(and(eq(job.id, r.id), isNull(job.providerId), isActive))
            .run().changes;
        }
        return changed;
      });
    },
  };
}
