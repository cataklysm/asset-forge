import { z } from 'zod';

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

/**
 * v1 rows were written by phase 4a and run in mode `apply` with the tagging default model;
 * v2 carries the model chosen at enqueue and whether the result is applied or proposed.
 */
export const AnalyzeFilePayloadSchema = z.union([
  z.object({ version: z.literal(1) }),
  z.object({ version: z.literal(2), model: ModelNameSchema, mode: z.enum(['apply', 'propose']) }),
]);
export type AnalyzeFilePayload = z.infer<typeof AnalyzeFilePayloadSchema>;

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
});
export type JobView = z.infer<typeof JobViewSchema>;

const count = z.number().int().nonnegative();

/** `waiting` is `retry_wait` and `waiting_remote` together. */
export const JobSummarySchema = z.object({
  queued: count,
  running: count,
  waiting: count,
  failed: count,
  cancelled: count,
  succeeded: count,
  changes: count,
  /** Set while the `local_gpu` queue is paused because the provider is down or refused the request; null otherwise. */
  paused: z.object({ reason: JobErrorCodeSchema }).nullable(),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

/** Why a file was not queued by an enqueue; the IPC result carries counts per reason (`EnqueueAnalysisResultSchema`). */
export const AnalysisSkipReasonSchema = z.enum(['not_found', 'not_analysable', 'already_queued', 'already_analysed']);
export type AnalysisSkipReason = z.infer<typeof AnalysisSkipReasonSchema>;
