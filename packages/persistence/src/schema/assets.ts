import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { file } from './files.js';
import { ASSET_STATUSES, RELATION_KINDS, oneOf } from './vocabulary.js';
import { workflowTemplate } from './workflows.js';

// The assets: their types, the asset rows, their source URLs, their typed relations and their rows in the search
// index.

/** An asset type; the built-in ones are inserted on open, with an optional default workflow template. */
export const assetType = sqliteTable('asset_type', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull(),
  builtIn: integer('built_in', { mode: 'boolean' }).notNull(),
  defaultWorkflowTemplateId: text('default_workflow_template_id').references(() => workflowTemplate.id),
});

/** The central object; `cover_file_id` is the chosen cover, null for the automatic one. */
export const asset = sqliteTable(
  'asset',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    typeId: text('type_id')
      .notNull()
      .references(() => assetType.id),
    description: text('description').notNull().default(''),
    status: text('status', { enum: ASSET_STATUSES }).notNull(),
    coverFileId: text('cover_file_id').references((): AnySQLiteColumn => file.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('asset_type_id_idx').on(table.typeId),
    index('asset_status_idx').on(table.status),
    check('asset_status_check', oneOf(table.status, ASSET_STATUSES)),
  ],
);

/** Source URLs of an asset, stored as normalised `href`; the unique index also serves lookups by asset. */
export const assetSource = sqliteTable(
  'asset_source',
  {
    id: text('id').primaryKey(),
    assetId: text('asset_id')
      .notNull()
      .references(() => asset.id),
    url: text('url').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('asset_source_asset_id_url_unique').on(table.assetId, table.url)],
);

/** A typed relation from one asset to another; never from an asset to itself. */
export const assetRelation = sqliteTable(
  'asset_relation',
  {
    fromAssetId: text('from_asset_id')
      .notNull()
      .references(() => asset.id),
    toAssetId: text('to_asset_id')
      .notNull()
      .references(() => asset.id),
    kind: text('kind', { enum: RELATION_KINDS }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.fromAssetId, table.toAssetId, table.kind] }),
    index('asset_relation_to_asset_id_idx').on(table.toAssetId),
    check('asset_relation_kind_check', oneOf(table.kind, RELATION_KINDS)),
    check('asset_relation_not_self_check', sql`${table.fromAssetId} <> ${table.toAssetId}`),
  ],
);

/** Maps an asset to the integer rowid of its row in the hand-written FTS5 table `asset_search`. */
export const assetSearchMap = sqliteTable('asset_search_map', {
  rowid: integer('rowid').primaryKey(),
  assetId: text('asset_id')
    .notNull()
    .unique()
    .references(() => asset.id),
});
