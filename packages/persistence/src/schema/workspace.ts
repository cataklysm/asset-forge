import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { STORAGE_KINDS, oneOf } from './vocabulary.js';

// The workspace itself: its one meta row and the storages its files live on.

/** The one row describing the workspace: identity, format and the version of its derived data. */
export const workspace = sqliteTable('workspace', {
  id: text('id').primaryKey(),
  formatVersion: integer('format_version').notNull(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
  derivedDataVersion: integer('derived_data_version'),
  // Nullable in SQL so the migration can add it; every row gets one (migration 0021, else drawn by `init`).
  lineageId: text('lineage_id'),
});

/** A storage the files of the workspace live on; every file row names one. */
export const storage = sqliteTable(
  'storage',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: STORAGE_KINDS }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [check('storage_kind_check', oneOf(table.kind, STORAGE_KINDS))],
);
