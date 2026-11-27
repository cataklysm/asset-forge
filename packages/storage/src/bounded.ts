import { failure } from './remote-failure.js';

/**
 * A promise bounded by an abort signal and a deadline.
 *
 * @param promise the work to wait for
 * @param signal rejects the result with its reason once it aborts
 * @param until the time (ms since the epoch) after which the result rejects `unreachable`
 * @returns the value of `promise`; its failure becomes `unreachable` without a cause
 */
export function bounded<T>(promise: Promise<T>, signal: AbortSignal, until: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // A listener added to an aborted signal never fires.
    if (signal.aborted) {
      promise.catch(() => {});
      reject(signal.reason);
      return;
    }
    let finished = false;
    const finish = (settle: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    const timer = setTimeout(() => finish(() => reject(failure('unreachable'))), Math.max(0, until - Date.now()));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(failure('unreachable'))),
    );
  });
}
