import { check, index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { asset } from './assets.js';
import { APPROVAL_STATUSES, PRIORITIES, PROJECT_STATUSES, oneOf } from './vocabulary.js';

// The projects and their n:m assignments to assets.

/** A project. */
export const project = sqliteTable(
  'project',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    status: text('status', { enum: PROJECT_STATUSES }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [check('project_status_check', oneOf(table.status, PROJECT_STATUSES))],
);

/** The assignment of an asset to a project with its project-specific data; removing it never touches the asset. */
export const projectAsset = sqliteTable(
  'project_asset',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => project.id),
    assetId: text('asset_id')
      .notNull()
      .references(() => asset.id),
    priority: text('priority', { enum: PRIORITIES }).notNull().default('normal'),
    intendedUse: text('intended_use').notNull().default(''),
    approvalStatus: text('approval_status', { enum: APPROVAL_STATUSES }).notNull().default('pending'),
    notes: text('notes').notNull().default(''),
    assignedAt: text('assigned_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.assetId] }),
    index('project_asset_asset_id_idx').on(table.assetId),
    check('project_asset_priority_check', oneOf(table.priority, PRIORITIES)),
    check('project_asset_approval_status_check', oneOf(table.approvalStatus, APPROVAL_STATUSES)),
  ],
);
