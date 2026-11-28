import { z } from 'zod';
import { FileIdsSchema, FileKindSchema, FileScopeSchema } from './files';
import { JobErrorCodeSchema } from './job-errors';
import { AssetStatusSchema, FileRoleSchema } from './library';
import { ModelNameSchema } from './provider-ref';
import { CountSchema } from './ipc-shared';

const TagNameSchema = z.string().max(200);

/** The filter part of `files:list`: which files a list shows, without paging. */
export const FileListFilterSchema = z.object({
  scope: FileScopeSchema,
  query: z.string().max(200).optional(),
  tagNames: z.array(TagNameSchema).max(10).optional(),
  role: FileRoleSchema.optional(),
  kind: FileKindSchema.optional(),
});
/** Which files a list shows. */
export type FileListFilter = z.infer<typeof FileListFilterSchema>;

/** The filter part of `assets:list`: which assets the gallery shows, without paging. */
export const AssetListFilterSchema = z.object({
  typeId: z.uuid().optional(),
  status: AssetStatusSchema.optional(),
  projectId: z.uuid().optional(),
  query: z.string().max(200).optional(),
  tagNames: z.array(TagNameSchema).max(10).optional(),
  fileRole: FileRoleSchema.optional(),
  fileKind: FileKindSchema.optional(),
});
/** Which assets the gallery shows. */
export type AssetListFilter = z.infer<typeof AssetListFilterSchema>;

/**
 * What an analysis covers: listed files, the files of a file list filter, the analysable files of
 * one asset, or those of the assets of an asset filter (narrowed to `fileRole` / `fileKind` when set).
 */
export const AnalysisTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('files'), fileIds: FileIdsSchema }),
  z.object({ kind: z.literal('fileFilter'), filter: FileListFilterSchema }),
  z.object({ kind: z.literal('asset'), assetId: z.uuid() }),
  z.object({ kind: z.literal('assetFilter'), filter: AssetListFilterSchema }),
]);
/** What an analysis covers. */
export type AnalysisTarget = z.infer<typeof AnalysisTargetSchema>;

/** `apply` writes the AI tags; `propose` stores a proposal that waits for the owner. */
export const AnalysisModeSchema = z.enum(['apply', 'propose']);
/** Whether an analysis writes its tags or proposes them. */
export type AnalysisMode = z.infer<typeof AnalysisModeSchema>;

/** What an enqueue of a target with a model would do, by file count. */
export const AnalysisPreviewSchema = z.object({
  analysable: CountSchema,
  alreadyAnalysed: CountSchema,
  alreadyQueued: CountSchema,
  notAnalysable: CountSchema,
});
/** The answer of `analysis:preview`. */
export type AnalysisPreview = z.infer<typeof AnalysisPreviewSchema>;

/** Counts, not a per-file list: a filter target can cover a whole workspace. */
export const EnqueueAnalysisResultSchema = z.object({
  enqueued: CountSchema,
  skipped: z.object({
    notFound: CountSchema,
    notAnalysable: CountSchema,
    alreadyQueued: CountSchema,
    alreadyAnalysed: CountSchema,
  }),
});
/** The answer of `analysis:enqueue`. */
export type EnqueueAnalysisResult = z.infer<typeof EnqueueAnalysisResultSchema>;

/**
 * Why a file was not queued by an enqueue; the IPC result carries counts per reason
 * (`EnqueueAnalysisResultSchema`).
 */
export const AnalysisSkipReasonSchema = z.enum(['not_found', 'not_analysable', 'already_queued', 'already_analysed']);
/** Why a file was not queued by an enqueue. */
export type AnalysisSkipReason = z.infer<typeof AnalysisSkipReasonSchema>;

/** A tag of a proposal: normalised name and the text shown. */
export const ProposalTagSchema = z.object({ name: z.string(), displayName: z.string() });
/** A tag of a proposal. */
export type ProposalTag = z.infer<typeof ProposalTagSchema>;

/** A waiting proposal of a file; `stale` when the file's content changed since the analysis. */
export const ProposalViewSchema = z.object({
  model: ModelNameSchema,
  /** Name of the analysis prompt used, as it was then; null for proposals from before analysis prompts. */
  promptName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  stale: z.boolean(),
  tags: z.array(ProposalTagSchema).max(50),
});
/** A waiting proposal of a file. */
export type ProposalView = z.infer<typeof ProposalViewSchema>;

/** The Image2Prompt answer; the text is never stored. */
export const DescribeResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), text: z.string() }),
  z.object({ ok: z.literal(false), code: z.union([JobErrorCodeSchema, z.enum(['cancelled', 'busy'])]) }),
]);
/** The answer of `analysis:describe`. */
export type DescribeResult = z.infer<typeof DescribeResultSchema>;
