import { z } from 'zod';
import {
  AnalysisModeSchema,
  AnalysisPreviewSchema,
  AnalysisTargetSchema,
  DescribeResultSchema,
  EnqueueAnalysisResultSchema,
  ProposalViewSchema,
} from './analysis';
import { JobViewSchema } from './jobs';
import { ModelNameSchema, ProviderIdSchema } from './provider-ref';
import { type ChannelContracts, IdSchema } from './ipc-shared';

/** The analysis channels: preview and enqueue of the tag analysis, proposals, and Image to prompt. */
export const analysisChannels = {
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
} as const satisfies ChannelContracts;
