import { check, index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { asset } from './assets.js';
import { file } from './files.js';
import { TAG_ORIGINS, oneOf } from './vocabulary.js';

export const tag = sqliteTable('tag', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  displayName: text('display_name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const assetTag = sqliteTable(
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
  (t) => [
    primaryKey({ columns: [t.assetId, t.tagId, t.origin] }),
    index('asset_tag_tag_id_idx').on(t.tagId),
    check('asset_tag_origin_check', oneOf(t.origin, TAG_ORIGINS)),
  ],
);

export const fileTag = sqliteTable(
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
  (t) => [
    primaryKey({ columns: [t.fileId, t.tagId, t.origin] }),
    index('file_tag_tag_id_idx').on(t.tagId),
    check('file_tag_origin_check', oneOf(t.origin, TAG_ORIGINS)),
  ],
);
