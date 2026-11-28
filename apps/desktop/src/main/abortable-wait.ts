/**
 * Resolves after `ms`; rejects with the abort reason at once when `signal` aborts.
 *
 * @param ms how long to wait
 * @param signal ends the wait early
 * @returns a promise that resolves after the wait, or rejects with the signal's reason
 */
export function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
