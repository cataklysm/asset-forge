import { z } from 'zod';
import { AnalysisPromptNameSchema, AnalysisPromptTextSchema, AnalysisTagLimitSchema } from './analysis-prompts';
import { FileTargetSchema } from './files';
import { ProviderIdSchema, ProviderKindSchema, ProviderNameSchema } from './provider-ref';
import { SiteFilterSchema } from './site-import';

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
  'provider_outcome_unknown',
  'provider_insufficient_balance',
  'provider_content_refused',
  'generation_result_not_stored',
  'download_unreachable',
  'download_unavailable',
  'download_throttled',
  'download_blocked',
  'download_unauthorized',
  'download_forbidden',
  'download_not_found',
  'download_rejected',
  'download_address_refused',
  'download_too_large',
  'download_not_a_file',
  'download_type_refused',
  'download_no_space',
  'download_profile_missing',
  'download_login_not_sent',
]);
export type JobErrorCode = z.infer<typeof JobErrorCodeSchema>;

export const ACTIVE_JOB_STATUSES = ['queued', 'running', 'waiting_remote', 'retry_wait'] as const;
export const FINISHED_JOB_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

/** The only text a job row or IPC response carries for a failure. */
export const JOB_ERROR_MESSAGES: Record<JobErrorCode, string> = {
  provider_unreachable: 'The provider could not be reached',
  provider_timeout: 'The provider did not answer in time',
  provider_unavailable: 'The provider is temporarily unavailable',
  provider_rejected: 'The provider rejected the request',
  invalid_response: 'The provider returned an unusable answer',
  file_unavailable: 'The file is not available',
  internal_error: 'The job failed unexpectedly',
  provider_unauthorized: 'The provider refused the API key',
  provider_not_configured: 'No provider is configured',
  provider_outcome_unknown: 'The provider may have processed this request; it was not repeated',
  provider_insufficient_balance: 'The provider account has no balance left',
  provider_content_refused: 'The provider refused this content',
  generation_result_not_stored: 'The provider answered, but the result could not be stored',
  download_unreachable: 'The address could not be reached',
  download_unavailable: 'The server is temporarily unavailable',
  download_throttled: 'The server asked to slow down',
  download_blocked: 'The server refused access',
  download_unauthorized: 'The server asked for a login (HTTP 401)',
  download_forbidden: 'The server refused access (HTTP 403)',
  download_not_found: 'The file was not found at this address',
  download_rejected: 'The server rejected the request',
  download_address_refused: 'This address is not allowed',
  download_too_large: 'The file is larger than the download limit',
  download_not_a_file: 'This address is a web page, not a file',
  download_type_refused: 'This file type cannot be imported',
  download_no_space: 'There is not enough free disk space',
  download_profile_missing: 'The site profile of this download no longer exists',
  download_login_not_sent: "The server refused the file; the login is only sent to the profile's site",
};

const RETRYABLE: ReadonlySet<JobErrorCode> = new Set([
  'provider_unreachable',
  'provider_timeout',
  'provider_unavailable',
  'invalid_response',
  'download_unreachable',
  'download_unavailable',
  'download_throttled',
]);

export function isRetryableJobError(code: JobErrorCode): boolean {
  return RETRYABLE.has(code);
}

export const ANALYZE_FILE_JOB = 'vision.analyze_file';
export const IMAGE_GENERATE_JOB = 'image.generate';
export const FILE_DOWNLOAD_JOB = 'file.download';

/**
 * What a succeeded job produced besides its file; null on an ordinary result. `filtered_kind` / `filtered_size`: a
 * site download the profile's kinds or minimum size left out; the job keeps no file. `filtered` is what older
 * versions wrote for either; it still parses, and no new job writes it.
 */
export const JobResultSchema = z.enum(['already_present', 'filtered', 'filtered_kind', 'filtered_size']);
export type JobResult = z.infer<typeof JobResultSchema>;

const downloadFields = {
  url: z.string().min(1).max(2000),
  target: FileTargetSchema.nullable(),
  skipDuplicates: z.boolean(),
};

/** A download job of the URL import; `target` null leaves the file in the inbox. */
export const FileDownloadPayloadV1Schema = z.object({ v: z.literal(1), ...downloadFields });
/** A download of the site import: sent with the profile's login, kept only when it passes `filter`. */
export const FileDownloadPayloadV2Schema = z.object({
  v: z.literal(2),
  ...downloadFields,
  siteProfileId: z.uuid(),
  filter: SiteFilterSchema,
});
export const FileDownloadPayloadSchema = z.discriminatedUnion('v', [FileDownloadPayloadV1Schema, FileDownloadPayloadV2Schema]);
export type FileDownloadPayload = z.infer<typeof FileDownloadPayloadSchema>;

/** { url, host } of a download payload; nulls for anything else. `host` is lower case with a non-default port. */
export function downloadJobFields(payload: unknown): { url: string | null; host: string | null } {
  const parsed = FileDownloadPayloadSchema.safeParse(payload);
  if (!parsed.success) return { url: null, host: null };
  try {
    return { url: parsed.data.url, host: new URL(parsed.data.url).host };
  } catch {
    return { url: null, host: null };
  }
}

/** An image generation job names its generation row; everything else lives on that row. */
export const ImageGeneratePayloadSchema = z.object({ v: z.literal(1), generationId: z.uuid() });
export type ImageGeneratePayload = z.infer<typeof ImageGeneratePayloadSchema>;

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
  /** The address of a download job; null for any other job. A download has no provider id, name or model. */
  url: z.string().nullable(),
  /** The host lane of a download job; null for any other job. */
  host: z.string().nullable(),
  result: JobResultSchema.nullable(),
});
export type JobView = z.infer<typeof JobViewSchema>;

const count = z.number().int().nonnegative();

/**
 * A provider whose jobs are paused; `providerId` null is the jobs without a provider. `kind` follows
 * the kind of the lane's entry (`purposeOf` tells a vision lane from an image lane); for a lane whose
 * entry no longer exists the resource class decides: `remote_api` is `venice`, `local_gpu` is `ollama`.
 */
export const PausedProviderSchema = z.object({
  providerId: ProviderIdSchema.nullable(),
  providerName: z.string().nullable(),
  kind: ProviderKindSchema,
  reason: JobErrorCodeSchema,
});
export type PausedProvider = z.infer<typeof PausedProviderSchema>;

/** A download host whose jobs are paused for the application session. */
export const PausedHostSchema = z.object({ host: z.string(), reason: JobErrorCodeSchema });
export type PausedHost = z.infer<typeof PausedHostSchema>;

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
  /** Every download host that is paused after repeated failures; empty otherwise. */
  pausedHosts: z.array(PausedHostSchema),
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

/**
 * What changed since a cursor of `changes:since`. `reset` is true for a null, foreign or too old cursor, and then
 * every list is empty and the caller treats everything as changed. `jobIds` and `fileIds` are distinct; `jobs` is
 * true when jobs were added, removed or changed in bulk; `added` names each place a file was added to once, with
 * `assetId` null for the inbox.
 */
export const ChangesSchema = z.object({
  cursor: z.string(),
  reset: z.boolean(),
  jobIds: z.array(z.string()),
  jobs: z.boolean(),
  fileIds: z.array(z.string()),
  added: z.array(z.object({ assetId: z.string().nullable() })),
});
export type Changes = z.infer<typeof ChangesSchema>;
