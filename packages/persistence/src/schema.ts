import {
  ACTIVE_JOB_STATUSES,
  ApprovalStatusSchema,
  AssetStatusSchema,
  AssignmentPrioritySchema,
  FileRoleSchema,
  ImportStatusSchema,
  JobStatusSchema,
  ProjectStatusSchema,
  ResourceClassSchema,
  RelationKindSchema,
  WorkflowStepStateSchema,
} from '@assetforge/contracts';
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

/** `<column> in ('a', 'b', ...)` for a closed vocabulary; the values are fixed literals from `contracts`. */
const oneOf = (column: AnySQLiteColumn, values: readonly string[]) =>
  sql`${column} in ${sql.raw(`(${values.map((v) => `'${v}'`).join(', ')})`)}`;

/** A vocabulary from `contracts` as the non-empty tuple Drizzle's `enum` option expects. */
const vocabulary = <T extends string>(schema: { options: readonly T[] }) => schema.options as [T, ...T[]];

const STORAGE_KINDS = ['workspace_root'] as const;
const ASSET_STATUSES = vocabulary(AssetStatusSchema);
const PROJECT_STATUSES = vocabulary(ProjectStatusSchema);
const PRIORITIES = vocabulary(AssignmentPrioritySchema);
const APPROVAL_STATUSES = vocabulary(ApprovalStatusSchema);
const RELATION_KINDS = vocabulary(RelationKindSchema);
const FILE_ROLES = vocabulary(FileRoleSchema);
const IMPORT_STATUSES = vocabulary(ImportStatusSchema);
const STEP_STATES = vocabulary(WorkflowStepStateSchema);
const TAG_ORIGINS = ['manual', 'ai'] as const;
const FILE_MOVE_KINDS = ['relocate', 'trash', 'restore'] as const;
const JOB_STATUSES = vocabulary(JobStatusSchema);
const RESOURCE_CLASSES = vocabulary(ResourceClassSchema);

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

export const assetType = sqliteTable('asset_type', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull(),
  builtIn: integer('built_in', { mode: 'boolean' }).notNull(),
  defaultWorkflowTemplateId: text('default_workflow_template_id').references(() => workflowTemplate.id),
});

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
  (t) => [
    index('asset_type_id_idx').on(t.typeId),
    index('asset_status_idx').on(t.status),
    check('asset_status_check', oneOf(t.status, ASSET_STATUSES)),
  ],
);

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
  (t) => [check('project_status_check', oneOf(t.status, PROJECT_STATUSES))],
);

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
  (t) => [
    primaryKey({ columns: [t.projectId, t.assetId] }),
    index('project_asset_asset_id_idx').on(t.assetId),
    check('project_asset_priority_check', oneOf(t.priority, PRIORITIES)),
    check('project_asset_approval_status_check', oneOf(t.approvalStatus, APPROVAL_STATUSES)),
  ],
);

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
  (t) => [
    primaryKey({ columns: [t.fromAssetId, t.toAssetId, t.kind] }),
    index('asset_relation_to_asset_id_idx').on(t.toAssetId),
    check('asset_relation_kind_check', oneOf(t.kind, RELATION_KINDS)),
    check('asset_relation_not_self_check', sql`${t.fromAssetId} <> ${t.toAssetId}`),
  ],
);

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
    status: text('status', { enum: IMPORT_STATUSES }).notNull(),
    error: text('error'),
    importedAt: text('imported_at').notNull(),
    // The trash (migration 0008). `deleted_at is not null` implies `asset_id` and `role` are null; the
    // repositories enforce it, not a CHECK, so that 0008 only adds columns and does not rebuild `file`.
    deletedAt: text('deleted_at'),
    trashedAssetId: text('trashed_asset_id').references(() => asset.id, { onDelete: 'set null' }),
    trashedRole: text('trashed_role', { enum: FILE_ROLES }),
  },
  (t) => [
    uniqueIndex('file_storage_id_relative_path_unique').on(t.storageId, t.relativePath),
    index('file_deleted_at_idx').on(t.deletedAt),
    index('file_sha256_idx').on(t.sha256),
    index('file_status_idx').on(t.status),
    index('file_imported_at_idx').on(t.importedAt),
    index('file_asset_id_role_idx').on(t.assetId, t.role),
    index('file_asset_id_kind_idx').on(t.assetId, t.kind),
    // The complete files of one asset (search reindex); without it `file_status_idx` wins and reads every complete file.
    index('file_asset_id_status_idx').on(t.assetId, t.status),
    check('file_status_check', oneOf(t.status, IMPORT_STATUSES)),
    check('file_role_check', oneOf(t.role, FILE_ROLES)),
    check('file_asset_role_check', sql`(${t.assetId} is null) = (${t.role} is null)`),
  ],
);

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
  (t) => [
    check('file_move_target_role_check', oneOf(t.targetRole, FILE_ROLES)),
    check('file_move_target_check', sql`(${t.targetAssetId} is null) = (${t.targetRole} is null)`),
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

// Workflows. Template, version and step definition rows are immutable once written.

export const workflowTemplate = sqliteTable('workflow_template', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  builtIn: integer('built_in', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
});

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
  (t) => [uniqueIndex('workflow_template_version_template_id_version_unique').on(t.templateId, t.version)],
);

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
  (t) => [
    uniqueIndex('workflow_step_definition_version_position_unique').on(t.templateVersionId, t.position),
    uniqueIndex('workflow_step_definition_version_key_unique').on(t.templateVersionId, t.key),
  ],
);

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
  (t) => [
    uniqueIndex('asset_workflow_step_workflow_definition_unique').on(t.assetWorkflowId, t.stepDefinitionId),
    check('asset_workflow_step_state_check', oneOf(t.state, STEP_STATES)),
    check('asset_workflow_step_completed_check', sql`(${t.state} = 'done') = (${t.completedAt} is not null)`),
  ],
);

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

/** The persistent job queue. `payload` is JSON; `error_message` is the fixed message of `error_code`. */
export const job = sqliteTable(
  'job',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    resourceClass: text('resource_class', { enum: RESOURCE_CLASSES }).notNull(),
    status: text('status', { enum: JOB_STATUSES }).notNull(),
    fileId: text('file_id').references(() => file.id),
    payload: text('payload').notNull(),
    dedupeKey: text('dedupe_key'),
    attempt: integer('attempt').notNull().default(0),
    runAfter: text('run_after'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('job_claim_idx').on(t.status, t.resourceClass, t.createdAt, t.id),
    // At most one active job per dedupe key; finished jobs keep theirs.
    uniqueIndex('job_active_dedupe_idx')
      .on(t.dedupeKey)
      .where(oneOf(t.status, ACTIVE_JOB_STATUSES)),
    // The newest job of a type for one file (`latestForFile`).
    index('job_file_id_type_created_at_idx').on(t.fileId, t.type, t.createdAt, t.id),
    check('job_resource_class_check', oneOf(t.resourceClass, RESOURCE_CLASSES)),
    check('job_status_check', oneOf(t.status, JOB_STATUSES)),
  ],
);

/** Provenance of the latest analysis of a file; replaced by the next one. */
export const fileAnalysis = sqliteTable('file_analysis', {
  fileId: text('file_id')
    .primaryKey()
    .references(() => file.id),
  sha256: text('sha256').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  promptVersion: integer('prompt_version').notNull(),
  /** Name of the analysis prompt used, as it was then; null for rows from before analysis prompts. */
  promptName: text('prompt_name'),
  analysedAt: text('analysed_at').notNull(),
});

/** A tag proposal waiting for the owner; one per file, replaced by the next one. `tags` is a JSON array of `{ name, displayName }`. */
export const fileAnalysisProposal = sqliteTable('file_analysis_proposal', {
  fileId: text('file_id')
    .primaryKey()
    .references(() => file.id),
  sha256: text('sha256').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  promptVersion: integer('prompt_version').notNull(),
  tags: text('tags').notNull(),
  /** Name of the analysis prompt used, as it was then; null for rows from before analysis prompts. */
  promptName: text('prompt_name'),
  createdAt: text('created_at').notNull(),
});

/** Maps an asset to the integer rowid of its row in the hand-written FTS5 table `asset_search`. */
export const assetSearchMap = sqliteTable('asset_search_map', {
  rowid: integer('rowid').primaryKey(),
  assetId: text('asset_id')
    .notNull()
    .unique()
    .references(() => asset.id),
});
