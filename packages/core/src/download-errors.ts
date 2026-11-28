import type { JobErrorCode } from '@assetforge/contracts';
import { JobError } from './jobs.js';
import { RemoteFileError, type RemoteFileFailure } from './ports.js';
import { clampRetryAfterMs } from './url-import.js';

// The job errors of the `file.download` job. None carries a cause: a cause could hold the URL.

/** The job error code of each kind of source failure. */
const FAILURE_CODES: Readonly<Record<RemoteFileFailure, JobErrorCode>> = {
  challenge: 'download_browser_check',
  unreachable: 'download_unreachable',
  unavailable: 'download_unavailable',
  throttled: 'download_throttled',
  blocked: 'download_blocked',
  not_found: 'download_not_found',
  rejected: 'download_rejected',
  address_refused: 'download_address_refused',
  too_large: 'download_too_large',
};

/**
 * The job error code of a source failure. A refusal names its HTTP status where that tells the user what to do:
 * 401 means the login is missing or expired, 403 that the server will not hand the file to this request.
 *
 * @param error the failure of the remote source
 * @returns the code stored on the job
 */
function errorCodeOf(error: RemoteFileError): JobErrorCode {
  if (error.failure === 'blocked' && error.status === 401) return 'download_unauthorized';
  if (error.failure === 'blocked' && error.status === 403) return 'download_forbidden';
  return FAILURE_CODES[error.failure];
}

/**
 * The job error of a source failure; only a throttled one carries a wait, and always one.
 *
 * @param error the failure of the remote source
 * @returns the job error, without a cause
 */
export function jobErrorOf(error: RemoteFileError): JobError {
  const retryAfterMs = error.failure === 'throttled' ? clampRetryAfterMs(error.retryAfterMs) : null;
  return new JobError(errorCodeOf(error), { retryAfterMs });
}

/**
 * The job error of whatever ended the source stream.
 *
 * @param error the error the stream failed with; null when it reported none
 * @returns the job error of a source failure, else `internal_error`
 */
export function streamFailure(error: unknown): JobError {
  return error instanceof RemoteFileError ? jobErrorOf(error) : new JobError('internal_error');
}
