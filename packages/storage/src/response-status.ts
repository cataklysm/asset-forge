import { clampRetryAfterMs, RemoteFileError } from '@assetforge/core';
import { failure } from './remote-failure.js';

/** The statuses a hop follows as a redirect (to its `Location`). */
export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The statuses that mean the server will not hand the file to this request. */
const BLOCKED_STATUSES = new Set([401, 403, 407, 451]);

/** The statuses that mean the file is not there. */
const NOT_FOUND_STATUSES = new Set([404, 410]);

/** The shape of an IMF-fixdate, e.g. `Sun, 06 Nov 1994 08:49:37 GMT`. */
const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** The headers of an answer that decide its failure besides the status. */
export interface StatusHeaders {
  /** The `Retry-After` header; undefined when absent. */
  retryAfter?: string | undefined;
  /** The `cf-mitigated` header; undefined when absent. */
  mitigated?: string | undefined;
}

/**
 * Whether a `cf-mitigated` header value marks a browser challenge.
 *
 * @param value the header's value; undefined when absent
 * @returns true for `challenge`, trimmed and in any case
 */
export function isChallenge(value: string | undefined): boolean {
  return value !== undefined && value.trim().toLowerCase() === 'challenge';
}

/**
 * The failure of an answer that is no file and no redirect. A browser challenge (`cf-mitigated: challenge`) wins
 * over the status, which it keeps.
 *
 * @param status the HTTP status
 * @param headers `Retry-After` and `cf-mitigated` of the answer
 * @returns the typed failure, without a cause
 */
export function statusFailure(status: number, headers: StatusHeaders): RemoteFileError {
  if (isChallenge(headers.mitigated)) return new RemoteFileError('challenge', null, { status });
  if (status === 429 || status === 503) return failure('throttled', retryAfterMs(headers.retryAfter));
  if (BLOCKED_STATUSES.has(status)) return new RemoteFileError('blocked', null, { status });
  if (NOT_FOUND_STATUSES.has(status)) return failure('not_found');
  if (status === 408 || (status >= 500 && status <= 599)) return failure('unavailable');
  return failure('rejected');
}

/**
 * The wait a throttled answer asks for.
 *
 * @param value the `Retry-After` header: integer seconds or an IMF-fixdate
 * @returns the wait in ms, clamped; the default wait when absent or of any other shape
 */
function retryAfterMs(value: string | undefined): number {
  if (value === undefined) return clampRetryAfterMs(null);
  const text = value.trim();
  if (/^\d+$/.test(text)) return clampRetryAfterMs(Number(text) * 1000);
  if (!HTTP_DATE.test(text)) return clampRetryAfterMs(null);
  const at = Date.parse(text);
  return clampRetryAfterMs(Number.isNaN(at) ? null : Math.max(0, at - Date.now()));
}
