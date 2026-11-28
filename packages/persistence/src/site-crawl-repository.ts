import {
  ACTIVE_JOB_STATUSES,
  FileTargetSchema,
  SiteCrawlProgressSchema,
  SiteCrawlResultSchema,
  SiteProfileSchema,
} from '@assetforge/contracts';
import { ValidationFailedError, type SiteCrawlRecord, type SiteCrawlRepository } from '@assetforge/core';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core';
import { job, siteCrawl } from './schema.js';

/** A crawl stores URL metadata, never binary files; cap any one serialized snapshot at 32 MiB. */
const MAX_CRAWL_JSON_BYTES = 32 * 1024 * 1024;

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
function read(row: typeof siteCrawl.$inferSelect): SiteCrawlRecord {
  return {
    id: row.id,
    profile: SiteProfileSchema.parse(JSON.parse(row.profile)),
    galleryUrl: row.galleryUrl,
    target: row.target === null ? null : FileTargetSchema.parse(JSON.parse(row.target)),
    targetAssetName: row.targetAssetName,
    progress: SiteCrawlProgressSchema.parse(JSON.parse(row.progress)),
    checkpoint: row.checkpoint === null ? null : JSON.parse(row.checkpoint),
    result: row.result === null ? null : SiteCrawlResultSchema.parse(JSON.parse(row.result)),
    importedAt: row.importedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
    insert: async (record) => {
      const profile = SiteProfileSchema.parse(record.profile);
      database
        .insert(siteCrawl)
        .values({
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
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })
        .run();
    },
    get: async (id) => {
      const row = database.select().from(siteCrawl).where(eq(siteCrawl.id, id)).get();
      return row === undefined ? null : read(row);
    },
    list: async ({ limit, offset }) =>
      database.transaction(
        (transaction) => ({
          items: transaction
            .select()
            .from(siteCrawl)
            .orderBy(desc(siteCrawl.createdAt), desc(siteCrawl.id))
            .limit(limit)
            .offset(offset)
            .all()
            .map(read),
          total: transaction.select({ n: count() }).from(siteCrawl).get()?.n ?? 0,
        }),
        { behavior: 'deferred' },
      ),
    update: async (id, patch) => {
      const changes: SQLiteUpdateSetSource<typeof siteCrawl> = { updatedAt: patch.now };
      if (patch.progress !== undefined) changes.progress = json(SiteCrawlProgressSchema.parse(patch.progress));
      if (patch.result !== undefined)
        changes.result = patch.result === null ? null : json(SiteCrawlResultSchema.parse(patch.result));
      if (patch.checkpoint !== undefined)
        changes.checkpoint = patch.checkpoint === null ? null : json(patch.checkpoint);
      if (patch.importedAt !== undefined) changes.importedAt = patch.importedAt;
      return database.update(siteCrawl).set(changes).where(eq(siteCrawl.id, id)).run().changes > 0;
    },
    hasActiveProfile: async (profileId) =>
      database
        .select({ id: siteCrawl.id })
        .from(siteCrawl)
        .innerJoin(job, eq(job.id, siteCrawl.id))
        .where(and(eq(siteCrawl.profileId, profileId), inArray(job.status, [...ACTIVE_JOB_STATUSES])))
        .limit(1)
        .get() !== undefined,
  };
}
