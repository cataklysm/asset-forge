import {
  ACTIVE_JOB_STATUSES,
  FINISHED_JOB_STATUSES,
  JOB_ERROR_MESSAGES,
  JobErrorCodeSchema,
  JobStatusSchema,
  type JobErrorCode,
  type JobStatus,
  type JobView,
} from '@assetforge/contracts';
import type { Job, JobRepository } from '@assetforge/core';
import { and, asc, count, desc, eq, inArray, isNotNull, lte, min, or, sql, type SQL } from 'drizzle-orm';
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

/** True when an active job holds the key. */
function keyHeld(tx: Pick<BetterSQLite3Database, 'select'>, dedupeKey: string): boolean {
  return tx.select({ id: job.id }).from(job).where(and(eq(job.dedupeKey, dedupeKey), isActive)).limit(1).get() !== undefined;
}

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
    async enqueue({ jobs, now }): Promise<string[]> {
      return db.transaction((tx) => {
        const inserted: string[] = [];
        for (const j of jobs) {
          if (j.dedupeKey !== null && keyHeld(tx, j.dedupeKey)) continue;
          tx.insert(job)
            .values({
              id: j.id,
              type: j.type,
              resourceClass: j.resourceClass,
              status: 'queued',
              fileId: j.fileId,
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
    async claimNext({ resourceClass, types, now }): Promise<Job | null> {
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
    async nextRunAfter(types): Promise<string | null> {
      if (types.length === 0) return null;
      const row = db
        .select({ at: min(job.runAfter) })
        .from(job)
        .where(and(eq(job.status, 'retry_wait'), inArray(job.type, [...types]), isNotNull(job.runAfter)))
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
          .where(and(one(id), inArray(job.status, ['failed', 'cancelled'])))
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
    async list({ limit, offset, status }): Promise<{ items: JobView[]; total: number }> {
      const where = status === undefined ? undefined : eq(job.status, status);
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
          }));
          return { items, total };
        },
        { behavior: 'deferred' },
      );
    },
  };
}
