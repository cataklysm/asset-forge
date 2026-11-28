import type { JobErrorCode } from '@assetforge/contracts';

const VIOLATION_HEADER = 'x-venice-is-content-violation';

/** Codes that mean the connection was never made, so nothing was sent and nothing can have been charged. */
const NOTHING_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** True when a `NOTHING_SENT` code appears anywhere in the cause chain (or in the attempts of an `AggregateError`). */
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

export function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
}

/**
 * The code of an edit or upscale answer, or null when it can be used. A request that may have been charged
 * and did not deliver is `provider_outcome_unknown` and is never repeated.
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

/** The code of a model list answer (not charged), or null when it can be used. */
export function listCode(response: Response): JobErrorCode | null {
  if (isRedirect(response)) return 'provider_rejected';
  if (response.ok) return null;
  if (response.status === 401 || response.status === 403) return 'provider_unauthorized';
  if (response.status === 429 || response.status >= 500) return 'provider_unavailable';
  return 'provider_rejected';
}

/** Releases a body that will not be read. Failures are irrelevant: the answer is already decided. */
export async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignored
  }
}

export function declaredLength(response: Response): number | null {
  const header = response.headers.get('content-length');
  if (header === null) return null;
  const value = Number(header);
  return Number.isFinite(value) ? value : null;
}

export class ResponseTooLarge extends Error {}

/** Reads the body as UTF-8 and stops (cancelling the stream) once it exceeds `limit`. */
export async function readCapped(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try {
        await reader.cancel();
      } catch {
        // ignored
      }
      throw new ResponseTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
