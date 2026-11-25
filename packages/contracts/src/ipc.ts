import { z } from 'zod';
import { ErrorCodeSchema } from './errors';
import {
  FileKindSchema,
  FileListSchema,
  FileRecordSchema,
  FileScopeSchema,
  FileTargetSchema,
  ImportResultSchema,
} from './files';
import {
  ApprovalStatusSchema,
  AssetDetailSchema,
  AssetAssignmentSchema,
  AssetListSchema,
  AssetRelationSchema,
  AssetRelationViewSchema,
  AssetSchema,
  AssetStatusSchema,
  AssetTypeSchema,
  AssignmentPrioritySchema,
  DescriptionInputSchema,
  FileRoleSchema,
  IntendedUseInputSchema,
  NameInputSchema,
  NotesInputSchema,
  PageRequestSchema,
  ProjectAssignmentSchema,
  ProjectListSchema,
  ProjectMemberListSchema,
  ProjectSchema,
  ProjectStatusSchema,
  RelationKindSchema,
  SetCoverRequestSchema,
} from './library';
import {
  AssetWorkflowSchema,
  StepNotesInputSchema,
  WorkflowStepStateSchema,
  WorkflowTemplateSchema,
} from './workflows';
import { WorkspaceSummarySchema } from './workspace';

export const IpcErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
});
export type IpcError = z.infer<typeof IpcErrorSchema>;

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

const EmptyRequestSchema = z.object({});
const IdSchema = z.uuid();
const IdRequestSchema = z.object({ id: IdSchema });
const AssignmentKeySchema = z.object({ projectId: IdSchema, assetId: IdSchema });
const RelationKeySchema = z.object({
  fromAssetId: IdSchema,
  toAssetId: IdSchema,
  kind: RelationKindSchema,
});

export const ipcContract = {
  'workspace:list': {
    request: EmptyRequestSchema,
    response: z.array(WorkspaceSummarySchema),
  },
  'workspace:current': {
    request: EmptyRequestSchema,
    response: WorkspaceSummarySchema.nullable(),
  },
  'workspace:create': {
    request: z.object({ name: z.string().min(1).max(200), rootPath: z.string() }),
    response: WorkspaceSummarySchema,
  },
  /** Resolves the directory a new workspace with this name would get inside `parentPath`. */
  'workspace:resolveCreatePath': {
    request: z.object({ name: z.string().min(1).max(200), parentPath: z.string().min(1) }),
    response: z.string(),
  },
  'workspace:open': {
    request: z.object({ rootPath: z.string() }),
    response: WorkspaceSummarySchema,
  },
  /**
   * Removes a workspace from the application after the user confirmed it in a native
   * dialog owned by the host. `removed` is false when the user cancelled.
   */
  'workspace:remove': {
    request: z.object({ id: z.uuid() }),
    response: z.object({ removed: z.boolean(), folderTrashed: z.boolean() }),
  },
  'workspace:close': {
    request: EmptyRequestSchema,
    response: z.null(),
  },
  'files:import': {
    request: z.object({
      sourcePaths: z.array(z.string()).min(1).max(1000),
      target: FileTargetSchema.optional(),
    }),
    response: z.array(ImportResultSchema),
  },
  'files:list': {
    request: PageRequestSchema.extend({ scope: FileScopeSchema }),
    response: FileListSchema,
  },
  'files:assign': {
    request: z.object({ fileId: IdSchema, assetId: IdSchema, role: FileRoleSchema }),
    response: FileRecordSchema,
  },
  'files:unassign': {
    request: z.object({ fileId: IdSchema }),
    response: FileRecordSchema,
  },
  'assetTypes:list': {
    request: EmptyRequestSchema,
    response: z.array(AssetTypeSchema),
  },
  'projects:list': {
    request: PageRequestSchema,
    response: ProjectListSchema,
  },
  'projects:get': {
    request: IdRequestSchema,
    response: ProjectSchema,
  },
  'projects:create': {
    request: z.object({ name: NameInputSchema, description: DescriptionInputSchema.optional() }),
    response: ProjectSchema,
  },
  'projects:update': {
    request: z.object({
      id: IdSchema,
      patch: z
        .object({
          name: NameInputSchema.optional(),
          description: DescriptionInputSchema.optional(),
          status: ProjectStatusSchema.optional(),
        })
        .strict(),
    }),
    response: ProjectSchema,
  },
  'assets:list': {
    request: PageRequestSchema.extend({
      typeId: IdSchema.optional(),
      status: AssetStatusSchema.optional(),
      projectId: IdSchema.optional(),
      query: z.string().max(200).optional(),
      tagNames: z.array(z.string().max(200)).max(10).optional(),
      fileRole: FileRoleSchema.optional(),
      fileKind: FileKindSchema.optional(),
    }),
    response: AssetListSchema,
  },
  'assets:get': {
    request: IdRequestSchema,
    response: AssetDetailSchema,
  },
  'assets:create': {
    request: z.object({
      name: NameInputSchema,
      typeId: IdSchema,
      description: DescriptionInputSchema.optional(),
    }),
    response: AssetSchema,
  },
  'assets:update': {
    request: z.object({
      id: IdSchema,
      patch: z
        .object({
          name: NameInputSchema.optional(),
          description: DescriptionInputSchema.optional(),
          typeId: IdSchema.optional(),
          status: AssetStatusSchema.optional(),
        })
        .strict(),
    }),
    response: AssetDetailSchema,
  },
  'assets:setCover': {
    request: SetCoverRequestSchema,
    response: AssetDetailSchema,
  },
  'files:openExternal': {
    request: z.object({ fileId: IdSchema }),
    response: z.null(),
  },
  'files:showInFolder': {
    request: z.object({ fileId: IdSchema }),
    response: z.null(),
  },
  'assignments:listByAsset': {
    request: z.object({ assetId: IdSchema }),
    response: z.array(AssetAssignmentSchema),
  },
  'assignments:listByProject': {
    request: PageRequestSchema.extend({ projectId: IdSchema }),
    response: ProjectMemberListSchema,
  },
  'assignments:assign': {
    request: AssignmentKeySchema,
    response: ProjectAssignmentSchema,
  },
  'assignments:update': {
    request: AssignmentKeySchema.extend({
      patch: z
        .object({
          priority: AssignmentPrioritySchema.optional(),
          intendedUse: IntendedUseInputSchema.optional(),
          approvalStatus: ApprovalStatusSchema.optional(),
          notes: NotesInputSchema.optional(),
        })
        .strict(),
    }),
    response: ProjectAssignmentSchema,
  },
  'assignments:remove': {
    request: AssignmentKeySchema,
    response: z.null(),
  },
  'relations:list': {
    request: z.object({ assetId: IdSchema }),
    response: z.array(AssetRelationViewSchema),
  },
  'relations:add': {
    request: RelationKeySchema,
    response: AssetRelationSchema,
  },
  'relations:remove': {
    request: RelationKeySchema,
    response: z.null(),
  },
  'workflowTemplates:list': {
    request: EmptyRequestSchema,
    response: z.array(WorkflowTemplateSchema),
  },
  'workflows:get': {
    request: z.object({ assetId: IdSchema }),
    response: AssetWorkflowSchema.nullable(),
  },
  'workflows:start': {
    request: z.object({ assetId: IdSchema, templateId: IdSchema.optional() }),
    response: AssetWorkflowSchema,
  },
  'workflows:updateStep': {
    request: z.object({
      stepId: IdSchema,
      patch: z
        .object({
          state: WorkflowStepStateSchema.optional(),
          notes: StepNotesInputSchema.optional(),
        })
        .strict(),
    }),
    response: AssetWorkflowSchema,
  },
  /** Removes the workflow of an asset after a native confirmation; `removed` is false when declined. */
  'workflows:remove': {
    request: z.object({ assetId: IdSchema }),
    response: z.object({ removed: z.boolean() }),
  },
  'dialog:pickDirectory': {
    request: EmptyRequestSchema,
    response: z.string().nullable(),
  },
  'dialog:pickFiles': {
    request: EmptyRequestSchema,
    response: z.array(z.string()),
  },
} as const satisfies Record<string, { request: z.ZodType; response: z.ZodType }>;

export type IpcChannel = keyof typeof ipcContract;
export type IpcRequest<C extends IpcChannel> = z.infer<(typeof ipcContract)[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.infer<(typeof ipcContract)[C]['response']>;
