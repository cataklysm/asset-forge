import { check, index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { asset } from './assets.js';
import { file } from './files.js';
import { TAG_ORIGINS, oneOf } from './vocabulary.js';

// The tags and their links to assets and files; prompt tags live with the prompts.

/** A tag: the normalised `name` is unique, `display_name` is how it is shown. */
export const tag =sqliteTable('tag', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  displayName: text('display_name').notNull(),
  createdAt: text('created_at').notNull(),
});

/** A tag an asset carries itself, with its origin (`manual` or `ai`). */
export const assetTag =sqliteTable(
  'asset_tag',
  {
    assetId: text('asset_id')
      .notNull()
      .references(() => asset.id),
    tagId: text('tag_id')
      .notNull()
      .references(() => tag.id),
    origin: text('origin', { enum: TAG_ORIGINS }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.assetId, table.tagId, table.origin] }),
    index('asset_tag_tag_id_idx').on(table.tagId),
    check('asset_tag_origin_check', oneOf(table.origin, TAG_ORIGINS)),
  ],
);

/** A tag a file carries, with its origin (`manual` or `ai`). */
export const fileTag =sqliteTable(
  'file_tag',
  {
    fileId: text('file_id')
      .notNull()
      .references(() => file.id),
    tagId: text('tag_id')
      .notNull()
      .references(() => tag.id),
    origin: text('origin', { enum: TAG_ORIGINS }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.fileId, table.tagId, table.origin] }),
    index('file_tag_tag_id_idx').on(table.tagId),
    check('file_tag_origin_check', oneOf(table.origin, TAG_ORIGINS)),
  ],
);
