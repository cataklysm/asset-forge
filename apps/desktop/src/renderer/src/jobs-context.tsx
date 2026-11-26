import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { JobSummary } from '@assetforge/contracts';
import { call } from './api';

export const JOB_POLL_MS = 2000;

export interface JobState {
  /** Null until the first answer. */
  summary: JobSummary | null;
  /** Queued + running + waiting; 0 without a summary. */
  active: number;
  /** Rises whenever a poll saw `changes` move. */
  changeToken: number;
  /** Rises whenever a poll saw `changes` move and `succeeded` rise. */
  resultToken: number;
  /** Polls now (after the user changed jobs). */
  refresh(): void;
}

const EMPTY: JobState = { summary: null, active: 0, changeToken: 0, resultToken: 0, refresh: () => {} };

const JobsContext = createContext<JobState>(EMPTY);

interface Polled {
  summary: JobSummary | null;
  changeToken: number;
  resultToken: number;
}

const sameSummary = (a: JobSummary, b: JobSummary) =>
  (Object.keys(a) as (keyof JobSummary)[]).every((key) => a[key] === b[key]);

/**
 * Polls `jobs:summary` on mount and every `JOB_POLL_MS` while mounted, one request at a time.
 * A failed poll (e.g. the workspace closed meanwhile) keeps the last state, is not reported and
 * the next tick polls again.
 */
export function JobsProvider({ children }: { children: ReactNode }) {
  const [polled, setPolled] = useState<Polled>({ summary: null, changeToken: 0, resultToken: 0 });
  const control = useRef<{ poll(): void } | null>(null);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    // A refresh while a poll runs: poll again as soon as it ends.
    let again = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function schedule(delay: number) {
      timer = setTimeout(poll, delay);
    }

    function poll() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (disposed) return;
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      again = false;
      call('jobs:summary', {})
        .then(
          (next) => {
            if (disposed) return;
            setPolled((current) => {
              const previous = current.summary;
              if (previous === null) return { ...current, summary: next };
              if (sameSummary(previous, next)) return current;
              const moved = next.changes !== previous.changes;
              return {
                summary: next,
                changeToken: current.changeToken + (moved ? 1 : 0),
                resultToken: current.resultToken + (moved && next.succeeded > previous.succeeded ? 1 : 0),
              };
            });
          },
          // The last state stays; the next tick tries again.
          () => {},
        )
        .finally(() => {
          inFlight = false;
          if (disposed) return;
          schedule(again ? 0 : JOB_POLL_MS);
        });
    }

    control.current = { poll };
    poll();
    return () => {
      disposed = true;
      control.current = null;
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  const refresh = useCallback(() => control.current?.poll(), []);

  const value = useMemo<JobState>(() => {
    const { summary } = polled;
    const active = summary === null ? 0 : summary.queued + summary.running + summary.waiting;
    return { ...polled, active, refresh };
  }, [polled, refresh]);

  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}

/** The job state of the surrounding `JobsProvider`; outside one the empty state with a no-op refresh. */
export function useJobs(): JobState {
  return useContext(JobsContext);
}
