import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { JOB_STATUSES, oneOf } from './vocabulary.js';

/**
 * Captured discovery requests and review results. The id is the associated job id, without a foreign key:
 * clearing finished job history must not remove results that have not been reviewed yet.
 */
export const siteCrawl = sqliteTable(
  'site_crawl',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id').notNull(),
    profile: text('profile').notNull(),
    galleryUrl: text('gallery_url').notNull(),
    target: text('target'),
    targetAssetName: text('target_asset_name'),
    progress: text('progress').notNull(),
    checkpoint: text('checkpoint'),
    result: text('result'),
    importedAt: text('imported_at'),
    completedAt: text('completed_at'),
    cancelled: integer('cancelled').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('site_crawl_created_at_idx').on(table.createdAt, table.id),
    index('site_crawl_profile_id_idx').on(table.profileId),
    check('site_crawl_profile_json_check', sql`json_valid(${table.profile})`),
    check('site_crawl_progress_json_check', sql`json_valid(${table.progress})`),
    check('site_crawl_target_json_check', sql`${table.target} IS NULL OR json_valid(${table.target})`),
    check('site_crawl_checkpoint_json_check', sql`${table.checkpoint} IS NULL OR json_valid(${table.checkpoint})`),
    check('site_crawl_result_json_check', sql`${table.result} IS NULL OR json_valid(${table.result})`),
    check('site_crawl_cancelled_check', sql`${table.cancelled} IN (0, 1)`),
  ],
);

/** Per-extraction download lineage; outcomes survive clearing job history and are mirrored by SQL triggers. */
export const siteCrawlDownload = sqliteTable(
  'site_crawl_download',
  {
    crawlId: text('crawl_id')
      .notNull()
      .references(() => siteCrawl.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    jobId: text('job_id'),
    status: text('status', { enum: JOB_STATUSES }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.crawlId, table.url] }),
    index('site_crawl_download_job_idx').on(table.jobId),
    index('site_crawl_download_status_idx').on(table.crawlId, table.status),
    check('site_crawl_download_status_check', oneOf(table.status, JOB_STATUSES)),
  ],
);
