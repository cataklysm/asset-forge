import {
  ApprovalStatusSchema,
  AssetStatusSchema,
  AssignmentPrioritySchema,
  FileRoleSchema,
  GenerationKindSchema,
  GenerationStatusSchema,
  ImportStatusSchema,
  JobStatusSchema,
  ProjectStatusSchema,
  ProviderKindSchema,
  ResourceClassSchema,
  RelationKindSchema,
  WorkflowStepStateSchema,
} from '@assetforge/contracts';
import { sql } from 'drizzle-orm';
import { type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

// The closed vocabularies of the schema's text columns and the helpers that turn them into CHECK constraints. Only
// the table family files import this module; `schema.ts` does not re-export it.

/**
 * `<column> in ('a', 'b', ...)` for a closed vocabulary; the values are fixed literals from `contracts`.
 *
 * @param column the column the constraint checks
 * @param values the allowed values
 * @returns the SQL condition of the CHECK constraint
 */
export const oneOf = (column: AnySQLiteColumn, values: readonly string[]) =>
  sql`${column} in ${sql.raw(`(${values.map((value) => `'${value}'`).join(', ')})`)}`;

/**
 * A vocabulary from `contracts` as the non-empty tuple Drizzle's `enum` option expects.
 *
 * @param schema the Zod enum of the vocabulary
 * @returns its options as a non-empty tuple
 */
export const vocabulary = <Value extends string>(schema: { options: readonly Value[] }) =>
  schema.options as [Value, ...Value[]];

/** The kinds of a storage row; a workspace has only its root so far. */
export const STORAGE_KINDS = ['workspace_root'] as const;
/** The values of `asset.status`. */
export const ASSET_STATUSES = vocabulary(AssetStatusSchema);
/** The values of `project.status`. */
export const PROJECT_STATUSES = vocabulary(ProjectStatusSchema);
/** The values of `project_asset.priority`. */
export const PRIORITIES = vocabulary(AssignmentPrioritySchema);
/** The values of `project_asset.approval_status`. */
export const APPROVAL_STATUSES = vocabulary(ApprovalStatusSchema);
/** The values of `asset_relation.kind`. */
export const RELATION_KINDS = vocabulary(RelationKindSchema);
/** The values of the file role columns. */
export const FILE_ROLES = vocabulary(FileRoleSchema);
/** The values of `file.status`. */
export const IMPORT_STATUSES = vocabulary(ImportStatusSchema);
/** The values of `asset_workflow_step.state`. */
export const STEP_STATES = vocabulary(WorkflowStepStateSchema);
/** The values of the `origin` column of the tag links. */
export const TAG_ORIGINS = ['manual', 'ai'] as const;
/** The values of `file_move.kind`. */
export const FILE_MOVE_KINDS = ['relocate', 'trash', 'restore'] as const;
/** The values of `job.status`. */
export const JOB_STATUSES = vocabulary(JobStatusSchema);
/** The values of `job.resource_class`. */
export const RESOURCE_CLASSES = vocabulary(ResourceClassSchema);
/** The values of `generation.kind`. */
export const GENERATION_KINDS = vocabulary(GenerationKindSchema);
/** The values of `generation.status`. */
export const GENERATION_STATUSES = vocabulary(GenerationStatusSchema);
/** The values of `generation.provider_kind`. */
export const PROVIDER_KINDS = vocabulary(ProviderKindSchema);
