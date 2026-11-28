import { z } from 'zod';
import { JobErrorCodeSchema } from './job-errors';
import { ModelNameSchema, ProviderIdSchema, ProviderKindSchema } from './provider-ref';
import { CountSchema } from './ipc-shared';

/** The technical status of a job; separate from asset status and workflow step state. */
export const JobStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_remote',
  'succeeded',
  'failed',
  'cancelled',
  'retry_wait',
]);
/** The technical status of a job. */
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** The resource a job needs; each class has its own limit in the scheduler. */
export const ResourceClassSchema = z.enum(['cpu', 'io', 'local_gpu', 'remote_api']);
/** The resource a job needs. */
export type ResourceClass = z.infer<typeof ResourceClassSchema>;

/** Runs per job, the first one included; the scheduler's limit and the denominator of the Jobs screen's attempts. */
export const MAX_ATTEMPTS = 3;

/** The statuses of a job that has not ended yet. */
export const ACTIVE_JOB_STATUSES = ['queued', 'running', 'waiting_remote', 'retry_wait'] as const;
/** The statuses of a job that has ended. */
export const FINISHED_JOB_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

/**
 * What a succeeded job produced besides its file; null on an ordinary result. `filtered_kind` / `filtered_size`: a
 * site download the profile's kinds or minimum size left out; the job keeps no file. `filtered` is what older
 * versions wrote for either; it still parses, and no new job writes it.
 */
export const JobResultSchema = z.enum(['already_present', 'filtered', 'filtered_kind', 'filtered_size']);
/** What a succeeded job produced besides its file. */
export type JobResult = z.infer<typeof JobResultSchema>;

/** A job as the Jobs screen shows it, with the fields read from its payload. */
export const JobViewSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: JobStatusSchema,
  attempt: CountSchema,
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
/** A job as the Jobs screen shows it. */
export type JobView = z.infer<typeof JobViewSchema>;

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
/** A provider whose jobs are paused. */
export type PausedProvider = z.infer<typeof PausedProviderSchema>;

/** A download host whose jobs are paused for the application session. */
export const PausedHostSchema = z.object({ host: z.string(), reason: JobErrorCodeSchema });
/** A download host whose jobs are paused. */
export type PausedHost = z.infer<typeof PausedHostSchema>;

/** `waiting` is `retry_wait` and `waiting_remote` together. */
export const JobSummarySchema = z.object({
  queued: CountSchema,
  running: CountSchema,
  waiting: CountSchema,
  failed: CountSchema,
  cancelled: CountSchema,
  succeeded: CountSchema,
  /** The total of the change feed; a list reads `changes:since` when it moved. */
  changes: CountSchema,
  /** Every provider whose analysis queue is paused because it is down or refused the request; empty otherwise. */
  paused: z.array(PausedProviderSchema),
  /** Every download host that is paused after repeated failures; empty otherwise. */
  pausedHosts: z.array(PausedHostSchema),
});
/** The answer of `jobs:summary`. */
export type JobSummary = z.infer<typeof JobSummarySchema>;

/** The waiting (`queued` and `retry_wait`) analysis jobs of one provider; `providerId` null is the jobs without one. */
export const WaitingByProviderSchema = z.object({
  providerId: ProviderIdSchema.nullable(),
  providerName: z.string().nullable(),
  waiting: CountSchema,
});
/** The waiting analysis jobs of one provider. */
export type WaitingByProvider = z.infer<typeof WaitingByProviderSchema>;
