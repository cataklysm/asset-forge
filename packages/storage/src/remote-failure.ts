import { RemoteFileError, type RemoteFileFailure } from '@assetforge/core';

/** A failure without a cause: a cause could carry the URL or an address. */
export function failure(kind: RemoteFileFailure, retryAfterMs: number | null = null): RemoteFileError {
  return new RemoteFileError(kind, retryAfterMs);
}
