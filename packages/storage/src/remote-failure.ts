import { RemoteFileError, type RemoteFileFailure } from '@assetforge/core';

/**
 * A failure of the URL source without a cause: a cause could carry the URL or an address.
 *
 * @param kind the kind of failure the download handler maps to its job error code
 * @param retryAfterMs the wait a throttled answer asked for; null for every other failure
 * @returns the typed failure
 */
export function failure(kind: RemoteFileFailure, retryAfterMs: number | null = null): RemoteFileError {
  return new RemoteFileError(kind, retryAfterMs);
}
