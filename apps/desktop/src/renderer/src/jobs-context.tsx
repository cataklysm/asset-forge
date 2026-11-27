import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Changes, JobSummary } from '@assetforge/contracts';
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

type ChangeListener = (changes: Changes) => void;

/** Subscribes to the change answers; returns the unsubscribe function. Stable, so listening never re-renders. */
type Subscribe = (listener: ChangeListener) => () => void;

const ChangesContext = createContext<Subscribe>(() => () => {});

interface Polled {
  summary: JobSummary | null;
  changeToken: number;
  resultToken: number;
}

const samePaused = (a: JobSummary['paused'], b: JobSummary['paused']) =>
  a.length === b.length &&
  a.every(
    (p, i) => p.providerId === b[i]!.providerId && p.providerName === b[i]!.providerName && p.reason === b[i]!.reason,
  );

const samePausedHosts = (a: JobSummary['pausedHosts'], b: JobSummary['pausedHosts']) =>
  a.length === b.length && a.every((p, i) => p.host === b[i]!.host && p.reason === b[i]!.reason);

/** Every count by value, and both pause lists entry by entry (each poll parses new objects). */
export const sameSummary = (a: JobSummary, b: JobSummary) =>
  (Object.keys(a) as (keyof JobSummary)[]).every((key) =>
    key === 'paused'
      ? samePaused(a.paused, b.paused)
      : key === 'pausedHosts'
        ? samePausedHosts(a.pausedHosts, b.pausedHosts)
        : a[key] === b[key],
  );

/**
 * Polls `jobs:summary` on mount and every `JOB_POLL_MS` while mounted, one request at a time.
 * A failed poll (e.g. the workspace closed meanwhile) keeps the last state, is not reported and
 * the next tick polls again.
 */
export function JobsProvider({ children }: { children: ReactNode }) {
  const [polled, setPolled] = useState<Polled>({ summary: null, changeToken: 0, resultToken: 0 });
  const control = useRef<{ poll(): void } | null>(null);
  const listeners = useRef(new Set<ChangeListener>());

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    // A refresh while a poll runs: poll again as soon as it ends.
    let again = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // `changes` of the last answered summary; null before the first one.
    let lastChanges: number | null = null;
    // The cursor of the last change answer; null asks for a fresh one (answered with `reset`).
    let cursor: string | null = null;
    // A change request failed: the next poll asks again with the same cursor, so nothing is lost.
    let owed = false;

    function deliver(changes: Changes) {
      for (const listener of [...listeners.current]) {
        try {
          listener(changes);
        } catch {
          // One listener failing must not keep the others from the answer.
        }
      }
    }

    /** Asks `changes:since` once and hands the answer to every listener; a failure keeps the cursor. */
    function readChanges(): Promise<void> {
      return call('changes:since', { cursor }).then(
        (changes) => {
          if (disposed) return;
          cursor = changes.cursor;
          owed = false;
          deliver(changes);
        },
        () => {
          owed = true;
        },
      );
    }

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
            const changed = lastChanges === null || next.changes !== lastChanges;
            lastChanges = next.changes;
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
            // Inside the poll cycle: the next poll is scheduled once this request has settled.
            return changed || owed ? readChanges() : undefined;
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

  const subscribe = useCallback<Subscribe>((listener) => {
    const set = listeners.current;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }, []);

  return (
    <ChangesContext.Provider value={subscribe}>
      <JobsContext.Provider value={value}>{children}</JobsContext.Provider>
    </ChangesContext.Provider>
  );
}

/**
 * Calls `listener` with every change answer while mounted; the latest listener is used, the subscription is
 * stable. The answers come from `changes:since`, asked once after every poll in which `changes` moved and after
 * the first one (which answers `reset`); delivering them sets no React state. Outside a `JobsProvider` it never
 * calls.
 */
export function useChanges(listener: (changes: Changes) => void): void {
  const subscribe = useContext(ChangesContext);
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => subscribe((changes) => latest.current(changes)), [subscribe]);
}

/** The job state of the surrounding `JobsProvider`; outside one the empty state with a no-op refresh. */
export function useJobs(): JobState {
  return useContext(JobsContext);
}
