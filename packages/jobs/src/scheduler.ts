import { ResourceClassSchema, isRetryableJobError, type JobErrorCode, type ResourceClass } from '@assetforge/contracts';
import { JobError, type Job, type JobControl, type JobHandler, type JobRepository } from '@assetforge/core';
import type { PauseGate } from './pause-gate.js';

export const DEFAULT_LIMITS: Record<ResourceClass, number> = { cpu: 2, io: 2, local_gpu: 1, remote_api: 2 };
/** Runs per job, the first one included. */
export const MAX_ATTEMPTS = 3;
/** Delay before the second and before the third run. */
export const RETRY_DELAYS_MS = [5_000, 30_000] as const;

export interface Scheduler extends JobControl {
  /** Recovers jobs found `running`, then begins claiming. */
  start(): Promise<void>;
  /** Aborts running jobs, waits for them and puts the unfinished ones back to `queued`. */
  stop(): Promise<void>;
}

export interface SchedulerOptions {
  jobs: JobRepository;
  handlers: Record<string, JobHandler>;
  limits?: Record<ResourceClass, number>;
  now?(): Date;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  /** Called after every status change the scheduler made. Must not throw. */
  onChange?(): void;
  log?(message: string, cause: unknown): void;
  /** Outlives the scheduler: a lane it reports paused claims nothing, and every run end is recorded in it. */
  pause?: PauseGate;
}

interface ActiveRun {
  resourceClass: ResourceClass;
  lane: string | null;
  controller: AbortController;
  cancelled: boolean;
  /** The handler has settled; a cancel no longer changes the outcome. */
  settled: boolean;
  done: Promise<void>;
}

type Outcome = { ok: true } | { ok: false; error: unknown };

/**
 * Event-driven job scheduler: it looks for work on `start`, on `wake`, when a job ends and when the timer for the
 * earliest `run_after` fires. Claims first in, first out per resource class and lane, up to the class's limit in
 * every lane; jobs without a lane share the lane `null`.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const { jobs, handlers } = options;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const log = options.log ?? ((message: string, cause: unknown) => console.error(message, cause));
  const changed = () => {
    try {
      options.onChange?.();
    } catch (cause) {
      log('Job change listener failed', cause);
    }
  };

  const typesOf = new Map<ResourceClass, string[]>(
    ResourceClassSchema.options.map((rc) => [rc, Object.keys(handlers).filter((type) => handlers[type]!.resourceClass === rc)]),
  );

  const active = new Map<string, ActiveRun>();
  let started = false;
  let stopping = false;
  let startDone: Promise<void> = Promise.resolve();
  let starting: Promise<void> | null = null;
  let passDone: Promise<void> = Promise.resolve();
  let passing = false;
  let passAgain = false;
  let timer: { handle: unknown } | null = null;
  const pendingCancels = new Set<Promise<void>>();

  const iso = () => now().toISOString();
  /** Running jobs of the class per lane. */
  const runningOf = (rc: ResourceClass) => {
    const n = new Map<string | null, number>();
    for (const run of active.values()) if (run.resourceClass === rc) n.set(run.lane, (n.get(run.lane) ?? 0) + 1);
    return n;
  };

  /** Lanes the class may not claim from: the paused ones and those already running the class's limit. */
  const excludedLanes = (rc: ResourceClass): (string | null)[] => {
    const excluded = new Set<string | null>(options.pause ? options.pause.paused(rc).map((p) => p.lane) : []);
    for (const [lane, n] of runningOf(rc)) if (n >= limits[rc]) excluded.add(lane);
    return [...excluded];
  };

  /** Tells the gate how a run ended, before the next pass decides whether its class may claim again. */
  function record(job: Job, run: ActiveRun, outcome: Outcome): void {
    if (!options.pause) return;
    // Same order as `settle`: a cancel wins, then success; a run released on stop or a foreign error is 'other'.
    let result: JobErrorCode | 'ok' | 'other' = 'other';
    if (!run.cancelled) {
      if (outcome.ok) result = 'ok';
      else if (!stopping && outcome.error instanceof JobError) result = outcome.error.code;
    }
    try {
      options.pause.record(job.resourceClass, job.lane, result);
    } catch (cause) {
      log('Job pause gate failed', cause);
    }
  }

  function cancelTimer(): void {
    if (timer) clearTimer(timer.handle);
    timer = null;
  }

  async function pass(): Promise<void> {
    let earliest: number | null = null;
    for (const [rc, types] of typesOf) {
      if (types.length === 0 || limits[rc] <= 0) continue;
      // The excluded lanes are worked out again before every claim: a run may end or a lane pause in between.
      for (;;) {
        if (stopping) return;
        const job = await jobs.claimNext({ resourceClass: rc, types, now: iso(), excludeLanes: excludedLanes(rc) });
        if (!job) break;
        if (stopping) {
          await jobs.release(job.id, iso());
          return;
        }
        launch(job);
        changed();
      }
      if (stopping) return;
      // A full lane gets a pass when one of its jobs ends and a paused one when the caller wakes the scheduler after
      // resume; only the other lanes need the timer.
      const next = await jobs.nextRunAfter(types, excludedLanes(rc));
      if (next !== null) earliest = Math.min(earliest ?? Infinity, Date.parse(next));
    }
    if (stopping) return;
    cancelTimer();
    if (earliest !== null) {
      const slot: { handle: unknown } = { handle: null };
      slot.handle = setTimer(() => {
        if (timer !== slot) return;
        timer = null;
        wake();
      }, Math.max(earliest - now().getTime(), 0));
      timer = slot;
    }
  }

  async function passes(): Promise<void> {
    passing = true;
    try {
      do {
        passAgain = false;
        try {
          await pass();
        } catch (cause) {
          log('Job scheduler pass failed', cause);
        }
      } while (passAgain && !stopping);
    } finally {
      passing = false;
    }
  }

  function wake(): void {
    if (!started || stopping) return;
    if (passing) {
      passAgain = true;
      return;
    }
    passDone = passes();
  }

  function launch(job: Job): void {
    const handler = handlers[job.type]!;
    const run: ActiveRun = {
      resourceClass: job.resourceClass,
      lane: job.lane,
      controller: new AbortController(),
      cancelled: false,
      settled: false,
      done: Promise.resolve(),
    };
    active.set(job.id, run);
    run.done = (async () => {
      let outcome: Outcome;
      try {
        await handler.run(job, run.controller.signal);
        outcome = { ok: true };
      } catch (error) {
        outcome = { ok: false, error };
      }
      run.settled = true;
      try {
        await settle(job, run, outcome);
      } catch (cause) {
        log('Job outcome could not be stored', cause);
      }
      active.delete(job.id);
      changed();
      wake();
    })();
  }

  /** Stores the outcome of a run. `job.attempt` is the value after the claim. */
  async function settle(job: Job, run: ActiveRun, outcome: Outcome): Promise<void> {
    record(job, run, outcome);
    const at = iso();
    const finish = async (status: 'succeeded' | 'failed' | 'cancelled', errorCode: JobErrorCode | null) => {
      await jobs.finish(job.id, { status, errorCode, now: at });
    };
    if (run.cancelled) return finish('cancelled', null);
    if (outcome.ok) return finish('succeeded', null);
    if (stopping) {
      await jobs.release(job.id, at);
      return;
    }
    const { error } = outcome;
    if (!(error instanceof JobError)) {
      log(`Job ${job.id} of type ${job.type} failed`, error);
      return finish('failed', 'internal_error');
    }
    if (!isRetryableJobError(error.code) || job.attempt >= MAX_ATTEMPTS) return finish('failed', error.code);
    const delay = RETRY_DELAYS_MS[Math.min(job.attempt, RETRY_DELAYS_MS.length) - 1] ?? RETRY_DELAYS_MS[1];
    const runAfter = new Date(now().getTime() + delay).toISOString();
    await jobs.scheduleRetry(job.id, { errorCode: error.code, runAfter, now: at });
  }

  async function recover(): Promise<void> {
    let n = 0;
    for (const job of await jobs.listByStatus('running')) {
      if (stopping) break;
      const changedRow =
        handlers[job.type]?.onInterrupted === 'fail'
          ? await jobs.finish(job.id, { status: 'failed', errorCode: 'internal_error', now: iso() })
          : await jobs.release(job.id, iso());
      if (changedRow) n++;
    }
    if (n > 0) changed();
  }

  return {
    async start() {
      if (stopping) return;
      // Set synchronously, so a second call while recovery runs waits for it instead of recovering again.
      if (starting) return starting;
      startDone = starting = (async () => {
        try {
          await recover();
        } catch (cause) {
          log('Interrupted jobs could not be recovered', cause);
        }
        if (stopping) return;
        started = true;
        wake();
        await passDone;
      })();
      await starting;
    },

    wake,

    async cancel(jobId) {
      if (stopping) return;
      const run = active.get(jobId);
      if (run) {
        if (run.settled) return;
        run.cancelled = true;
        run.controller.abort();
        return;
      }
      const pending = (async () => {
        if ((await jobs.cancelPending({ id: jobId, now: iso() })) > 0) changed();
      })();
      pendingCancels.add(pending);
      try {
        await pending;
      } finally {
        pendingCancels.delete(pending);
      }
    },

    async stop() {
      stopping = true;
      cancelTimer();
      for (const run of active.values()) run.controller.abort();
      await startDone;
      await passDone;
      // A pass that was in progress may have launched a run before it saw `stopping`.
      for (const run of active.values()) run.controller.abort();
      await Promise.allSettled([...pendingCancels]);
      await Promise.all([...active.values()].map((run) => run.done));
    },
  };
}
