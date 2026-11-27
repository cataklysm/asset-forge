import { z } from 'zod';
import type { IpcError } from './errors';
import { TagRenameResultSchema, TagSuggestionSchema, TagUsageSchema } from './tags';
import {
  AssignManyResultSchema,
  EmptyTrashResultSchema,
  FileBatchResultSchema,
  FileIdsSchema,
  FileListSchema,
  FileRecordSchema,
  FileRecordsSchema,
  FileTargetSchema,
  ImportProgressSchema,
  ImportResultSchema,
  TrashSummarySchema,
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
  pageOf,
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
import { JobStatusSchema, JobSummarySchema, JobViewSchema, ModelNameSchema, WaitingByProviderSchema } from './jobs';
import { ProviderIdSchema } from './provider-ref';
import {
  AnalysisModeSchema,
  AnalysisPreviewSchema,
  AnalysisTargetSchema,
  AssetListFilterSchema,
  DescribeResultSchema,
  EnqueueAnalysisResultSchema,
  FileListFilterSchema,
  ProposalViewSchema,
} from './analysis';
import {
  ListImageModelsResultSchema,
  ListModelsResultSchema,
  ProviderListSchema,
  ProviderViewSchema,
  SaveProviderSchema,
} from './settings';
import {
  GenerationSchema,
  MAX_FILE_GENERATIONS,
  MAX_RECENT_PROMPTS,
  StartGenerationResultSchema,
  StartGenerationSchema,
} from './generations';
import { AnalysisPromptListSchema, AnalysisPromptSchema, SaveAnalysisPromptSchema } from './analysis-prompts';
import {
  CreatePromptSchema,
  ListPromptsSchema,
  PromptDetailSchema,
  PromptPageSchema,
  SavePromptVersionSchema,
  UpdatePromptSchema,
} from './prompts';
import { FileOriginSchema, IMPORT_URL_STRING_MAX, MAX_IMPORT_URLS, UrlImportResultSchema } from './url-import';

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
      /** Unpack every `.zip` source into its entries instead of importing it as a file. */
      unpackArchives: z.boolean().optional(),
    }),
    response: z.array(ImportResultSchema),
  },
  /** The progress of the running import; null when none runs or no workspace is open. Never waits for the queue. */
  'files:importProgress': {
    request: EmptyRequestSchema,
    response: ImportProgressSchema.nullable(),
  },
  /** Marks the running import to stop after the item in progress; `cancelling` is false when none runs. */
  'files:cancelImport': {
    request: EmptyRequestSchema,
    response: z.object({ cancelling: z.boolean() }),
  },
  /**
   * Queues one download job per usable line; `skipDuplicates` defaults to true. A line over the length
   * limit is reported as invalid, not refused by the schema; only a line over 10000 characters is refused.
   */
  'files:importUrls': {
    request: z.object({
      urls: z.array(z.string().max(IMPORT_URL_STRING_MAX)).min(1).max(MAX_IMPORT_URLS),
      target: FileTargetSchema.optional(),
      skipDuplicates: z.boolean().optional(),
    }),
    response: UrlImportResultSchema,
  },
  /** The addresses a file was downloaded from, oldest first. */
  'files:origins': {
    request: z.object({ fileId: IdSchema }),
    response: z.array(FileOriginSchema),
  },
  /** Opens a stored origin in the system browser; the renderer never passes the address itself. */
  'files:openOrigin': {
    request: z.object({ fileId: IdSchema, originId: IdSchema }),
    response: z.object({}),
  },
  'files:list': {
    /** `hasProposal` is a list filter only; it is not part of `FileListFilter` in an analysis target. */
    request: PageRequestSchema.extend(FileListFilterSchema.shape).extend({ hasProposal: z.boolean().optional() }),
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
  /** Assigns each file on its own, in request order; one failing file does not stop the others. */
  'files:assignMany': {
    request: z.object({ fileIds: FileIdsSchema, assetId: IdSchema, role: FileRoleSchema }),
    response: AssignManyResultSchema,
  },
  /** Moves each complete file to the trash and removes each failed file outright; per item, in request order. */
  'files:trashMany': {
    request: z.object({ fileIds: FileIdsSchema }),
    response: FileBatchResultSchema,
  },
  /** Moves each trashed file back to its asset and role, or to the inbox; per item. */
  'files:restoreMany': {
    request: z.object({ fileIds: FileIdsSchema }),
    response: FileBatchResultSchema,
  },
  /** Removes each trashed file for good; per item, a purged item carries neither file nor error. */
  'files:purgeMany': {
    request: z.object({ fileIds: FileIdsSchema }),
    response: FileBatchResultSchema,
  },
  'trash:empty': {
    request: EmptyRequestSchema,
    response: EmptyTrashResultSchema,
  },
  'trash:summary': {
    request: EmptyRequestSchema,
    response: TrashSummarySchema,
  },
  'assetTypes:list': {
    request: EmptyRequestSchema,
    response: z.array(AssetTypeSchema),
  },
  'projects:list': {
    request: PageRequestSchema.extend({
      query: z.string().max(200).optional(),
      status: ProjectStatusSchema.optional(),
      tagNames: z.array(z.string().max(200)).max(10).optional(),
    }),
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
    request: PageRequestSchema.extend(AssetListFilterSchema.shape),
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
  'tags:suggest': {
    request: z.object({ prefix: z.string().max(200), limit: z.number().int().min(1).max(50) }),
    response: z.array(TagSuggestionSchema),
  },
  /** Free text, normalised in main; a text that is no valid tag name answers `exists: false` with zero counts. */
  'tags:usage': {
    request: z.object({ name: z.string().max(200) }),
    response: TagUsageSchema,
  },
  /** Renames a tag workspace-wide; onto an existing other tag only with `merge: true`. */
  'tags:rename': {
    request: z.object({ from: z.string().max(200), to: z.string().max(200), merge: z.boolean() }),
    response: TagRenameResultSchema,
  },
  'assets:addTag': {
    request: z.object({ assetId: IdSchema, name: z.string().max(200) }),
    response: AssetDetailSchema,
  },
  'assets:removeTag': {
    request: z.object({ assetId: IdSchema, name: z.string().max(200) }),
    response: AssetDetailSchema,
  },
  'assets:addSource': {
    request: z.object({ assetId: IdSchema, url: z.string().max(2000) }),
    response: AssetDetailSchema,
  },
  'assets:removeSource': {
    request: z.object({ assetId: IdSchema, sourceId: IdSchema }),
    response: AssetDetailSchema,
  },
  // Opens a stored source in the system browser; the renderer never passes the address itself.
  'assets:openSource': {
    request: z.object({ assetId: IdSchema, sourceId: IdSchema }),
    response: z.null(),
  },
  'files:addTag': {
    request: z.object({ fileId: IdSchema, name: z.string().max(200) }),
    response: FileRecordSchema,
  },
  'files:removeTag': {
    request: z.object({ fileId: IdSchema, name: z.string().max(200) }),
    response: FileRecordSchema,
  },
  /** All or nothing: tags every file or, when one is unknown or not complete, none. */
  'files:addTagMany': {
    request: z.object({ fileIds: FileIdsSchema, name: z.string().max(200) }),
    response: FileRecordsSchema,
  },
  /** All or nothing like `files:addTagMany`; a file without the tag is left alone. */
  'files:removeTagMany': {
    request: z.object({ fileIds: FileIdsSchema, name: z.string().max(200) }),
    response: FileRecordsSchema,
  },
  /** Measures a complete image without stored dimensions; returns the (possibly unchanged) record. */
  'files:measure': {
    request: z.object({ fileId: IdSchema }),
    response: FileRecordSchema,
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
  /** Provider channels need no open workspace. A view never carries an API key. */
  'providers:list': {
    request: EmptyRequestSchema,
    response: ProviderListSchema,
  },
  /**
   * Without `id` the entry is created, with `id` it is replaced. `apiKey` absent keeps the stored key,
   * `null` deletes it; a changed origin without a new key deletes it.
   */
  'providers:save': {
    request: SaveProviderSchema,
    response: ProviderViewSchema,
  },
  /** Refused while the entry has active jobs. */
  'providers:delete': {
    request: z.object({ id: ProviderIdSchema }),
    response: z.object({}),
  },
  /** The models of one entry; cached until the entry changes or `refresh` is true. */
  'providers:listModels': {
    request: z.object({ providerId: ProviderIdSchema, refresh: z.boolean().optional() }),
    response: ListModelsResultSchema,
  },
  /** The image edit models of a `venice` entry; cached until the entry changes or `refresh` is true. */
  'providers:listImageModels': {
    request: z.object({ providerId: ProviderIdSchema, refresh: z.boolean().optional() }),
    response: ListImageModelsResultSchema,
  },
  /** Starts an edit or upscale of one complete image outside the trash as a job. */
  'generations:start': {
    request: StartGenerationSchema,
    response: StartGenerationResultSchema,
  },
  /** The generation that made this file, and the generations made from it, newest first. */
  'generations:forFile': {
    request: z.object({ fileId: IdSchema }),
    response: z.object({
      madeBy: GenerationSchema.nullable(),
      results: z.array(GenerationSchema).max(MAX_FILE_GENERATIONS),
    }),
  },
  /** Only a failed or cancelled generation; it runs again with the same settings. */
  'generations:retry': {
    request: z.object({ generationId: IdSchema }),
    response: GenerationSchema,
  },
  /** Only a failed or cancelled generation. */
  'generations:remove': {
    request: z.object({ generationId: IdSchema }),
    response: z.object({}),
  },
  /** Distinct edit prompts, newest use first. */
  'generations:recentPrompts': {
    request: EmptyRequestSchema,
    response: z.object({ prompts: z.array(z.string()).max(MAX_RECENT_PROMPTS) }),
  },
  /** The prompt library, newest change first; every query word must appear, every tag must be on the prompt. */
  'prompts:list': {
    request: ListPromptsSchema,
    response: PromptPageSchema,
  },
  'prompts:get': {
    request: z.object({ promptId: IdSchema }),
    response: PromptDetailSchema,
  },
  /** A prompt with version 1; the title is unique regardless of case. */
  'prompts:create': {
    request: CreatePromptSchema,
    response: PromptDetailSchema,
  },
  /** Title and description only. */
  'prompts:update': {
    request: UpdatePromptSchema,
    response: PromptDetailSchema,
  },
  /** A new version on top of `baseVersionId`, which must be the current one; an unchanged text writes nothing. */
  'prompts:saveVersion': {
    request: SavePromptVersionSchema,
    response: PromptDetailSchema,
  },
  /** Generations keep their copies of the prompt. */
  'prompts:delete': {
    request: z.object({ promptId: IdSchema }),
    response: z.object({}),
  },
  'prompts:addTag': {
    request: z.object({ promptId: IdSchema, name: z.string().max(200) }),
    response: PromptDetailSchema,
  },
  /** A tag the prompt does not carry is a no-op. */
  'prompts:removeTag': {
    request: z.object({ promptId: IdSchema, name: z.string().max(200) }),
    response: PromptDetailSchema,
  },
  /** App-level analysis prompts need no open workspace. The file order is kept; a purpose never has none. */
  'analysisPrompts:list': {
    request: EmptyRequestSchema,
    response: AnalysisPromptListSchema,
  },
  /** Without `id` the prompt is appended; with `id` it is replaced in place. The purpose cannot change. */
  'analysisPrompts:save': {
    request: SaveAnalysisPromptSchema,
    response: AnalysisPromptSchema,
  },
  /** Refused for the last prompt of a purpose; the prompt used last reads as null afterwards. */
  'analysisPrompts:delete': {
    request: IdRequestSchema,
    response: z.object({}),
  },
  /** Text (and tag limit) back to the built-in content of its purpose; the name stays. */
  'analysisPrompts:reset': {
    request: IdRequestSchema,
    response: AnalysisPromptSchema,
  },
  /** What `analysis:enqueue` of this target with this model would do, as counts. */
  'analysis:preview': {
    request: z.object({ target: AnalysisTargetSchema, model: ModelNameSchema, providerId: ProviderIdSchema.optional() }),
    response: AnalysisPreviewSchema,
  },
  /**
   * Not all or nothing: analysable files are enqueued, the others are counted as skipped. `force`
   * bypasses the fingerprint skip. `propose` only for a `files` target with exactly one id; it implies `force`.
   * Without `promptId` the tagging analysis prompt used last runs, otherwise the first one.
   */
  'analysis:enqueue': {
    request: z.object({
      target: AnalysisTargetSchema,
      model: ModelNameSchema,
      mode: AnalysisModeSchema,
      force: z.boolean(),
      promptId: IdSchema.optional(),
      providerId: ProviderIdSchema.optional(),
    }),
    response: EnqueueAnalysisResultSchema,
  },
  /** The waiting proposal of a file and its active or latest analysis job. */
  'analysis:getProposal': {
    request: z.object({ fileId: IdSchema }),
    response: z.object({ proposal: ProposalViewSchema.nullable(), job: JobViewSchema.nullable() }),
  },
  /**
   * Applies a non-empty subset of the proposal's tag names; `not_found` when the file has no proposal,
   * `invalid_operation` when it is stale or a name is not in it.
   */
  'analysis:acceptProposal': {
    request: z.object({ fileId: IdSchema, names: z.array(z.string().min(1).max(200)).min(1).max(50) }),
    response: z.object({}),
  },
  /** Idempotent. */
  'analysis:discardProposal': {
    request: z.object({ fileId: IdSchema }),
    response: z.object({}),
  },
  /**
   * Image2Prompt: one request at a time (`busy` otherwise); the text is not stored. Without `promptId`
   * the Image to prompt analysis prompt used last runs, otherwise the first one.
   */
  'analysis:describe': {
    request: z.object({
      requestId: IdSchema,
      fileId: IdSchema,
      model: ModelNameSchema,
      promptId: IdSchema.optional(),
      providerId: ProviderIdSchema.optional(),
    }),
    response: DescribeResultSchema,
  },
  /** An unknown or finished request is left alone. */
  'analysis:cancelDescribe': {
    request: z.object({ requestId: IdSchema }),
    response: z.object({}),
  },
  /** Newest first. */
  'jobs:list': {
    request: PageRequestSchema.extend({ status: JobStatusSchema.optional(), providerId: ProviderIdSchema.optional() }),
    response: pageOf(JobViewSchema),
  },
  'jobs:summary': {
    request: EmptyRequestSchema,
    response: JobSummarySchema,
  },
  /** A finished job is left alone. */
  'jobs:cancel': {
    request: z.object({ jobId: IdSchema }),
    response: z.object({}),
  },
  /** Every queued, waiting and running job. */
  'jobs:cancelAll': {
    request: EmptyRequestSchema,
    response: z.object({ cancelled: z.number().int().nonnegative() }),
  },
  /** `invalid_operation` unless the job is failed or cancelled and its file has no active job. */
  'jobs:retry': {
    request: z.object({ jobId: IdSchema }),
    response: z.object({}),
  },
  /** Every failed or cancelled job whose file has no active job. */
  'jobs:retryFailed': {
    request: EmptyRequestSchema,
    response: z.object({ retried: z.number().int().nonnegative() }),
  },
  /** Waiting analysis jobs per provider; `providerId` null is the jobs without one. */
  'jobs:waitingByProvider': {
    request: EmptyRequestSchema,
    response: z.array(WaitingByProviderSchema),
  },
  /** Ends the pause of one provider's analysis queue; `null` is the jobs without a provider. */
  'jobs:resume': {
    request: z.object({ providerId: ProviderIdSchema.nullable() }),
    response: z.object({}),
  },
  /** Ends the pause of one download host. */
  'jobs:resumeHost': {
    request: z.object({ host: z.string().min(1).max(300) }),
    response: z.object({}),
  },
  /** Moves every waiting analysis job of one provider onto another with this model; a running job stays. */
  'jobs:reroute': {
    request: z.object({
      fromProviderId: ProviderIdSchema.nullable(),
      toProviderId: ProviderIdSchema,
      model: ModelNameSchema,
    }),
    response: z.object({ moved: z.number().int().min(0) }),
  },
  /** Deletes every succeeded, failed and cancelled job. */
  'jobs:clearFinished': {
    request: EmptyRequestSchema,
    response: z.object({ removed: z.number().int().nonnegative() }),
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
