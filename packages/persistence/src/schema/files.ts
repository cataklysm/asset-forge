import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { asset } from './assets.js';
import { FILE_MOVE_KINDS, FILE_ROLES, IMPORT_STATUSES, oneOf } from './vocabulary.js';
import { storage } from './workspace.js';

// The files: the file rows, the URLs they were downloaded from, the journal of their moves and the tombstones of
// purged ones.

/** A file of the workspace with its storage and relative path; in an asset with a role, in the inbox, or trashed. */
export const file = sqliteTable(
  'file',
  {
    id: text('id').primaryKey(),
    storageId: text('storage_id')
      .notNull()
      .references(() => storage.id),
    assetId: text('asset_id').references(() => asset.id),
    role: text('role', { enum: FILE_ROLES }),
    originalName: text('original_name').notNull(),
    relativePath: text('relative_path').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes'),
    sha256: text('sha256'),
    kind: text('kind').notNull().default('other'),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    status: text('status', { enum: IMPORT_STATUSES }).notNull(),
    error: text('error'),
    importedAt: text('imported_at').notNull(),
    // The trash (migration 0008). `deleted_at is not null` implies `asset_id` and `role` are null; the
    // repositories enforce it, not a CHECK, so that 0008 only adds columns and does not rebuild `file`.
    deletedAt: text('deleted_at'),
    trashedAssetId: text('trashed_asset_id').references(() => asset.id, { onDelete: 'set null' }),
    trashedRole: text('trashed_role', { enum: FILE_ROLES }),
  },
  (table) => [
    uniqueIndex('file_storage_id_relative_path_unique').on(table.storageId, table.relativePath),
    index('file_deleted_at_idx').on(table.deletedAt),
    index('file_sha256_idx').on(table.sha256),
    index('file_status_idx').on(table.status),
    index('file_imported_at_idx').on(table.importedAt),
    index('file_asset_id_role_idx').on(table.assetId, table.role),
    index('file_asset_id_kind_idx').on(table.assetId, table.kind),
    // The complete files of one asset (search reindex); without it `file_status_idx` wins and reads every complete file.
    index('file_asset_id_status_idx').on(table.assetId, table.status),
    // The inbox and the Files tab in their order, newest import first (migration 0017), without a temporary B-tree.
    index('file_asset_id_imported_at_id_idx').on(table.assetId, table.importedAt, table.id),
    check('file_status_check', oneOf(table.status, IMPORT_STATUSES)),
    check('file_role_check', oneOf(table.role, FILE_ROLES)),
    check('file_asset_role_check', sql`(${table.assetId} is null) = (${table.role} is null)`),
  ],
);

/** Web addresses a file was downloaded from (URL import); at most MAX_FILE_ORIGINS per file, gone with the file. */
export const fileOrigin = sqliteTable(
  'file_origin',
  {
    id: text('id').primaryKey(),
    fileId: text('file_id')
      .notNull()
      .references(() => file.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('file_origin_file_id_url_unique').on(table.fileId, table.url),
    index('file_origin_url_idx').on(table.url),
  ],
);

/** The journal of a file move in progress: at most one per file, resolved on open when it was left behind. */
export const fileMove = sqliteTable(
  'file_move',
  {
    fileId: text('file_id')
      .primaryKey()
      .references(() => file.id),
    targetRelativePath: text('target_relative_path').notNull(),
    targetAssetId: text('target_asset_id').references(() => asset.id),
    targetRole: text('target_role', { enum: FILE_ROLES }),
    createdAt: text('created_at').notNull(),
    kind: text('kind', { enum: FILE_MOVE_KINDS }).notNull().default('relocate'),
  },
  (table) => [
    check('file_move_target_role_check', oneOf(table.targetRole, FILE_ROLES)),
    check('file_move_target_check', sql`(${table.targetAssetId} is null) = (${table.targetRole} is null)`),
  ],
);

/**
 * Tombstone of a purged trashed file whose trash binary may still be on disk. No foreign key: it
 * outlives the file row and is deleted once the binary is gone.
 */
export const filePurge = sqliteTable('file_purge', {
  fileId: text('file_id').primaryKey(),
  purgedAt: text('purged_at').notNull(),
});
