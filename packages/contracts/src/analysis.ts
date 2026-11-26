import { z } from 'zod';
import { FileIdsSchema, FileKindSchema, FileScopeSchema } from './files';
import { JobErrorCodeSchema, ModelNameSchema } from './jobs';
import { AssetStatusSchema, FileRoleSchema } from './library';

const count = z.number().int().nonnegative();
const TagNameSchema = z.string().max(200);

/** The filter part of `files:list`: which files a list shows, without paging. */
export const FileListFilterSchema = z.object({
  scope: FileScopeSchema,
  query: z.string().max(200).optional(),
  tagNames: z.array(TagNameSchema).max(10).optional(),
  role: FileRoleSchema.optional(),
  kind: FileKindSchema.optional(),
});
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
export type AnalysisTarget = z.infer<typeof AnalysisTargetSchema>;

/** `apply` writes the AI tags; `propose` stores a proposal that waits for the owner. */
export const AnalysisModeSchema = z.enum(['apply', 'propose']);
export type AnalysisMode = z.infer<typeof AnalysisModeSchema>;

/** What an enqueue of a target with a model would do, by file count. */
export const AnalysisPreviewSchema = z.object({
  analysable: count,
  alreadyAnalysed: count,
  alreadyQueued: count,
  notAnalysable: count,
});
export type AnalysisPreview = z.infer<typeof AnalysisPreviewSchema>;

/** Counts, not a per-file list: a filter target can cover a whole workspace. */
export const EnqueueAnalysisResultSchema = z.object({
  enqueued: count,
  skipped: z.object({
    notFound: count,
    notAnalysable: count,
    alreadyQueued: count,
    alreadyAnalysed: count,
  }),
});
export type EnqueueAnalysisResult = z.infer<typeof EnqueueAnalysisResultSchema>;

/** A tag of a proposal: normalised name and the text shown. */
export const ProposalTagSchema = z.object({ name: z.string(), displayName: z.string() });
export type ProposalTag = z.infer<typeof ProposalTagSchema>;

/** A waiting proposal of a file; `stale` when the file's content changed since the analysis. */
export const ProposalViewSchema = z.object({
  model: ModelNameSchema,
  createdAt: z.iso.datetime(),
  stale: z.boolean(),
  tags: z.array(ProposalTagSchema),
});
export type ProposalView = z.infer<typeof ProposalViewSchema>;

/** The Image2Prompt answer; the text is never stored. */
export const DescribeResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), text: z.string() }),
  z.object({ ok: z.literal(false), code: z.union([JobErrorCodeSchema, z.enum(['cancelled', 'busy'])]) }),
]);
export type DescribeResult = z.infer<typeof DescribeResultSchema>;
