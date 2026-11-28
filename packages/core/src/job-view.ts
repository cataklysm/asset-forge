import {
  ANALYZE_FILE_JOB,
  FILE_DOWNLOAD_JOB,
  IMAGE_GENERATE_JOB,
  SITE_CRAWL_JOB,
  analysisJobFields,
  analysisJobMode,
  downloadJobFields,
  type JobResult,
  type JobView,
} from '@assetforge/contracts';
import type { Job } from './job-types.js';

// The one mapping of a job to the row the Jobs screen and the analysis dialog show.

/** What a job view shows besides the job itself, read next to it. */
export interface JobViewDetails {
  /** The name of the job's file; null without one or when it is gone. */
  fileName: string | null;
  /** The generation an `image.generate` job runs, as it is recorded; null for other jobs or when it is gone. */
  generation: { providerName: string | null; model: string | null } | null;
  /** The stored result of the job; null for none. */
  result: JobResult | null;
}

/**
 * A job as a view: a download shows its address and host and no provider, a generation shows the provider and
 * model of its record, an extraction has no provider, and an analysis shows those of its payload.
 * Only an analysis job has a mode.
 *
 * @param job the job
 * @param details the file name, the generation and the result read next to it
 * @returns the view
 */
export function jobViewOf(job: Job, details: JobViewDetails): JobView {
  const isDownload = job.type === FILE_DOWNLOAD_JOB;
  return {
    ...providerFieldsOf(job, details),
    mode: job.type === ANALYZE_FILE_JOB ? analysisJobMode(job.payload) : null,
    id: job.id,
    type: job.type,
    status: job.status,
    attempt: job.attempt,
    fileId: job.fileId,
    fileName: details.fileName,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    runAfter: job.runAfter,
    // Download and extraction lanes identify hosts, never providers.
    providerId: isDownload || job.type === SITE_CRAWL_JOB ? null : job.lane,
    ...(isDownload ? downloadJobFields(job.payload) : { url: null, host: null }),
    result: details.result,
  };
}

/**
 * The provider name and model a view shows.
 *
 * @param job the job
 * @param details the generation read next to it
 * @returns the provider name and the model
 */
function providerFieldsOf(job: Job, details: JobViewDetails): { providerName: string | null; model: string | null } {
  if (job.type === IMAGE_GENERATE_JOB) {
    return { providerName: details.generation?.providerName ?? null, model: details.generation?.model ?? null };
  }
  if (job.type === FILE_DOWNLOAD_JOB) return { providerName: null, model: null };
  return analysisJobFields(job.payload);
}
