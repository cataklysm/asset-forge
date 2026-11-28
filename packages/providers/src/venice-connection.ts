import type { JobErrorCode } from '@assetforge/contracts';
import type { VeniceImageOptions } from './venice-image.js';

/** What every Venice call needs: where to send it, how, and the options it was built with. */
export interface VeniceConnection {
  /** The base URL without trailing slashes. */
  base: string;
  /** The fetch in use; always called unbound. */
  fetchImpl: typeof fetch;
  /** The adapter's options: the time limit, the key supplier and the failure report. */
  options: VeniceImageOptions;
}

/**
 * Headers with the bearer key read now, or the code of the failure: a key supplier that throws is
 * `internal_error`, a key that cannot be sent cannot authenticate. Neither error is kept: both may quote the key.
 *
 * @param options the adapter's options, whose `apiKey` is asked
 * @returns the headers of one request, or the failure code
 */
export function authorizationHeaders(options: VeniceImageOptions): Headers | JobErrorCode {
  let key: string | null;
  try {
    key = options.apiKey();
  } catch {
    return 'internal_error';
  }
  try {
    const result = new Headers();
    if (key) result.set('authorization', `Bearer ${key}`);
    return result;
  } catch {
    return 'provider_unauthorized';
  }
}
