import { z } from 'zod';
import { AnalysisPromptNameSchema, AnalysisPromptTextSchema, AnalysisTagLimitSchema } from './analysis-prompts';
import { ProviderIdSchema, ProviderNameSchema } from './provider-ref';

export const JobStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_remote',
  'succeeded',
  'failed',
  'cancelled',
  'retry_wait',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const ResourceClassSchema = z.enum(['cpu', 'io', 'local_gpu', 'remote_api']);
export type ResourceClass = z.infer<typeof ResourceClassSchema>;

export const JobErrorCodeSchema = z.enum([
  'provider_unreachable',
  'provider_timeout',
  'provider_unavailable',
  'provider_rejected',
  'invalid_response',
  'file_unavailable',
  'internal_error',
  'provider_unauthorized',
  'provider_not_configured',
]);
export type JobErrorCode = z.infer<typeof JobErrorCodeSchema>;

export const ACTIVE_JOB_STATUSES = ['queued', 'running', 'waiting_remote', 'retry_wait'] as const;
export const FINISHED_JOB_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

/** The only text a job row or IPC response carries for a failure. */
export const JOB_ERROR_MESSAGES: Record<JobErrorCode, string> = {
  provider_unreachable: 'The analysis provider could not be reached',
  provider_timeout: 'The analysis provider did not answer in time',
  provider_unavailable: 'The analysis provider is temporarily unavailable',
  provider_rejected: 'The analysis provider rejected the request',
  invalid_response: 'The analysis provider returned an unusable answer',
  file_unavailable: 'The file is not available for analysis',
  internal_error: 'The job failed unexpectedly',
  provider_unauthorized: 'The analysis provider refused the API key',
  provider_not_configured: 'No analysis provider is configured',
};

const RETRYABLE: ReadonlySet<JobErrorCode> = new Set([
  'provider_unreachable',
  'provider_timeout',
  'provider_unavailable',
  'invalid_response',
]);

export function isRetryableJobError(code: JobErrorCode): boolean {
  return RETRYABLE.has(code);
}

export const ANALYZE_FILE_JOB = 'vision.analyze_file';

/** A model name as the provider lists it; stored and sent verbatim. */
export const ModelNameSchema = z.string().min(1).max(200);

/** The analysis prompt a v3 job runs with, copied at enqueue so later edits do not reach waiting jobs. */
export const AnalyzeFilePromptSchema = z.object({
  name: AnalysisPromptNameSchema,
  text: AnalysisPromptTextSchema,
  maxTags: AnalysisTagLimitSchema,
});
export type AnalyzeFilePrompt = z.infer<typeof AnalyzeFilePromptSchema>;

/**
 * v1 rows were written by phase 4a and run in mode `apply` with the tagging default model;
 * v2 carries the model chosen at enqueue and whether the result is applied or proposed;
 * v3 adds the analysis prompt; v4 adds a copy of the provider name, and its prompt may be null.
 * v1 and v2 jobs run with the built-in prompt and at most 20 tags.
 */
export const AnalyzeFilePayloadSchema = z.union([
  z.object({ version: z.literal(1) }),
  z.object({ version: z.literal(2), model: ModelNameSchema, mode: z.enum(['apply', 'propose']) }),
  z.object({
    version: z.literal(3),
    model: ModelNameSchema,
    mode: z.enum(['apply', 'propose']),
    prompt: AnalyzeFilePromptSchema,
  }),
  z.object({
    version: z.literal(4),
    model: ModelNameSchema,
    mode: z.enum(['apply', 'propose']),
    prompt: AnalyzeFilePromptSchema.nullable(),
    providerName: ProviderNameSchema,
  }),
]);
export type AnalyzeFilePayload = z.infer<typeof AnalyzeFilePayloadSchema>;

/** The provider name (v4) and model (v2 to v4) of an analysis payload; nulls otherwise or when it does not parse. */
export function analysisJobFields(payload: unknown): { providerName: string | null; model: string | null } {
  const parsed = AnalyzeFilePayloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.version === 1) return { providerName: null, model: null };
  return { providerName: parsed.data.version === 4 ? parsed.data.providerName : null, model: parsed.data.model };
}

export const JobViewSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: JobStatusSchema,
  attempt: z.number().int().nonnegative(),
  fileId: z.string().nullable(),
  /** Original file name; null when the job has no file. */
  fileName: z.string().nullable(),
  errorCode: JobErrorCodeSchema.nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  runAfter: z.iso.datetime().nullable(),
  /** The job's lane; null for a job without a provider. */
  providerId: ProviderIdSchema.nullable(),
  /** The provider name copied into the payload at enqueue; null before payload v4. */
  providerName: z.string().nullable(),
  model: ModelNameSchema.nullable(),
});
export type JobView = z.infer<typeof JobViewSchema>;

const count = z.number().int().nonnegative();

/** A provider whose analysis jobs are paused; `providerId` null is the jobs without a provider. */
export const PausedProviderSchema = z.object({
  providerId: ProviderIdSchema.nullable(),
  providerName: z.string().nullable(),
  reason: JobErrorCodeSchema,
});
export type PausedProvider = z.infer<typeof PausedProviderSchema>;

/** `waiting` is `retry_wait` and `waiting_remote` together. */
export const JobSummarySchema = z.object({
  queued: count,
  running: count,
  waiting: count,
  failed: count,
  cancelled: count,
  succeeded: count,
  changes: count,
  /** Every provider whose analysis queue is paused because it is down or refused the request; empty otherwise. */
  paused: z.array(PausedProviderSchema),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

/** The waiting (`queued` and `retry_wait`) analysis jobs of one provider; `providerId` null is the jobs without one. */
export const WaitingByProviderSchema = z.object({
  providerId: ProviderIdSchema.nullable(),
  providerName: z.string().nullable(),
  waiting: z.number().int().min(0),
});
export type WaitingByProvider = z.infer<typeof WaitingByProviderSchema>;

/** Why a file was not queued by an enqueue; the IPC result carries counts per reason (`EnqueueAnalysisResultSchema`). */
export const AnalysisSkipReasonSchema = z.enum(['not_found', 'not_analysable', 'already_queued', 'already_analysed']);
export type AnalysisSkipReason = z.infer<typeof AnalysisSkipReasonSchema>;
