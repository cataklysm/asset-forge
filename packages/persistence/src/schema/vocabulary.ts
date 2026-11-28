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

/** `<column> in ('a', 'b', ...)` for a closed vocabulary; the values are fixed literals from `contracts`. */
export const oneOf = (column: AnySQLiteColumn, values: readonly string[]) =>
  sql`${column} in ${sql.raw(`(${values.map((v) => `'${v}'`).join(', ')})`)}`;

/** A vocabulary from `contracts` as the non-empty tuple Drizzle's `enum` option expects. */
export const vocabulary = <T extends string>(schema: { options: readonly T[] }) => schema.options as [T, ...T[]];

export const STORAGE_KINDS = ['workspace_root'] as const;
export const ASSET_STATUSES = vocabulary(AssetStatusSchema);
export const PROJECT_STATUSES = vocabulary(ProjectStatusSchema);
export const PRIORITIES = vocabulary(AssignmentPrioritySchema);
export const APPROVAL_STATUSES = vocabulary(ApprovalStatusSchema);
export const RELATION_KINDS = vocabulary(RelationKindSchema);
export const FILE_ROLES = vocabulary(FileRoleSchema);
export const IMPORT_STATUSES = vocabulary(ImportStatusSchema);
export const STEP_STATES = vocabulary(WorkflowStepStateSchema);
export const TAG_ORIGINS = ['manual', 'ai'] as const;
export const FILE_MOVE_KINDS = ['relocate', 'trash', 'restore'] as const;
export const JOB_STATUSES = vocabulary(JobStatusSchema);
export const RESOURCE_CLASSES = vocabulary(ResourceClassSchema);
export const GENERATION_KINDS = vocabulary(GenerationKindSchema);
export const GENERATION_STATUSES = vocabulary(GenerationStatusSchema);
export const PROVIDER_KINDS = vocabulary(ProviderKindSchema);
