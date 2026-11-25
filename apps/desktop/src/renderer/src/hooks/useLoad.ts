import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from '../api';

export interface LatestResult<T> {
  stale: boolean;
  value?: T;
  error?: unknown;
}

/** Tracks promises so that only the most recently registered one is reported as current. */
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

export function useLoad<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
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
    } catch (e) {
      promise = Promise.reject(e);
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
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
}
