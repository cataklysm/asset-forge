import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { call } from './api';

export interface TrashState {
  /** The number of files in the trash; null until the first answer. */
  count: number | null;
  /** Loads the count again (after a delete, restore or purge). */
  refresh(): void;
}

const INERT: TrashState = { count: null, refresh: () => {} };

const TrashContext = createContext<TrashState>(INERT);

/**
 * Loads `trash:summary` on mount and on every `refresh()`, one request at a time: a refresh while
 * a request runs loads once more after it. A failed request keeps the last count and is not reported.
 */
export function TrashProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState<number | null>(null);
  const control = useRef<{ load(): void } | null>(null);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let again = false;

    function load() {
      if (disposed) return;
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      again = false;
      call('trash:summary', {})
        .then(
          (summary) => {
            if (!disposed) setCount(summary.count);
          },
          // The last count stays.
          () => {},
        )
        .finally(() => {
          inFlight = false;
          if (again) load();
        });
    }

    control.current = { load };
    load();
    return () => {
      disposed = true;
      control.current = null;
    };
  }, []);

  const refresh = useCallback(() => control.current?.load(), []);
  const value = useMemo<TrashState>(() => ({ count, refresh }), [count, refresh]);
  return <TrashContext.Provider value={value}>{children}</TrashContext.Provider>;
}

/** The trash count of the surrounding `TrashProvider`; outside one no count and a no-op refresh. */
export function useTrash(): TrashState {
  return useContext(TrashContext);
}
