/** The largest file one download stores (500 MiB). */
export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
/** How long a download waits for the response headers. */
export const DOWNLOAD_HEADER_TIMEOUT_MS = 30_000;
/** How long a download waits without receiving data. */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
/** How long one download may take in total (30 min). */
export const DOWNLOAD_TOTAL_TIMEOUT_MS = 1_800_000;
/** How many redirects one download follows. */
export const MAX_DOWNLOAD_REDIRECTS = 5;
/** The free space a download leaves on the storage volume beyond the announced length (2 GiB). */
export const DOWNLOAD_FREE_SPACE_RESERVE = 2 * 1024 ** 3;
/** The shortest wait a throttled download takes. */
export const RETRY_AFTER_MIN_MS = 5_000;
/** The longest wait a throttled download takes. */
export const RETRY_AFTER_MAX_MS = 900_000;
/** The wait of a throttled download when the server gave none. */
export const RETRY_AFTER_DEFAULT_MS = 60_000;

/**
 * The wait of a throttled download: the server's wait clamped to 5 s – 15 min, 60 s when it gave none.
 *
 * @param retryAfterMs the wait the server asked for, in milliseconds; null when it gave none
 * @returns the wait in milliseconds
 */
export function clampRetryAfterMs(retryAfterMs: number | null): number {
  if (retryAfterMs === null || Number.isNaN(retryAfterMs)) return RETRY_AFTER_DEFAULT_MS;
  return Math.min(Math.max(retryAfterMs, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}
