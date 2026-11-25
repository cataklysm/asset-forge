import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const workspace = sqliteTable('workspace', {
  id: text('id').primaryKey(),
  formatVersion: integer('format_version').notNull(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const file = sqliteTable(
  'file',
  {
    id: text('id').primaryKey(),
    assetId: text('asset_id'),
    originalName: text('original_name').notNull(),
    relativePath: text('relative_path').notNull().unique(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes'),
    sha256: text('sha256'),
    status: text('status', { enum: ['pending', 'complete', 'failed'] }).notNull(),
    error: text('error'),
    importedAt: text('imported_at').notNull(),
  },
  (t) => [
    index('file_sha256_idx').on(t.sha256),
    index('file_status_idx').on(t.status),
    index('file_imported_at_idx').on(t.importedAt),
    index('file_asset_id_idx').on(t.assetId),
    check('file_status_check', sql`${t.status} in ('pending', 'complete', 'failed')`),
  ],
);
