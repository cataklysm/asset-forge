import type { JobResult, JobStatus } from '@assetforge/contracts';
import { ALREADY_PRESENT_LABEL, FILTERED_KIND_LABEL, FILTERED_LABEL, FILTERED_SIZE_LABEL } from './import';
import { NO_PROVIDER } from './providers';

/** In the order of the status filter. */
export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  retry_wait: 'Retrying',
  waiting_remote: 'Waiting',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * The label of a job status.
 *
 * @param status the technical job status
 * @returns its entry of `JOB_STATUS_LABELS`
 */
export function jobStatusLabel(status: JobStatus): string {
  return JOB_STATUS_LABELS[status];
}

/** The banner of a paused job queue. */
export const RESUME_LABEL = 'Resume';
export const RESUME_TITLE = 'Continue the queued jobs';

/** Moving waiting jobs to another provider (MoveJobsDialog), the pause banner and the Jobs screen. */
export const MOVE_JOBS_LABEL = 'Move jobs';
export const MOVE_JOBS_TITLE = 'Moves the waiting jobs of a provider to another one';
export const MOVE_LABEL = 'Move';
export const MOVE_FROM = 'From';
export const MOVE_TO = 'To';
/**
 * '3 waiting'.
 *
 * @param n the number of waiting jobs
 * @returns the count line
 */
export const WAITING_COUNT = (n: number) => `${n} waiting`;
export const NO_WAITING_JOBS = 'No waiting jobs';
export const COUNTING_WAITING_JOBS = 'The waiting jobs are being counted';
export const JOBS_PROVIDER_HEADER = 'Provider';
export const ALL_PROVIDERS = 'All providers';
export const REMOVED_PROVIDER = 'Removed provider';

/**
 * The name of a job lane: its stored name, else `No provider` for id null and `Removed provider` otherwise.
 *
 * @param id the lane's provider id, or null for a job without a provider
 * @param name the stored provider name, or null when the provider is gone
 * @returns the name to show
 */
export function laneLabel(id: string | null, name: string | null): string {
  return name ?? (id === null ? NO_PROVIDER : REMOVED_PROVIDER);
}

/** The status text of a succeeded job that names a result, in place of `Succeeded`. */
export const JOB_RESULT_LABELS: Record<JobResult, string> = {
  already_present: ALREADY_PRESENT_LABEL,
  filtered: FILTERED_LABEL,
  filtered_kind: FILTERED_KIND_LABEL,
  filtered_size: FILTERED_SIZE_LABEL,
};

/** The type column of the Jobs screen. */
export const JOB_TYPE_LABELS: Record<string, string> = {
  'vision.analyze_file': 'Analysis',
  'image.generate': 'Generation',
  'file.download': 'Download',
};
