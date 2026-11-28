import { ACTIVE_JOB_STATUSES } from '@assetforge/contracts';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { file } from './files.js';
import { JOB_STATUSES, RESOURCE_CLASSES, oneOf } from './vocabulary.js';

// The job queue.

/** The persistent job queue. `payload` is JSON; `error_message` is the fixed message of `error_code`. */
export const job = sqliteTable(
  'job',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    resourceClass: text('resource_class', { enum: RESOURCE_CLASSES }).notNull(),
    status: text('status', { enum: JOB_STATUSES }).notNull(),
    fileId: text('file_id').references(() => file.id),
    /** The queue lane within the resource class; for analysis jobs the provider id. Null for jobs without one. */
    providerId: text('provider_id'),
    payload: text('payload').notNull(),
    dedupeKey: text('dedupe_key'),
    attempt: integer('attempt').notNull().default(0),
    runAfter: text('run_after'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    updatedAt: text('updated_at').notNull(),
    /** What a succeeded job produced besides its file (`JobResult`); null on an ordinary result. */
    result: text('result'),
  },
  (table) => [
    index('job_claim_idx').on(table.status, table.resourceClass, table.createdAt, table.id),
    // At most one active job per dedupe key; finished jobs keep theirs.
    uniqueIndex('job_active_dedupe_idx').on(table.dedupeKey).where(oneOf(table.status, ACTIVE_JOB_STATUSES)),
    // The newest job of a type for one file (`latestForFile`).
    index('job_file_id_type_created_at_idx').on(table.fileId, table.type, table.createdAt, table.id),
    // Waiting and active jobs per lane (`waitingByLane`, `countActiveInLane`, `rerouteWaiting`).
    index('job_provider_id_status_idx').on(table.providerId, table.status),
    check('job_resource_class_check', oneOf(table.resourceClass, RESOURCE_CLASSES)),
    check('job_status_check', oneOf(table.status, JOB_STATUSES)),
  ],
);
