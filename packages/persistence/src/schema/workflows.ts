import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { asset } from './assets.js';
import { STEP_STATES, oneOf } from './vocabulary.js';

// Workflows. Template, version and step definition rows are immutable once written.

/** A workflow template, identified by its stable key. */
export const workflowTemplate = sqliteTable('workflow_template', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  builtIn: integer('built_in', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
});

/** A numbered version of a template; workflows run on a version, never on the template. */
export const workflowTemplateVersion = sqliteTable(
  'workflow_template_version',
  {
    id: text('id').primaryKey(),
    templateId: text('template_id')
      .notNull()
      .references(() => workflowTemplate.id),
    version: integer('version').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('workflow_template_version_template_id_version_unique').on(table.templateId, table.version)],
);

/** A step of a template version, at a position and with a key unique within the version. */
export const workflowStepDefinition = sqliteTable(
  'workflow_step_definition',
  {
    id: text('id').primaryKey(),
    templateVersionId: text('template_version_id')
      .notNull()
      .references(() => workflowTemplateVersion.id),
    position: integer('position').notNull(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    mandatory: integer('mandatory', { mode: 'boolean' }).notNull(),
  },
  (table) => [
    uniqueIndex('workflow_step_definition_version_position_unique').on(table.templateVersionId, table.position),
    uniqueIndex('workflow_step_definition_version_key_unique').on(table.templateVersionId, table.key),
  ],
);

/** The workflow of an asset (at most one) on one template version. */
export const assetWorkflow = sqliteTable('asset_workflow', {
  id: text('id').primaryKey(),
  assetId: text('asset_id')
    .notNull()
    .unique()
    .references(() => asset.id),
  templateVersionId: text('template_version_id')
    .notNull()
    .references(() => workflowTemplateVersion.id),
  createdAt: text('created_at').notNull(),
});

/** The state and notes of one step of an asset's workflow; `completed_at` is set exactly while the step is done. */
export const assetWorkflowStep = sqliteTable(
  'asset_workflow_step',
  {
    id: text('id').primaryKey(),
    assetWorkflowId: text('asset_workflow_id')
      .notNull()
      .references(() => assetWorkflow.id, { onDelete: 'cascade' }),
    stepDefinitionId: text('step_definition_id')
      .notNull()
      .references(() => workflowStepDefinition.id),
    state: text('state', { enum: STEP_STATES }).notNull().default('not_started'),
    notes: text('notes').notNull().default(''),
    updatedAt: text('updated_at').notNull(),
    completedAt: text('completed_at'),
  },
  (table) => [
    uniqueIndex('asset_workflow_step_workflow_definition_unique').on(table.assetWorkflowId, table.stepDefinitionId),
    check('asset_workflow_step_state_check', oneOf(table.state, STEP_STATES)),
    check('asset_workflow_step_completed_check', sql`(${table.state} = 'done') = (${table.completedAt} is not null)`),
  ],
);
