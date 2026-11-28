// Asks a request again and again, one at a time, with a pause between an answer and the next request.

/** One running poller. */
interface Poller<T> {
  /** The request asked every time. */
  request(): Promise<T>;
  /** Receives every answer while the poller runs; a failed request is skipped. */
  onValue(value: T): void;
  /** The pause between the end of one request and the next one. */
  intervalMs: number;
  /** Whether the poller was stopped. */
  isStopped: boolean;
  /** The pending pause; null while a request runs. */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Asks once and schedules the next ask when the answer (or the failure) is in, unless stopped meanwhile.
 *
 * @param poller the poller
 */
function poll<T>(poller: Poller<T>): void {
  poller.timer = null;
  poller
    .request()
    .then(
      (value) => {
        if (!poller.isStopped) poller.onValue(value);
      },
      // The last value stays; the next tick asks again.
      () => {},
    )
    .finally(() => {
      if (!poller.isStopped) poller.timer = setTimeout(() => poll(poller), poller.intervalMs);
    });
}

/**
 * Starts polling: the first request goes out after one interval.
 *
 * @param request the request
 * @param onValue receives every answer until stopped
 * @param intervalMs the pause before the first request and after every answer
 * @returns stops the poller; an answer still in flight is dropped
 */
export function startPolling<T>(
  request: () => Promise<T>,
  onValue: (value: T) => void,
  intervalMs: number,
): () => void {
  const poller: Poller<T> = { request, onValue, intervalMs, isStopped: false, timer: null };
  poller.timer = setTimeout(() => poll(poller), intervalMs);
  return () => {
    poller.isStopped = true;
    if (poller.timer !== null) clearTimeout(poller.timer);
  };
}
