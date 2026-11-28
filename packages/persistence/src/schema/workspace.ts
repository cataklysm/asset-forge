import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { STORAGE_KINDS, oneOf } from './vocabulary.js';

export const workspace = sqliteTable('workspace', {
  id: text('id').primaryKey(),
  formatVersion: integer('format_version').notNull(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
  derivedDataVersion: integer('derived_data_version'),
});

export const storage = sqliteTable(
  'storage',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: STORAGE_KINDS }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [check('storage_kind_check', oneOf(t.kind, STORAGE_KINDS))],
);
