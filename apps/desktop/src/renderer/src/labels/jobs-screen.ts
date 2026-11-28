// The Jobs screen (JobsScreen, JobTable).

/** The title of the Jobs screen. */
export const JOBS_TITLE = 'Jobs';
/** Tooltip of the job count. */
export const JOBS_COUNT_TITLE = 'Jobs in this workspace';
/** Cancels every active job. */
export const CANCEL_ALL_LABEL = 'Cancel all';
/** Queues every failed job again. */
export const RETRY_FAILED_LABEL = 'Retry failed';
/** Removes the finished jobs from the list. */
export const CLEAR_FINISHED_LABEL = 'Clear finished';
/** Shown when the list has no job. */
export const NO_JOBS = 'No jobs';
/** The status filter option that shows every status. */
export const ALL_STATUSES = 'All';
/** The label of the status filter. */
export const JOBS_STATUS_LABEL = 'Status';
/** Cancels one job. */
export const CANCEL_JOB_LABEL = 'Cancel job';
/** Queues one failed job again. */
export const RETRY_JOB_LABEL = 'Retry job';
/** The header of the actions column. */
export const JOBS_ACTIONS_HEADER = 'Actions';
/** The header of the job type column, before the provider column. */
export const JOBS_TYPE_HEADER = 'Job';
/** The header of the file column, before the provider column. */
export const JOBS_FILE_HEADER = 'File';
/** The header of the status column, after the provider column. */
export const JOBS_STATUS_HEADER = 'Status';
/** The header of the attempt column. */
export const JOBS_ATTEMPT_HEADER = 'Attempt';
/** The header of the creation time column. */
export const JOBS_CREATED_HEADER = 'Created';
/** The header of the error column. */
export const JOBS_ERROR_HEADER = 'Error';

export { jobCount } from './counts';

/**
 * 'Next try at 28.11.2026, 10:15'.
 *
 * @param time the formatted time of the next attempt
 * @returns the tooltip of a job waiting to be retried
 */
export function nextTryTitle(time: string): string {
  return `Next try at ${time}`;
}
