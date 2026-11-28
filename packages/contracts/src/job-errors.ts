import { z } from 'zod';

/** Why a job failed; a job row and the IPC answer carry only the code and its fixed message. */
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
  'download_browser_check',
  'download_duplicate_gone',
]);
/** Why a job failed. */
export type JobErrorCode = z.infer<typeof JobErrorCodeSchema>;

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
  download_browser_check: 'The site asks for a browser check',
  download_duplicate_gone: 'The file with the same content was deleted meanwhile',
};

/** The codes a job is run again for, while it has attempts left. */
const RETRYABLE: ReadonlySet<JobErrorCode> = new Set([
  'provider_unreachable',
  'provider_timeout',
  'provider_unavailable',
  'invalid_response',
  'download_unreachable',
  'download_unavailable',
  'download_throttled',
  // A duplicate purged during the download: another run imports the body as a new file.
  'download_duplicate_gone',
]);

/**
 * Whether a failure is worth another attempt.
 *
 * @param code the code the job failed with
 * @returns true for a passing failure of the provider or the server; false for everything a repeat would not change
 */
export function isRetryableJobError(code: JobErrorCode): boolean {
  return RETRYABLE.has(code);
}
