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

// The job rows as the repositories read them: the mapping to the core type and the conditions several statements
// share.

/** A row of the `job` table as Drizzle reads it. */
export type JobRow = typeof job.$inferSelect;

/** A handle that can read: the database or a transaction on it. */
export type JobReader = Pick<BetterSQLite3Database, 'select'>;

/**
 * The stored code; a value outside the vocabulary (the column has no CHECK) reads as `internal_error`.
 *
 * @param value the `error_code` column
 * @returns the code; null when the column is null
 */
export const errorCodeOf = (value: string | null): JobErrorCode | null =>
  value === null ? null : JobErrorCodeSchema.catch('internal_error').parse(value);

/**
 * A job row as the core type.
 *
 * @param row the row
 * @returns the job with its payload parsed; throws when the payload is not JSON
 */
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

/**
 * The stored result; a value outside the vocabulary (the column has no CHECK) reads as null.
 *
 * @param value the `result` column
 * @returns the result; null for none or an unreadable one
 */
export const resultOf = (value: string | null): JobResult | null => JobResultSchema.nullable().catch(null).parse(value);

/**
 * The two error columns for a code: the code and its fixed message.
 *
 * @param code the code; null clears both columns
 * @returns the values of `error_code` and `error_message`
 */
export const errorOf = (code: JobErrorCode | null) => ({
  errorCode: code,
  errorMessage: code === null ? null : JOB_ERROR_MESSAGES[code],
});

/** The jobs in an active status. */
export const isActive = inArray(job.status, [...ACTIVE_JOB_STATUSES]);
/** The jobs waiting for a claim: queued, or waiting for their retry. */
export const isWaiting = inArray(job.status, ['queued', 'retry_wait']);

/**
 * The jobs of this lane; `null` is the jobs without one.
 *
 * @param lane the lane
 * @returns the condition
 */
export const inLane = (lane: string | null): SQL => (lane === null ? isNull(job.providerId) : eq(job.providerId, lane));

/**
 * The jobs whose lane is not excluded. SQL's `NOT IN` never matches null, so the null lane is handled on its
 * own: excluded through `IS NOT NULL`, kept through `IS NULL` beside the string values.
 *
 * @param excludeLanes the lanes to leave out; `null` stands for the jobs without a lane
 * @returns the condition; undefined when nothing is excluded
 */
export function notInLanes(excludeLanes: readonly (string | null)[] | undefined): SQL | undefined {
  if (excludeLanes === undefined || excludeLanes.length === 0) return undefined;
  const values = excludeLanes.filter((lane): lane is string => lane !== null);
  const otherValue = values.length === 0 ? undefined : notInArray(job.providerId, values);
  if (excludeLanes.includes(null)) return and(isNotNull(job.providerId), otherValue);
  return or(isNull(job.providerId), otherValue);
}

/**
 * Whether an active job holds the key.
 *
 * @param reader the database or the caller's transaction
 * @param dedupeKey the key
 * @returns true when an active job holds it
 */
export function keyHeld(reader: JobReader, dedupeKey: string): boolean {
  const holder = reader
    .select({ id: job.id })
    .from(job)
    .where(and(eq(job.dedupeKey, dedupeKey), isActive))
    .limit(1)
    .get();
  return holder !== undefined;
}

/**
 * Whether the file exists and is not in the trash.
 *
 * @param reader the database or the caller's transaction
 * @param fileId the file
 * @returns true for a file outside the trash
 */
export function liveFile(reader: JobReader, fileId: string): boolean {
  return (
    reader
      .select({ id: file.id })
      .from(file)
      .where(and(eq(file.id, fileId), isNull(file.deletedAt)))
      .get() !== undefined
  );
}

/** A job without a file, or one whose file is not in the trash. */
export const notOfTrashedFile = sql`not exists (select 1 from ${file} where ${file.id} = ${job.fileId} and ${file.deletedAt} is not null)`;
