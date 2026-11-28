/** The Jobs screen (JobsScreen, JobTable). */
export const JOBS_TITLE = 'Jobs';
export const JOBS_COUNT_TITLE = 'Jobs in this workspace';
export const CANCEL_ALL_LABEL = 'Cancel all';
export const RETRY_FAILED_LABEL = 'Retry failed';
export const CLEAR_FINISHED_LABEL = 'Clear finished';
export const NO_JOBS = 'No jobs';
export const ALL_STATUSES = 'All';
export const JOBS_STATUS_LABEL = 'Status';
export const CANCEL_JOB_LABEL = 'Cancel job';
export const RETRY_JOB_LABEL = 'Retry job';
export const JOBS_ACTIONS_HEADER = 'Actions';
/** The column headers of the job table before the provider column. */
export const JOBS_TYPE_HEADER = 'Job';
export const JOBS_FILE_HEADER = 'File';
/** The column headers of the job table after the provider column. */
export const JOBS_STATUS_HEADER = 'Status';
export const JOBS_ATTEMPT_HEADER = 'Attempt';
export const JOBS_CREATED_HEADER = 'Created';
export const JOBS_ERROR_HEADER = 'Error';

/**
 * 'Next try at 28.11.2026, 10:15'.
 *
 * @param time the formatted time of the next attempt
 * @returns the tooltip of a job waiting to be retried
 */
export function nextTryTitle(time: string): string {
  return `Next try at ${time}`;
}
