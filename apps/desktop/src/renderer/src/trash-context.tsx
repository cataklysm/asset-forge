import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { call } from './api';

// The trash count shown in the navigation, loaded once and again after every change to the trash.

/** What the trash context offers. */
export interface TrashState {
  /** The number of files in the trash; null until the first answer. */
  count: number | null;
  /** Loads the count again (after a delete, restore or purge). */
  refresh(): void;
}

/** Outside a provider: no count, and a refresh that does nothing. */
const INERT: TrashState = { count: null, refresh: () => {} };

const TrashContext = createContext<TrashState>(INERT);

/** The delay before a failed `trash:summary` is tried again. */
export const TRASH_SUMMARY_RETRY_MS = 5000;

/** How many failures in a row are tried again before the count waits for the next refresh. */
export const TRASH_SUMMARY_RETRIES = 3;

/** The loader of the count: one request at a time, with a bounded retry. */
interface SummaryLoader {
  /** Loads the count, or marks one more load while a request runs. */
  load(): void;
  /** Stops loading: no further request, no retry, no count. */
  dispose(): void;
}

/**
 * The loader of `trash:summary`. A load while a request runs loads once more after it. A failed request keeps
 * the last count and is not reported; it is tried again after `TRASH_SUMMARY_RETRY_MS`, at most
 * `TRASH_SUMMARY_RETRIES` times in a row.
 *
 * @param setCount receives every answered count
 * @returns the loader
 */
function createSummaryLoader(setCount: (count: number) => void): SummaryLoader {
  let disposed = false;
  let inFlight = false;
  let again = false;
  // The failures in a row since the last answer, and the pending retry.
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  /** Loads the count, or marks one more load while a request runs. */
  function load() {
    if (disposed) return;
    if (inFlight) {
      again = true;
      return;
    }
    clearTimeout(retryTimer);
    inFlight = true;
    again = false;
    call('trash:summary', {})
      .then(
        (summary) => {
          failures = 0;
          if (!disposed) setCount(summary.count);
        },
        // The last count stays; the request is tried again a few times.
        () => {
          failures += 1;
          if (!disposed && failures <= TRASH_SUMMARY_RETRIES) retryTimer = setTimeout(load, TRASH_SUMMARY_RETRY_MS);
        },
      )
      .finally(() => {
        inFlight = false;
        if (again) load();
      });
  }

  return {
    load,
    dispose: () => {
      disposed = true;
      clearTimeout(retryTimer);
    },
  };
}

/**
 * Loads `trash:summary` on mount and on every `refresh()` through one `createSummaryLoader`.
 *
 * @param props the subtree that reads the count
 * @returns the provider
 */
export function TrashProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState<number | null>(null);
  const control = useRef<SummaryLoader | null>(null);

  useEffect(() => {
    const loader = createSummaryLoader(setCount);
    control.current = loader;
    loader.load();
    return () => {
      loader.dispose();
      control.current = null;
    };
  }, []);

  const refresh = useCallback(() => control.current?.load(), []);
  const value = useMemo<TrashState>(() => ({ count, refresh }), [count, refresh]);
  return <TrashContext.Provider value={value}>{children}</TrashContext.Provider>;
}

/**
 * The trash count of the surrounding `TrashProvider`; outside one no count and a no-op refresh.
 *
 * @returns the count and its refresh
 */
export function useTrash(): TrashState {
  return useContext(TrashContext);
}
