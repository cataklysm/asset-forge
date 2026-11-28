import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

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
