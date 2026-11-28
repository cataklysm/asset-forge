// The time limits of the model lists, shared by every adapter.

/** Upper bound for a whole model-list call of any adapter. */
export const LIST_MODELS_TIMEOUT_MS = 10_000;

/**
 * Largest delay `setTimeout` accepts; a longer one fires at once. A request whose real bound is an outer deadline
 * passes this as its own limit.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * The bound of a model-list call.
 *
 * @param listTimeoutMs the configured bound; undefined, not finite or below 1 takes the default
 * @param timeoutMs the entry's request time limit
 * @returns the configured bound capped at `MAX_TIMER_MS`, or `min(timeoutMs, LIST_MODELS_TIMEOUT_MS)`
 */
export function listTimeoutOf(listTimeoutMs: number | undefined, timeoutMs: number): number {
  if (listTimeoutMs === undefined || !Number.isFinite(listTimeoutMs) || listTimeoutMs < 1) {
    return Math.min(timeoutMs, LIST_MODELS_TIMEOUT_MS);
  }
  return Math.min(listTimeoutMs, MAX_TIMER_MS);
}
