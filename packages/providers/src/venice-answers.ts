import type { JobErrorCode } from '@assetforge/contracts';

/** Venice sets this header to `true` when it refused the content. */
const VIOLATION_HEADER = 'x-venice-is-content-violation';

/** Codes that mean the connection was never made, so nothing was sent and nothing can have been charged. */
const NOTHING_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * Whether a failed fetch never made its connection.
 *
 * @param error what the fetch threw
 * @returns true when a `NOTHING_SENT` code appears anywhere in the cause chain (or in the attempts of an
 *   `AggregateError`)
 */
export function nothingSent(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 32) {
    const current = queue.shift();
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const { code, cause, errors } = current as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof code === 'string' && NOTHING_SENT.has(code)) return true;
    queue.push(cause);
    if (Array.isArray(errors)) queue.push(...(errors as unknown[]));
  }
  return false;
}

/**
 * Whether an answer is a redirect, which is never followed.
 *
 * @param response the answer of a fetch with `redirect: 'manual'`
 * @returns true for an opaque redirect or a 3xx status
 */
function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
}

/**
 * The code of an edit or upscale answer. A request that may have been charged and did not deliver is
 * `provider_outcome_unknown` and is never repeated.
 *
 * @param response the answer
 * @returns the failure code, or null when the answer can be used
 */
export function paidCode(response: Response): JobErrorCode | null {
  if (response.headers.get(VIOLATION_HEADER)?.trim().toLowerCase() === 'true') return 'provider_content_refused';
  if (isRedirect(response)) return 'provider_rejected';
  const status = response.status;
  if (response.ok) return null;
  if (status === 401 || status === 403) return 'provider_unauthorized';
  if (status === 402) return 'provider_insufficient_balance';
  if (status === 422) return 'provider_content_refused';
  if (status === 429 || status === 503) return 'provider_unavailable';
  if (status >= 400 && status < 500) return 'provider_rejected';
  return 'provider_outcome_unknown';
}

/**
 * The code of a model list answer (not charged).
 *
 * @param response the answer
 * @returns the failure code, or null when the answer can be used
 */
export function listCode(response: Response): JobErrorCode | null {
  if (isRedirect(response)) return 'provider_rejected';
  if (response.ok) return null;
  if (response.status === 401 || response.status === 403) return 'provider_unauthorized';
  if (response.status === 429 || response.status >= 500) return 'provider_unavailable';
  return 'provider_rejected';
}

/**
 * The length an answer declares.
 *
 * @param response the answer
 * @returns the `content-length` as a number; null when it is missing or not a number
 */
export function declaredLength(response: Response): number | null {
  const header = response.headers.get('content-length');
  if (header === null) return null;
  const value = Number(header);
  return Number.isFinite(value) ? value : null;
}
