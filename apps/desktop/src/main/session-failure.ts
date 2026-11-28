import { RemoteFileError } from '@assetforge/core';

/**
 * A failure of a session download without a cause: a cause could carry the URL or an address.
 *
 * @param kind the kind of failure
 * @returns the error the download rejects with
 */
export function failure(kind: 'rejected' | 'unreachable' | 'address_refused' | 'too_large'): RemoteFileError {
  return new RemoteFileError(kind);
}
