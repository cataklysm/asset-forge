import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Changes, JobSummary } from '@assetforge/contracts';
import { JobPoller } from './job-poller';

/** The pause between the end of one `jobs:summary` poll and the next. */
export const JOB_POLL_MS = 2000;

/** What the jobs context offers. */
export interface JobState {
  /** Null until the first answer. */
  summary: JobSummary | null;
  /** Queued + running + waiting; 0 without a summary. */
  active: number;
  /** Rises whenever a poll saw `changes` move. */
  changeToken: number;
  /** Polls now (after the user changed jobs). */
  refresh(): void;
}

/** The job state outside a provider. */
const EMPTY: JobState = { summary: null, active: 0, changeToken: 0, refresh: () => {} };

/** The polled job state. */
const JobsContext = createContext<JobState>(EMPTY);

/** Takes one change answer. */
type ChangeListener = (changes: Changes) => void;

/** Subscribes to the change answers; returns the unsubscribe function. Stable, so listening never re-renders. */
type Subscribe = (listener: ChangeListener) => () => void;

/** The subscription to the change answers. */
const ChangesContext = createContext<Subscribe>(() => () => {});

/** The state the poll answers build. */
interface Polled {
  summary: JobSummary | null;
  changeToken: number;
}

/**
 * Whether two provider pause lists are the same entry by entry.
 *
 * @param left one list
 * @param right the other list
 * @returns true when they are equal
 */
const samePaused = (left: JobSummary['paused'], right: JobSummary['paused']) =>
  left.length === right.length &&
  left.every(
    (pause, i) =>
      pause.providerId === right[i]!.providerId &&
      pause.providerName === right[i]!.providerName &&
      pause.reason === right[i]!.reason,
  );

/**
 * Whether two host pause lists are the same entry by entry.
 *
 * @param left one list
 * @param right the other list
 * @returns true when they are equal
 */
const samePausedHosts = (left: JobSummary['pausedHosts'], right: JobSummary['pausedHosts']) =>
  left.length === right.length &&
  left.every((pause, i) => pause.host === right[i]!.host && pause.reason === right[i]!.reason);

/**
 * Every count by value, and both pause lists entry by entry (each poll parses new objects).
 *
 * @param left one summary
 * @param right the other summary
 * @returns true when they are equal
 */
export const sameSummary = (left: JobSummary, right: JobSummary) =>
  (Object.keys(left) as (keyof JobSummary)[]).every((key) => sameField(left, right, key));

/**
 * Whether one field of two summaries is the same.
 *
 * @param left one summary
 * @param right the other summary
 * @param key the field
 * @returns true when it is equal
 */
function sameField(left: JobSummary, right: JobSummary, key: keyof JobSummary): boolean {
  if (key === 'paused') return samePaused(left.paused, right.paused);
  if (key === 'pausedHosts') return samePausedHosts(left.pausedHosts, right.pausedHosts);
  return left[key] === right[key];
}

/**
 * The polled state after a new summary: unchanged when the summary is the same, the change token raised
 * when `changes` moved.
 *
 * @param current the state so far
 * @param next the answered summary
 * @returns the new state, or `current` itself when nothing changed
 */
function nextPolled(current: Polled, next: JobSummary): Polled {
  const previous = current.summary;
  if (previous === null) return { ...current, summary: next };
  if (sameSummary(previous, next)) return current;
  const moved = next.changes !== previous.changes;
  return {
    summary: next,
    changeToken: current.changeToken + (moved ? 1 : 0),
  };
}

/**
 * Hands a change answer to every listener.
 *
 * @param listeners the subscribed listeners
 * @param changes the answer
 */
function deliver(listeners: ReadonlySet<ChangeListener>, changes: Changes): void {
  for (const listener of [...listeners]) {
    try {
      listener(changes);
    } catch {
      // One listener failing must not keep the others from the answer.
    }
  }
}

/**
 * Polls `jobs:summary` on mount and every `JOB_POLL_MS` while mounted, one request at a time.
 * A failed poll (e.g. the workspace closed meanwhile) keeps the last state, is not reported and
 * the next tick polls again.
 *
 * @param props.children the tree that reads the job state
 */
export function JobsProvider({ children }: { children: ReactNode }) {
  const [polled, setPolled] = useState<Polled>({ summary: null, changeToken: 0 });
  const control = useRef<{ poll(): void } | null>(null);
  const listeners = useRef(new Set<ChangeListener>());

  useEffect(() => {
    const poller = new JobPoller(
      {
        summarised: (next) => setPolled((current) => nextPolled(current, next)),
        changed: (changes) => deliver(listeners.current, changes),
      },
      JOB_POLL_MS,
    );
    control.current = poller;
    poller.poll();
    return () => {
      poller.dispose();
      control.current = null;
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
 *
 * @param listener takes each change answer
 */
export function useChanges(listener: (changes: Changes) => void): void {
  const subscribe = useContext(ChangesContext);
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => subscribe((changes) => latest.current(changes)), [subscribe]);
}

/**
 * The job state of the surrounding `JobsProvider`.
 *
 * @returns the state; outside a provider the empty state with a no-op refresh
 */
export function useJobs(): JobState {
  return useContext(JobsContext);
}
