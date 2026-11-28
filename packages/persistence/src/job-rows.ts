import {
  ACTIVE_JOB_STATUSES,
  JOB_ERROR_MESSAGES,
  JobErrorCodeSchema,
  JobResultSchema,
  type JobErrorCode,
  type JobResult,
} from '@assetforge/contracts';
import type { Job } from '@assetforge/core';
import { and, eq, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { file, job } from './schema.js';

export type JobRow = typeof job.$inferSelect;

/** The stored code; a value outside the vocabulary (the column has no CHECK) reads as `internal_error`. */
export const errorCodeOf = (value: string | null): JobErrorCode | null =>
  value === null ? null : JobErrorCodeSchema.catch('internal_error').parse(value);

export const toJob = (row: JobRow): Job => ({
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

/** The stored result; a value outside the vocabulary (the column has no CHECK) reads as null. */
export const resultOf = (value: string | null): JobResult | null => JobResultSchema.nullable().catch(null).parse(value);

export const errorOf = (code: JobErrorCode | null) => ({ errorCode: code, errorMessage: code === null ? null : JOB_ERROR_MESSAGES[code] });

export const isActive = inArray(job.status, [...ACTIVE_JOB_STATUSES]);
export const isWaiting = inArray(job.status, ['queued', 'retry_wait']);

/** The jobs of this lane; `null` is the jobs without one. */
export const inLane = (lane: string | null): SQL => (lane === null ? isNull(job.providerId) : eq(job.providerId, lane));

/**
 * The jobs whose lane is not excluded. SQL's `NOT IN` never matches null, so the null lane is handled on its
 * own: excluded through `IS NOT NULL`, kept through `IS NULL` beside the string values.
 */
export function notInLanes(excludeLanes: readonly (string | null)[] | undefined): SQL | undefined {
  if (excludeLanes === undefined || excludeLanes.length === 0) return undefined;
  const values = excludeLanes.filter((l): l is string => l !== null);
  const otherValue = values.length === 0 ? undefined : notInArray(job.providerId, values);
  return excludeLanes.includes(null) ? and(isNotNull(job.providerId), otherValue) : or(isNull(job.providerId), otherValue);
}

/** True when an active job holds the key. */
export function keyHeld(tx: Pick<BetterSQLite3Database, 'select'>, dedupeKey: string): boolean {
  return tx.select({ id: job.id }).from(job).where(and(eq(job.dedupeKey, dedupeKey), isActive)).limit(1).get() !== undefined;
}

/** True when the file exists and is not in the trash. */
export function liveFile(tx: Pick<BetterSQLite3Database, 'select'>, fileId: string): boolean {
  return (
    tx
      .select({ id: file.id })
      .from(file)
      .where(and(eq(file.id, fileId), isNull(file.deletedAt)))
      .get() !== undefined
  );
}

/** A job without a file, or one whose file is not in the trash. */
export const notOfTrashedFile = sql`not exists (select 1 from ${file} where ${file.id} = ${job.fileId} and ${file.deletedAt} is not null)`;
