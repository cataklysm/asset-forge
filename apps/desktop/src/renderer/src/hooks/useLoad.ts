import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from '../api';

// One load per dependency change, of which only the latest answer counts.

/** How a tracked promise ended. */
export interface LatestResult<T> {
  /** Whether a later promise was registered meanwhile; then neither value nor error is set. */
  stale: boolean;
  /** The value of a current promise that resolved. */
  value?: T;
  /** The reason of a current promise that rejected. */
  error?: unknown;
}

/**
 * Tracks promises so that only the most recently registered one is reported as current.
 *
 * @returns the tracker: registers a promise and answers how it ended
 */
export function latestOnly<T>(): (promise: Promise<T>) => Promise<LatestResult<T>> {
  let latest = 0;
  return async (promise) => {
    latest += 1;
    const mine = latest;
    try {
      const value = await promise;
      return mine === latest ? { stale: false, value } : { stale: true };
    } catch (error) {
      return mine === latest ? { stale: false, error } : { stale: true };
    }
  };
}

/**
 * Loads on mount, on every change of `dependencies` and on `reload()`; the data of the last success stays while a later
 * load runs or fails.
 *
 * @param load the request; the one of the latest render is used
 * @param dependencies the values that start a new load
 * @returns the data, the error message of the latest load, whether one runs, and a reload
 */
export function useLoad<T>(
  load: () => Promise<T>,
  dependencies: readonly unknown[],
): { data: T | null; error: string | null; loading: boolean; reload(): void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const track = useRef<((promise: Promise<T>) => Promise<LatestResult<T>>) | null>(null);
  track.current ??= latestOnly<T>();

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    let promise: Promise<T>;
    try {
      promise = loadRef.current();
    } catch (caught) {
      promise = Promise.reject(caught);
    }
    void track.current!(promise).then((result) => {
      if (!mounted || result.stale) return;
      if ('error' in result) {
        setError(describeError(result.error));
      } else {
        setData(result.value as T);
        setError(null);
      }
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, tick]);

  const reload = useCallback(() => setTick((count) => count + 1), []);
  return { data, error, loading, reload };
}
