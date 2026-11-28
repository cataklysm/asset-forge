import {
  ACTIVE_JOB_STATUSES,
  FileTargetSchema,
  SiteCrawlProgressSchema,
  SiteCrawlResultSchema,
  SiteProfileSchema,
  SITE_CRAWL_JOB,
} from '@assetforge/contracts';
import {
  InvalidOperationError,
  ValidationFailedError,
  type NewJob,
  type SiteCrawlRecord,
  type SiteCrawlRepository,
  type SiteCrawlSummaryRecord,
} from '@assetforge/core';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core';
import { insertJob } from './job-repository.js';
import { job, siteCrawl } from './schema.js';

/** A crawl stores URL metadata, never binary files; cap any one serialized snapshot at 32 MiB. */
const MAX_CRAWL_JSON_BYTES = 32 * 1024 * 1024;

/** Columns needed by periodic task-list reads; candidate and checkpoint JSON is deliberately excluded. */
const summaryColumns = {
  id: siteCrawl.id,
  profile: siteCrawl.profile,
  galleryUrl: siteCrawl.galleryUrl,
  target: siteCrawl.target,
  targetAssetName: siteCrawl.targetAssetName,
  progress: siteCrawl.progress,
  importedAt: siteCrawl.importedAt,
  completedAt: siteCrawl.completedAt,
  cancelled: siteCrawl.cancelled,
  createdAt: siteCrawl.createdAt,
  updatedAt: siteCrawl.updatedAt,
};

/** The lightweight SQL row shared by full and task-list reads. */
type HeaderRow = Pick<typeof siteCrawl.$inferSelect, keyof typeof summaryColumns>;

/**
 * Serializes bounded crawl metadata. A generic fixed message never reveals a URL, profile field or credential.
 *
 * @param value the validated metadata
 * @returns its JSON representation
 * @throws ValidationFailedError when it is not serializable or exceeds the metadata limit
 */
function json(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ValidationFailedError('The crawl metadata cannot be stored');
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_CRAWL_JSON_BYTES) {
    throw new ValidationFailedError('The crawl metadata exceeds the storage limit');
  }
  return serialized;
}

/**
 * Converts one database row back to a captured discovery request.
 *
 * @param row the stored snapshot
 * @returns validated metadata and the opaque checkpoint consumed by the crawler
 */
function readHeader(row: HeaderRow): Omit<SiteCrawlRecord, 'checkpoint' | 'result'> {
  return {
    id: row.id,
    profile: SiteProfileSchema.parse(JSON.parse(row.profile)),
    galleryUrl: row.galleryUrl,
    target: row.target === null ? null : FileTargetSchema.parse(JSON.parse(row.target)),
    targetAssetName: row.targetAssetName,
    progress: SiteCrawlProgressSchema.parse(JSON.parse(row.progress)),
    importedAt: row.importedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Decodes the complete recovery and review artifact, read only for the selected task.
 *
 * @param row the stored full snapshot
 * @returns the captured request and its full metadata
 */
function read(row: typeof siteCrawl.$inferSelect): SiteCrawlRecord {
  return {
    ...readHeader(row),
    checkpoint: row.checkpoint === null ? null : JSON.parse(row.checkpoint),
    result: row.result === null ? null : SiteCrawlResultSchema.parse(JSON.parse(row.result)),
  };
}

/**
 * The durable crawl snapshots of one workspace. Job status stays in the existing job repository.
 *
 * @param database the workspace connection
 * @returns the crawl repository
 */
export function createSiteCrawlRepository(database: BetterSQLite3Database): SiteCrawlRepository {
  return {
    insert: (record, queuedJob) => insertCrawl(database, record, queuedJob),
    get: (id) => getCrawl(database, id),
    remove: (id) => removeCrawl(database, id),
    list: (page) => listCrawls(database, page),
    listSummaries: (page) => listSummaries(database, page),
    update: (id, patch) => updateCrawl(database, id, patch),
    hasActiveProfile: (profileId) => hasActiveProfile(database, profileId),
  };
}

/**
 * Encodes the validated captured state, dropping fields outside the profile/target contracts.
 *
 * @param record the captured request
 * @returns the values stored in SQLite
 */
function storedCrawl(record: SiteCrawlRecord): typeof siteCrawl.$inferInsert {
  const profile = SiteProfileSchema.parse(record.profile);
  return {
    id: record.id,
    profileId: profile.id,
    profile: json(profile),
    galleryUrl: record.galleryUrl,
    target: record.target === null ? null : json(FileTargetSchema.parse(record.target)),
    targetAssetName: record.targetAssetName,
    progress: json(SiteCrawlProgressSchema.parse(record.progress)),
    checkpoint: record.checkpoint === null ? null : json(record.checkpoint),
    result: record.result === null ? null : json(SiteCrawlResultSchema.parse(record.result)),
    importedAt: record.importedAt,
    completedAt: record.completedAt ?? null,
    cancelled: Number(record.result?.cancelled ?? false),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Stores a captured request and, when supplied, its associated job in one transaction.
 *
 * @param database the workspace connection
 * @param record the captured request
 * @param queuedJob the optional discovery job
 * @returns resolves when the snapshot and optional job are stored
 * @throws InvalidOperationError when a supplied job cannot be queued; neither row is written
 * @throws ValidationFailedError when a supplied job does not identify this crawl
 */
async function insertCrawl(
  database: BetterSQLite3Database,
  record: SiteCrawlRecord,
  queuedJob?: NewJob,
): Promise<void> {
  if (queuedJob !== undefined && (queuedJob.id !== record.id || queuedJob.type !== SITE_CRAWL_JOB)) {
    throw new ValidationFailedError('The discovery job does not match the crawl');
  }
  const values = storedCrawl(record);
  database.transaction((transaction) => {
    transaction.insert(siteCrawl).values(values).run();
    if (queuedJob !== undefined && !insertJob(transaction, queuedJob, record.createdAt)) {
      throw new InvalidOperationError('The discovery job could not be queued');
    }
  });
}

/**
 * Reads a saved crawl independently of job-history retention.
 *
 * @param database the workspace connection
 * @param id the crawl
 * @returns its captured state, or null when unknown
 */
async function getCrawl(database: BetterSQLite3Database, id: string): ReturnType<SiteCrawlRepository['get']> {
  const row = database.select().from(siteCrawl).where(eq(siteCrawl.id, id)).get();
  return row === undefined ? null : read(row);
}

/**
 * Removes finished review metadata while retaining the job history and imported content.
 * The active-job check and deletion share one transaction so retries cannot race the check.
 * @param database the workspace connection
 * @param id the crawl
 * @returns whether the review entry existed
 * @throws InvalidOperationError while its discovery job is active
 */
async function removeCrawl(database: BetterSQLite3Database, id: string): Promise<boolean> {
  return database.transaction((transaction) => {
    const existing = transaction.select({ id: siteCrawl.id }).from(siteCrawl).where(eq(siteCrawl.id, id)).get();
    if (existing === undefined) return false;
    const active = transaction
      .select({ id: job.id })
      .from(job)
      .where(and(eq(job.id, id), eq(job.type, SITE_CRAWL_JOB), inArray(job.status, [...ACTIVE_JOB_STATUSES])))
      .get();
    if (active !== undefined) throw new InvalidOperationError('Cancel this extraction before removing it');
    return transaction.delete(siteCrawl).where(eq(siteCrawl.id, id)).run().changes > 0;
  });
}

/**
 * Reads a page and its count in one snapshot, newest first with a stable id tie-breaker.
 *
 * @param database the workspace connection
 * @param page the requested slice
 * @returns saved crawls and their total count
 */
async function listCrawls(
  database: BetterSQLite3Database,
  page: Parameters<SiteCrawlRepository['list']>[0],
): ReturnType<SiteCrawlRepository['list']> {
  return database.transaction(
    (transaction) => ({
      items: transaction
        .select()
        .from(siteCrawl)
        .orderBy(desc(siteCrawl.createdAt), desc(siteCrawl.id))
        .limit(page.limit)
        .offset(page.offset)
        .all()
        .map(read),
      total: transaction.select({ n: count() }).from(siteCrawl).get()?.n ?? 0,
    }),
    { behavior: 'deferred' },
  );
}

/**
 * Reads only task headers and the count in one snapshot, excluding large recovery/review payloads at SQL level.
 *
 * @param database the workspace connection
 * @param page the requested slice
 * @returns lightweight captured state and the total count
 */
async function listSummaries(
  database: BetterSQLite3Database,
  page: Parameters<SiteCrawlRepository['listSummaries']>[0],
): Promise<{ items: SiteCrawlSummaryRecord[]; total: number }> {
  return database.transaction(
    (transaction) => ({
      items: transaction
        .select(summaryColumns)
        .from(siteCrawl)
        .orderBy(desc(siteCrawl.createdAt), desc(siteCrawl.id))
        .limit(page.limit)
        .offset(page.offset)
        .all()
        .map((row) => ({ ...readHeader(row), cancelled: row.cancelled === 1 })),
      total: transaction.select({ n: count() }).from(siteCrawl).get()?.n ?? 0,
    }),
    { behavior: 'deferred' },
  );
}

/**
 * Changes only the mutable recovery/review fields of one crawl, in a single statement.
 *
 * @param database the workspace connection
 * @param id the crawl
 * @param patch the fields to change and the timestamp
 * @returns whether the crawl existed
 */
async function updateCrawl(
  database: BetterSQLite3Database,
  id: string,
  patch: Parameters<SiteCrawlRepository['update']>[1],
): Promise<boolean> {
  const changes: SQLiteUpdateSetSource<typeof siteCrawl> = { updatedAt: patch.now };
  if (patch.progress !== undefined) changes.progress = json(SiteCrawlProgressSchema.parse(patch.progress));
  if (patch.result !== undefined) {
    changes.result = patch.result === null ? null : json(SiteCrawlResultSchema.parse(patch.result));
    changes.cancelled = Number(patch.result?.cancelled ?? false);
  }
  if (patch.checkpoint !== undefined) changes.checkpoint = patch.checkpoint === null ? null : json(patch.checkpoint);
  if (patch.importedAt !== undefined) changes.importedAt = patch.importedAt;
  if (patch.completedAt !== undefined) changes.completedAt = patch.completedAt;
  return database.update(siteCrawl).set(changes).where(eq(siteCrawl.id, id)).run().changes > 0;
}

/**
 * Tests active profile dependencies without scanning all saved review results.
 *
 * @param database the workspace connection
 * @param profileId the profile
 * @returns whether a job still depends on it
 */
async function hasActiveProfile(database: BetterSQLite3Database, profileId: string): Promise<boolean> {
  return (
    database
      .select({ id: siteCrawl.id })
      .from(siteCrawl)
      .innerJoin(job, eq(job.id, siteCrawl.id))
      .where(and(eq(siteCrawl.profileId, profileId), inArray(job.status, [...ACTIVE_JOB_STATUSES])))
      .limit(1)
      .get() !== undefined
  );
}
