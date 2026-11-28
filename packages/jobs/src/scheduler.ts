import {
  MAX_ATTEMPTS,
  ResourceClassSchema,
  isRetryableJobError,
  type JobErrorCode,
  type ResourceClass,
} from '@assetforge/contracts';
import {
  JobError,
  type CancelOptions,
  type Job,
  type JobControl,
  type JobHandler,
  type JobOutcome,
  type JobRepository,
} from '@assetforge/core';
import { LaneHolds } from './lane-holds.js';
import { LaneRotation } from './lane-rotation.js';
import { LeftoverRows } from './recovery-steps.js';
import type { PauseGate } from './pause-gate.js';

/** Running jobs per lane of a class, unless `laneLimit` answers another limit for the lane. */
export const DEFAULT_LIMITS: Record<ResourceClass, number> = { cpu: 2, io: 2, local_gpu: 1, remote_api: 2 };
/** Running jobs per class across all its lanes; a class without an entry is bounded only per lane. */
export const DEFAULT_TOTALS: Partial<Record<ResourceClass, number>> = { io: 4 };
export { MAX_ATTEMPTS };
/** Delay before the second and before the third run. */
export const RETRY_DELAYS_MS = [5_000, 30_000] as const;
/**
 * How long `stop` waits for aborted handlers. A handler still running then is given up: its row stays `running` for
 * the recovery of the next start, and its late end is ignored.
 */
export const STOP_DEADLINE_MS = 10_000;

/** The job control of the host plus the start and the stop of the scheduler. */
export interface Scheduler extends JobControl {
  /**
   * Recovers jobs found `running`, then begins claiming.
   *
   * @returns resolves once the recovery and the first pass are done
   */
  start(): Promise<void>;
  /**
   * Aborts running jobs and waits for them. An unfinished one goes back to `queued`, or ends `failed` with its
   * handler's `interruptedCode` under `onInterrupted: 'fail'`. A handler that has not ended after
   * `STOP_DEADLINE_MS` is given up: its row stays `running` for the recovery of the next start, and nothing of its
   * late end is written.
   *
   * @returns resolves once every run, pass and cancel has ended
   */
  stop(): Promise<void>;
}

/** What `createScheduler` is configured with; everything but the repository and the handlers has a default. */
export interface SchedulerOptions {
  /** The job rows the scheduler claims, finishes, retries and cancels. */
  jobs: JobRepository;
  /** The handler of every job type, by type. */
  handlers: Record<string, JobHandler>;
  /** Running jobs per lane of a class. Default `DEFAULT_LIMITS`. */
  limits?: Record<ResourceClass, number>;
  /** Running jobs per class across all its lanes. Default `DEFAULT_TOTALS`. */
  totals?: Partial<Record<ResourceClass, number>>;
  /**
   * The clock; default the system clock.
   *
   * @returns the current time
   */
  now?(): Date;
  /**
   * Starts a timer; default `setTimeout`.
   *
   * @param callback called once when the timer fires
   * @param delayMs the delay in milliseconds
   * @returns the handle `clearTimer` takes
   */
  setTimer?(callback: () => void, delayMs: number): unknown;
  /**
   * Clears a timer started by `setTimer`; default `clearTimeout`.
   *
   * @param handle the handle `setTimer` answered
   */
  clearTimer?(handle: unknown): void;
  /**
   * Called after every status change the scheduler made, with the id of the job whose row changed; null when a
   * cancel or a lane hold changed several rows at once. Must not throw.
   *
   * @param jobId the job whose row changed, or null for several rows
   */
  onChange?(jobId: string | null): void;
  /**
   * Logs a failure the scheduler swallowed; default `console.error`.
   *
   * @param message a fixed description of what failed
   * @param cause the error that was caught
   */
  log?(message: string, cause: unknown): void;
  /** Outlives the scheduler: a lane it reports paused claims nothing, and every run end is recorded in it. */
  pause?: PauseGate;
  /**
   * The limit of one lane of a class, asked before every claim. An integer of at least 1 replaces the class limit
   * for that lane; any other answer, or a throw, keeps the class limit. Class totals still apply.
   *
   * @param resourceClass the class of the lane
   * @param lane the lane, null for jobs without one
   * @returns the lane's own limit, or anything else to keep the class limit
   */
  laneLimit?(resourceClass: ResourceClass, lane: string | null): number | undefined;
}

/** One job the scheduler has launched and not yet finished. */
interface ActiveRun {
  /** The class the job was claimed in. */
  resourceClass: ResourceClass;
  /** The lane the job was claimed in. */
  lane: string | null;
  /** Aborts the handler's signal on cancel and stop. */
  controller: AbortController;
  /** A cancel arrived before the handler settled; the run ends `cancelled`. */
  cancelled: boolean;
  /** The handler has settled; a cancel no longer changes the outcome. */
  settled: boolean;
  /** The stop gave up on the handler at its deadline; the run's late end is ignored. */
  abandoned: boolean;
  /** Resolves once the outcome is stored and the run is gone from the active runs. */
  done: Promise<void>;
}

/** How a handler's run ended: it resolved, or it threw `error`. */
type Outcome = { ok: true } | { ok: false; error: unknown };

/** The pending timer of the earliest `run_after`; a fresh object per timer, so a stale callback recognises itself. */
interface TimerSlot {
  /** The handle `setTimer` answered. */
  handle: unknown;
}

/** The options with every default applied. */
interface SchedulerConfig {
  /** The job rows. */
  jobs: JobRepository;
  /** The handlers by job type. */
  handlers: Record<string, JobHandler>;
  /** Running jobs per lane of a class. */
  limits: Record<ResourceClass, number>;
  /** Running jobs per class across all lanes. */
  totals: Partial<Record<ResourceClass, number>>;
  /**
   * The clock.
   *
   * @returns the current time
   */
  now: () => Date;
  /**
   * Starts a timer.
   *
   * @param callback called when the timer fires
   * @param delayMs the delay in milliseconds
   * @returns the timer's handle
   */
  setTimer: (callback: () => void, delayMs: number) => unknown;
  /**
   * Clears a timer.
   *
   * @param handle the timer's handle
   */
  clearTimer: (handle: unknown) => void;
  /**
   * Logs a swallowed failure.
   *
   * @param message what failed
   * @param cause the caught error
   */
  log: (message: string, cause: unknown) => void;
}

/**
 * Event-driven job scheduler: it looks for work on `start`, on `wake`, when a job ends and when the timer for the
 * earliest `run_after` fires. Claims first in, first out per resource class and lane, up to the class's limit in
 * every lane (or the lane's own limit from `laneLimit`); jobs without a lane share the lane `null`.
 *
 * @param options the repository, the handlers and the optional limits, clock, timers, listeners and pause gate
 * @returns the scheduler
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const scheduler = new JobScheduler(options, resolveConfig(options));
  return {
    start: () => scheduler.start(),
    wake: () => scheduler.wake(),
    cancel: (jobId, cancelOptions) => scheduler.cancel(jobId, cancelOptions),
    cancelAll: () => scheduler.cancelAll(),
    stop: () => scheduler.stop(),
  };
}

/**
 * Applies the defaults to the options.
 *
 * @param options the options as passed
 * @returns the options with every default applied
 */
function resolveConfig(options: SchedulerOptions): SchedulerConfig {
  return {
    jobs: options.jobs,
    handlers: options.handlers,
    limits: options.limits ?? DEFAULT_LIMITS,
    totals: options.totals ?? DEFAULT_TOTALS,
    now: options.now ?? (() => new Date()),
    setTimer: options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs)),
    clearTimer: options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    log: options.log ?? ((message: string, cause: unknown) => console.error(message, cause)),
  };
}

/**
 * The job types of every resource class, in the order of `ResourceClassSchema`.
 *
 * @param handlers the handlers by job type
 * @returns per class the types whose handler runs in it; a class without handlers maps to an empty list
 */
function typesByClass(handlers: Record<string, JobHandler>): Map<ResourceClass, string[]> {
  return new Map<ResourceClass, string[]>(
    ResourceClassSchema.options.map((resourceClass) => [
      resourceClass,
      Object.keys(handlers).filter((type) => handlers[type]!.resourceClass === resourceClass),
    ]),
  );
}

/**
 * The `settled` callback `cancelPending` is given, so a handler's hook sees jobs cancelled before they ran.
 *
 * @param handlers the handlers by job type
 * @returns an object holding the callback, or an empty object when no handler has a hook
 */
function cancelHookOf(handlers: Record<string, JobHandler>): { settled?: (job: Job) => void } {
  if (!Object.values(handlers).some((handler) => handler.settled)) return {};
  return { settled: (job) => handlers[job.type]?.settled?.(job, { status: 'cancelled' }) };
}

/**
 * The delay before the next run of a job whose run failed with a retryable code.
 *
 * @param attempt the job's run count after the claim
 * @param retryAfterMs the wait the error asked for, or null
 * @returns the usual delay for the attempt, or the asked wait when it is longer
 */
function retryDelayMs(attempt: number, retryAfterMs: number | null): number {
  // `attempt` is at least 1 after a claim; the clamp keeps the index inside the table either way.
  const usual = RETRY_DELAYS_MS[Math.min(Math.max(attempt, 1), RETRY_DELAYS_MS.length) - 1]!;
  return retryAfterMs === null ? usual : Math.max(usual, retryAfterMs);
}

/**
 * Waits for `work`, but no longer than `deadlineMs` on the configured timer.
 *
 * @param config the timers
 * @param work the promise to wait for; it never rejects
 * @param deadlineMs the longest wait in milliseconds
 * @returns resolves to true when `work` ended in time, false at the deadline
 */
function waitAtMost(config: SchedulerConfig, work: Promise<void>, deadlineMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const handle = config.setTimer(() => resolve(false), deadlineMs);
    void work.then(() => {
      config.clearTimer(handle);
      resolve(true);
    });
  });
}

/**
 * The scheduler's state and steps. The methods share the active runs, the pass flags and the timer, so they live on
 * one private class; `createScheduler` hands out only the public methods.
 */
class JobScheduler {
  /** The job types of every class. */
  private readonly typesOf: Map<ResourceClass, string[]>;
  /** The `settled` callback for `cancelPending`; absent when no handler has a hook. */
  private readonly cancelHook: { settled?: (job: Job) => void };
  /** The launched runs by job id. */
  private readonly active = new Map<string, ActiveRun>();
  /** Cancels that `stop` waits for. */
  private readonly pendingCancels = new Set<Promise<unknown>>();
  /** The recovery is done and passes may run. */
  private started = false;
  /** `stop` was called; nothing new is claimed. */
  private stopping = false;
  /** The start in progress or done, so a second `start` and `stop` wait for it; null before the first `start`. */
  private starting: Promise<void> | null = null;
  /** The running or last run of passes, which `start` and `stop` wait for. */
  private passDone: Promise<void> = Promise.resolve();
  /** A run of passes is in progress. */
  private passing = false;
  /** A wake arrived during a pass; another pass follows. */
  private passAgain = false;
  /** The timer of the earliest `run_after`, if one is pending. */
  private timer: TimerSlot | null = null;
  /** A recovery or a stored outcome failed, so rows may be left `running`; the next pass recovers them. */
  private recoveryPending = false;
  /** The classes whose last pass failed; a failure streak is logged once. */
  private readonly failingClasses = new Set<ResourceClass>();
  /** The lanes held after a job asked for a wait. */
  private readonly laneHolds = new LaneHolds();
  /** The rows this scheduler left `running` itself, so the recovery knows whether they ran. */
  private readonly leftovers = new LeftoverRows();
  /** The order the lanes of a class with a total were served in. */
  private readonly rotation = new LaneRotation();

  /**
   * @param options the options as passed; `onChange`, `pause` and `laneLimit` are read from them at every use
   * @param config the options with their defaults
   */
  constructor(
    private readonly options: SchedulerOptions,
    private readonly config: SchedulerConfig,
  ) {
    this.typesOf = typesByClass(config.handlers);
    this.cancelHook = cancelHookOf(config.handlers);
  }

  /**
   * Recovers jobs found `running`, then begins claiming. A second call while the first runs waits for it.
   *
   * @returns resolves once the recovery and the first pass are done
   */
  async start(): Promise<void> {
    if (this.stopping) return;
    // Set synchronously, so a second call while recovery runs waits for it instead of recovering again.
    if (this.starting) return this.starting;
    this.starting = this.recoverThenClaim();
    await this.starting;
  }

  /** Starts a run of passes, or asks the running one for another pass. Does nothing before start or after stop. */
  wake(): void {
    if (!this.started || this.stopping) return;
    if (this.passing) {
      this.passAgain = true;
      return;
    }
    this.passDone = this.passes();
  }

  /**
   * Cancels one job: a running one is aborted, a pending one ends in the database.
   *
   * @param jobId the job to cancel
   * @param cancelOptions `pendingOnly` leaves a running job alone and cancels it only while it is pending
   * @returns resolves once the cancel is written; a running job is only aborted, its end is written by its run
   */
  async cancel(jobId: string, cancelOptions?: CancelOptions): Promise<void> {
    const pendingOnly = cancelOptions?.pendingOnly === true;
    const run = this.active.get(jobId);
    if (this.stopping) {
      // The stop has aborted the run already; marking it makes its end `cancelled` instead of a requeue.
      if (run && !pendingOnly && !run.settled) run.cancelled = true;
      return;
    }
    // A pending-only cancel goes to the database, which ends the job only while it is still pending.
    if (run && !pendingOnly) {
      if (!run.settled) {
        this.abortRun(run);
        return;
      }
      // The handler is done and keeps its outcome, but a retry it is still storing is cancelled once stored.
      await this.tracked(this.cancelAfterRun(jobId, run));
      return;
    }
    const cancelled = await this.tracked(this.cancelPendingJob(jobId));
    // A pass may have claimed the job while the cancel was written and launched it since.
    const launched = this.active.get(jobId);
    if (!cancelled && !pendingOnly && launched && !launched.settled) this.abortRun(launched);
  }

  /**
   * Marks a run cancelled and aborts its handler; its end is written by the run.
   *
   * @param run the active run
   */
  private abortRun(run: ActiveRun): void {
    run.cancelled = true;
    run.controller.abort();
  }

  /**
   * Cancels every pending job and aborts every running one.
   *
   * @returns the number of jobs cancelled or aborted; 0 once a stop began
   */
  async cancelAll(): Promise<number> {
    if (this.stopping) return 0;
    return this.tracked(this.cancelEverything());
  }

  /**
   * Aborts running jobs and waits for them, for the start, the passes and the cancels in progress.
   *
   * @returns resolves once everything has ended
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.cancelTimer();
    for (const run of this.active.values()) run.controller.abort();
    await this.starting;
    await this.passDone;
    // A pass that was in progress may have launched a run before it saw `stopping`.
    for (const run of this.active.values()) run.controller.abort();
    if (await waitAtMost(this.config, this.endEverything(), STOP_DEADLINE_MS)) return;
    this.abandonUnsettledRuns();
    // What is left are cancels and the stores of settled runs: database work, not handlers.
    await this.endEverything();
  }

  /**
   * The cancels in progress, then every active run.
   *
   * @returns resolves once they have all ended
   */
  private async endEverything(): Promise<void> {
    await Promise.allSettled([...this.pendingCancels]);
    await Promise.all([...this.active.values()].map((run) => run.done));
  }

  /** Gives up on every run whose handler has not ended: it leaves the active runs and its late end is ignored. */
  private abandonUnsettledRuns(): void {
    let abandoned = 0;
    for (const [id, run] of this.active) {
      if (run.settled) continue;
      run.abandoned = true;
      this.active.delete(id);
      abandoned++;
    }
    if (abandoned > 0) this.config.log('Job handlers did not end before the stop deadline', { abandoned });
  }

  /**
   * The body of `start`: the recovery, then the first pass.
   *
   * @returns resolves once the first pass is done; a failed recovery is logged and claiming begins anyway
   */
  private async recoverThenClaim(): Promise<void> {
    try {
      await this.recover();
    } catch (cause) {
      this.recoveryPending = true;
      this.config.log('Interrupted jobs could not be recovered', cause);
    }
    if (this.stopping) return;
    this.started = true;
    this.wake();
    await this.passDone;
  }

  /**
   * Recovers the rows a failed recovery or a failed store of an outcome left `running`, when there are any. A failure
   * is logged and tried again on the next pass.
   *
   * @returns resolves once the recovery is done or its failure logged
   */
  private async recoverLeftovers(): Promise<void> {
    if (!this.recoveryPending) return;
    this.recoveryPending = false;
    try {
      await this.recover();
    } catch (cause) {
      this.recoveryPending = true;
      this.config.log('Interrupted jobs could not be recovered', cause);
    }
  }

  /**
   * Handles every job found `running` that this scheduler is not running, by the step `LeftoverRows.stepOf` picks.
   *
   * @returns resolves once every such job is handled or a stop began
   */
  private async recover(): Promise<void> {
    for (const job of await this.config.jobs.listByStatus('running')) {
      if (this.stopping) break;
      // A launched run stores its own outcome.
      if (this.active.has(job.id)) continue;
      const changedRow = await this.recoverRow(job);
      this.leftovers.forget(job.id);
      if (changedRow) this.changed(job.id);
    }
  }

  /**
   * Applies the recovery step of one row found `running`.
   *
   * @param job the row
   * @returns resolves to whether the row changed
   */
  private recoverRow(job: Job): Promise<boolean> {
    const step = this.leftovers.stepOf(job, this.config.handlers[job.type]?.onInterrupted === 'fail');
    const errorCode = this.interruptedCodeOf(job);
    if (step === 'release') return this.config.jobs.release(job.id, this.iso());
    if (step === 'retry')
      return this.config.jobs.scheduleRetry(job.id, { errorCode, runAfter: this.iso(), now: this.iso() });
    return this.finishJob(job, { status: 'failed', errorCode });
  }

  /**
   * Puts a claimed job that was not launched back to `queued`. When that fails, the row is left for the recovery of
   * a later pass, which knows it never ran. A put-back that fails while stopping is not recovered in this session:
   * the mark lives in memory only, so at the next open the row counts as interrupted, and a job of an
   * `onInterrupted: 'fail'` handler ends `failed` with its interrupted code.
   *
   * @param job the claimed job
   * @returns resolves once the job is back; rejects with the cause of a failed put-back
   */
  private async putBack(job: Job): Promise<void> {
    try {
      await this.config.jobs.release(job.id, this.iso());
    } catch (cause) {
      this.leftovers.addUnlaunched(job.id);
      this.recoveryPending = true;
      throw cause;
    }
  }

  /**
   * Runs passes until no wake arrived during the last one. A failed pass is logged.
   *
   * @returns resolves once the last pass is done
   */
  private async passes(): Promise<void> {
    this.passing = true;
    try {
      do {
        this.passAgain = false;
        await this.recoverLeftovers();
        try {
          await this.pass();
        } catch (cause) {
          this.config.log('Job scheduler pass failed', cause);
        }
      } while (this.passAgain && !this.stopping);
    } finally {
      this.passing = false;
    }
  }

  /**
   * One pass: claims and launches jobs per class until the class is at its total or has nothing claimable, then
   * arms the timer for the earliest `run_after` of the lanes that may claim.
   *
   * @returns resolves once the pass is done; returns early once a stop began. A class that fails is logged and
   *   tried again after the first retry delay, while the other classes are still served.
   */
  private async pass(): Promise<void> {
    let earliest: number | null = null;
    for (const [resourceClass, types] of this.typesOf) {
      if (types.length === 0 || this.config.limits[resourceClass] <= 0) continue;
      let next: number | null;
      try {
        next = await this.passClass(resourceClass, types);
        this.failingClasses.delete(resourceClass);
      } catch (cause) {
        this.reportPassFailure(resourceClass, cause);
        next = this.config.now().getTime() + RETRY_DELAYS_MS[0]!;
      }
      if (this.stopping) return;
      if (next !== null) earliest = Math.min(earliest ?? Infinity, next);
    }
    // A recovery that failed again is tried after the first retry delay, even when nothing else wakes the scheduler.
    if (this.recoveryPending)
      earliest = Math.min(earliest ?? Infinity, this.config.now().getTime() + RETRY_DELAYS_MS[0]);
    this.cancelTimer();
    if (earliest !== null) this.armTimer(earliest);
  }

  /**
   * The part of a pass for one class: claims and launches its jobs until it is at its total or has nothing
   * claimable.
   *
   * @param resourceClass the class
   * @param types the job types of the class
   * @returns the earliest `run_after` of the lanes that may claim, in milliseconds since the epoch; null when the
   *   class needs no timer or a stop began
   */
  private async passClass(resourceClass: ResourceClass, types: string[]): Promise<number | null> {
    // The excluded lanes are worked out again before every claim: a run may end or a lane pause in between.
    for (;;) {
      if (this.stopping) return null;
      // A class at its total gets a pass when one of its runs ends; it needs no timer meanwhile.
      if (this.atTotal(resourceClass)) return null;
      const job = await this.claim(resourceClass, types);
      if (!job) break;
      if (this.stopping) {
        await this.putBack(job);
        return null;
      }
      // A run that ended during the claim may have paused the lane; its job goes back without spending a run.
      if (await this.releaseIfBarred(job)) continue;
      this.launch(job);
      this.rotation.record(resourceClass, job.lane);
      this.changed(job.id);
    }
    if (this.stopping) return null;
    // A full lane gets a pass when one of its jobs ends and a paused one when the caller wakes the scheduler after
    // resume; only the other lanes need the timer.
    const next = await this.config.jobs.nextRunAfter(types, this.excludedLanes(resourceClass));
    // A held lane is excluded above, so the end of its hold needs a timer of its own.
    const holdEnd = this.laneHolds.earliestEnd(resourceClass, this.config.now().getTime());
    const candidates = [next === null ? null : Date.parse(next), holdEnd].filter((time) => time !== null);
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  /**
   * Claims the next job of a class. Under a class total the lanes take turns: the lanes served recently are left out
   * as long as another lane has a claimable job, the one served longest ago given back first.
   *
   * @param resourceClass the class
   * @param types the job types of the class
   * @returns the claimed job; null when no lane that may claim has one
   */
  private async claim(resourceClass: ResourceClass, types: string[]): Promise<Job | null> {
    const excluded = this.excludedLanes(resourceClass);
    const rotating = this.config.totals[resourceClass] !== undefined;
    const attempts = rotating ? this.rotation.preferences(resourceClass) : [[]];
    for (const [index, served] of attempts.entries()) {
      const job = await this.config.jobs.claimNext({
        resourceClass,
        types,
        now: this.iso(),
        excludeLanes: [...excluded, ...served],
      });
      if (job || this.stopping) return job;
      if (index > 0) this.forgetIdleLane(resourceClass, attempts[index - 1]!);
    }
    return null;
  }

  /**
   * Drops from the rotation the lane that a claim finding nothing gave back, when it has no running job: it has
   * nothing to claim, so leaving it out of later claims would only cost queries.
   *
   * @param resourceClass the class of the claim
   * @param previous the lanes the claim before left out; its last lane is the one given back
   */
  private forgetIdleLane(resourceClass: ResourceClass, previous: (string | null)[]): void {
    if (previous.length === 0) return;
    const lane = previous[previous.length - 1] as string | null;
    if (!this.runningOf(resourceClass).has(lane)) this.rotation.forget(resourceClass, lane);
  }

  /**
   * Logs the failed pass of a class, naming the class, once until a pass of that class succeeds again.
   *
   * @param resourceClass the class whose pass failed
   * @param cause the error the pass threw
   */
  private reportPassFailure(resourceClass: ResourceClass, cause: unknown): void {
    if (this.failingClasses.has(resourceClass)) return;
    this.failingClasses.add(resourceClass);
    this.config.log(`Job scheduler pass failed for class ${resourceClass}`, cause);
  }

  /**
   * Puts a claimed job back when its lane may no longer claim: it was paused, or reached its limit, while the claim
   * was under way. A failure to tell puts the job back too before it is passed on, so no row stays `running`.
   *
   * @param job the job just claimed
   * @returns true when the job was put back
   */
  private async releaseIfBarred(job: Job): Promise<boolean> {
    let barred: boolean;
    try {
      barred = this.excludedLanes(job.resourceClass).includes(job.lane);
    } catch (cause) {
      await this.putBack(job);
      throw cause;
    }
    if (barred) await this.putBack(job);
    return barred;
  }

  /**
   * Starts the timer that wakes the scheduler at `earliest`.
   *
   * @param earliest the time to wake at, in milliseconds since the epoch; a past time fires at once
   */
  private armTimer(earliest: number): void {
    const slot: TimerSlot = { handle: null };
    slot.handle = this.config.setTimer(
      () => {
        if (this.timer !== slot) return;
        this.timer = null;
        this.wake();
      },
      Math.max(earliest - this.config.now().getTime(), 0),
    );
    this.timer = slot;
  }

  /** Clears the pending timer, if any. */
  private cancelTimer(): void {
    if (this.timer) this.config.clearTimer(this.timer.handle);
    this.timer = null;
  }

  /**
   * Registers a claimed job as active and starts its handler.
   *
   * @param job the claimed job
   */
  private launch(job: Job): void {
    const handler = this.config.handlers[job.type]!;
    const run: ActiveRun = {
      resourceClass: job.resourceClass,
      lane: job.lane,
      controller: new AbortController(),
      cancelled: false,
      settled: false,
      abandoned: false,
      done: Promise.resolve(),
    };
    // A put-back whose answer was lost may have been written: the row was queued again and is launched now, so its
    // never-launched mark must not outlive this launch.
    this.leftovers.forget(job.id);
    this.active.set(job.id, run);
    run.done = this.runJob(job, run, handler);
  }

  /**
   * Runs the handler, stores the outcome, then removes the run and wakes the scheduler.
   *
   * @param job the claimed job
   * @param run the job's active run
   * @param handler the handler of the job's type
   * @returns resolves once the run is gone from the active runs; a failure to store the outcome is logged
   */
  private async runJob(job: Job, run: ActiveRun, handler: JobHandler): Promise<void> {
    let outcome: Outcome;
    try {
      await handler.run(job, run.controller.signal);
      outcome = { ok: true };
    } catch (error) {
      outcome = { ok: false, error };
    }
    // The stop has returned without this run; the database may be closed or another workspace's by now.
    if (run.abandoned) return;
    run.settled = true;
    try {
      await this.settle(job, run, outcome);
    } catch (cause) {
      // The row may still be `running`; the next pass recovers it, spending the attempt of this run.
      this.leftovers.addUnsettled(job.id);
      this.recoveryPending = true;
      this.config.log('Job outcome could not be stored', cause);
    }
    this.active.delete(job.id);
    this.changed(job.id);
    this.wake();
  }

  /**
   * Stores the outcome of a run. `job.attempt` is the value after the claim.
   *
   * @param job the job of the run
   * @param run the run
   * @param outcome how the handler ended
   * @returns resolves once the outcome, and a lane hold it asks for, is written
   */
  private async settle(job: Job, run: ActiveRun, outcome: Outcome): Promise<void> {
    this.record(job, run, outcome);
    if (run.cancelled) return this.finish(job, { status: 'cancelled' });
    if (outcome.ok) return this.finish(job, { status: 'succeeded' });
    const { error } = outcome;
    if (this.stopping) {
      // The abort of the stop itself is expected; anything else foreign is a handler fault worth seeing.
      if (!(error instanceof JobError) && error !== run.controller.signal.reason) {
        this.config.log(`Job ${job.id} of type ${job.type} failed while stopping`, error);
      }
      // Work with an unclear outcome is never put back: a later run could repeat it. A run that ended with a final
      // code keeps it; one that was cut off, or could have been retried but for the stop, takes the interrupted code.
      if (this.config.handlers[job.type]!.onInterrupted === 'fail') {
        const isFinal = error instanceof JobError && !isRetryableJobError(error.code);
        return this.finish(job, { status: 'failed', errorCode: isFinal ? error.code : this.interruptedCodeOf(job) });
      }
      await this.config.jobs.release(job.id, this.iso());
      return;
    }
    if (!(error instanceof JobError)) {
      this.config.log(`Job ${job.id} of type ${job.type} failed`, error);
      return this.finish(job, { status: 'failed', errorCode: 'internal_error' });
    }
    if (!isRetryableJobError(error.code)) return this.finish(job, { status: 'failed', errorCode: error.code });
    return this.settleRetryable(job, error);
  }

  /**
   * Stores the outcome of a run that failed with a retryable code: a retry, or the end after the last run. A wait the
   * error asks for holds the lane, in memory before anything is written and then in the database.
   *
   * @param job the job of the run
   * @param error the retryable error
   * @returns resolves once the outcome and the lane hold are written
   */
  private async settleRetryable(job: Job, error: JobError): Promise<void> {
    const wait = error.retryAfterMs;
    const now = this.config.now().getTime();
    const holdEnd = job.attempt >= MAX_ATTEMPTS ? now + (wait ?? 0) : now + retryDelayMs(job.attempt, wait);
    // Held in memory first: no claim in the window before the rows below are written takes a job of the lane.
    if (wait !== null) this.laneHolds.hold(job.resourceClass, job.lane, holdEnd);
    const until = new Date(holdEnd).toISOString();
    if (job.attempt >= MAX_ATTEMPTS) {
      await this.finish(job, { status: 'failed', errorCode: error.code });
    } else {
      await this.config.jobs.scheduleRetry(job.id, { errorCode: error.code, runAfter: until, now: this.iso() });
    }
    if (wait !== null) await this.holdLane(job, until);
  }

  /**
   * Ends a run's job with `end`; the answer whether a row changed is dropped.
   *
   * @param job the job
   * @param end the final outcome
   * @returns resolves once the end is written
   */
  private async finish(job: Job, end: JobOutcome): Promise<void> {
    await this.finishJob(job, end);
  }

  /**
   * Ends a running job; the hook of its handler, if any, runs inside the end with the same outcome.
   *
   * @param job the job
   * @param outcome the final outcome
   * @returns resolves to whether the row changed
   */
  private finishJob(job: Job, outcome: JobOutcome): Promise<boolean> {
    const handler = this.config.handlers[job.type];
    const errorCode = outcome.status === 'failed' ? outcome.errorCode : null;
    return this.config.jobs.finish(job.id, {
      status: outcome.status,
      errorCode,
      now: this.iso(),
      ...(handler?.settled ? { settled: () => handler.settled!(job, outcome) } : {}),
    });
  }

  /**
   * Makes the waiting jobs of the job's class and lane wait until `until`; their run counts stay. Not a pause.
   * Runs after the outcome was stored, so a failure here is logged as what it is and never as a lost outcome.
   * Moved jobs are reported as a change of several rows.
   *
   * @param job the job whose error asked for the wait
   * @param until the time the lane may claim again, as ISO text
   * @returns resolves once the hold is written or its failure logged
   */
  private async holdLane(job: Job, until: string): Promise<void> {
    let moved: number;
    try {
      moved = await this.config.jobs.holdLane({
        types: this.typesOf.get(job.resourceClass) ?? [job.type],
        lane: job.lane,
        until,
        now: this.iso(),
      });
    } catch (cause) {
      this.config.log('The lane hold could not be written', cause);
      return;
    }
    if (moved > 0) this.changed(null);
  }

  /**
   * Tells the gate how a run ended, before the next pass decides whether its class may claim again.
   *
   * @param job the job of the run
   * @param run the run
   * @param outcome how the handler ended
   */
  private record(job: Job, run: ActiveRun, outcome: Outcome): void {
    if (!this.options.pause) return;
    // Same order as `settle`: a cancel wins, then success; a run released on stop or a foreign error is 'other'.
    let result: JobErrorCode | 'ok' | 'other' = 'other';
    if (!run.cancelled) {
      if (outcome.ok) result = 'ok';
      else if (!this.stopping && outcome.error instanceof JobError) result = outcome.error.code;
    }
    try {
      this.options.pause.record(job.resourceClass, job.lane, result);
    } catch (cause) {
      this.config.log('Job pause gate failed', cause);
    }
  }

  /**
   * The cancel of a job whose handler has settled: waits until its outcome is stored, then cancels a retry it
   * stored.
   *
   * @param jobId the job
   * @param run the job's run
   * @returns resolves once the cancel is written
   */
  private async cancelAfterRun(jobId: string, run: ActiveRun): Promise<void> {
    await run.done;
    if ((await this.config.jobs.cancelPending({ id: jobId, now: this.iso(), ...this.cancelHook })) > 0) {
      this.changed(jobId);
    }
  }

  /**
   * Cancels one job in the database, which ends it only while it is pending.
   *
   * @param jobId the job
   * @returns whether the job was pending and is cancelled now
   */
  private async cancelPendingJob(jobId: string): Promise<boolean> {
    if ((await this.config.jobs.cancelPending({ id: jobId, now: this.iso(), ...this.cancelHook })) === 0) return false;
    this.changed(jobId);
    return true;
  }

  /**
   * The body of `cancelAll`: pending jobs first, then the running ones, then the retries of runs that had already
   * settled.
   *
   * @returns the number of jobs cancelled or aborted
   */
  private async cancelEverything(): Promise<number> {
    // Pending first: a job claimed meanwhile is running by then and is aborted below.
    const pending = await this.config.jobs.cancelPending({ now: this.iso(), ...this.cancelHook });
    if (pending > 0) this.changed(null);
    // A stop that began meanwhile owns the running jobs.
    if (this.stopping) return pending;
    const { running, ending, endingIds } = this.abortActiveRuns();
    if (ending.length === 0) return pending + running;
    await Promise.all(ending);
    // Only the retries of those runs: a job enqueued while this call waited is not part of it.
    let retried = 0;
    for (const id of endingIds) {
      retried += await this.config.jobs.cancelPending({ id, now: this.iso(), ...this.cancelHook });
    }
    if (retried > 0) this.changed(null);
    return pending + running + retried;
  }

  /**
   * Aborts every active run whose handler has not settled and collects the ones that have.
   *
   * @returns the number of runs aborted now, and the settled runs' ends and job ids
   */
  private abortActiveRuns(): { running: number; ending: Promise<void>[]; endingIds: string[] } {
    let running = 0;
    const ending: Promise<void>[] = [];
    const endingIds: string[] = [];
    for (const [id, run] of this.active) {
      // A run whose handler is done keeps its outcome, but a retry it is still storing is cancelled below.
      if (run.settled) {
        ending.push(run.done);
        endingIds.push(id);
        continue;
      }
      // Cancelled by an earlier call; not counted again.
      if (run.cancelled) continue;
      this.abortRun(run);
      running++;
    }
    return { running, ending, endingIds };
  }

  /**
   * Runs `work` so that `stop` waits for it.
   *
   * @param work the promise to track
   * @returns what `work` resolves to
   */
  private async tracked<T>(work: Promise<T>): Promise<T> {
    this.pendingCancels.add(work);
    try {
      return await work;
    } finally {
      this.pendingCancels.delete(work);
    }
  }

  /**
   * Running jobs of the class per lane.
   *
   * @param resourceClass the class
   * @returns the count of active runs per lane
   */
  private runningOf(resourceClass: ResourceClass): Map<string | null, number> {
    const counts = new Map<string | null, number>();
    for (const run of this.active.values()) {
      if (run.resourceClass === resourceClass) counts.set(run.lane, (counts.get(run.lane) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * Whether the class runs its total across all lanes.
   *
   * @param resourceClass the class
   * @returns true when the class has a total and runs at least that many jobs
   */
  private atTotal(resourceClass: ResourceClass): boolean {
    const total = this.config.totals[resourceClass];
    if (total === undefined) return false;
    let count = 0;
    for (const run of this.active.values()) if (run.resourceClass === resourceClass) count++;
    return count >= total;
  }

  /**
   * The limit of one lane: the answer of `laneLimit` when it is an integer of at least 1, otherwise the class's.
   *
   * @param resourceClass the class of the lane
   * @param lane the lane
   * @returns the running jobs the lane may have
   */
  private limitOf(resourceClass: ResourceClass, lane: string | null): number {
    if (!this.options.laneLimit) return this.config.limits[resourceClass];
    let answer: unknown;
    try {
      answer = this.options.laneLimit(resourceClass, lane);
    } catch (cause) {
      this.config.log('Job lane limit failed', cause);
      return this.config.limits[resourceClass];
    }
    return typeof answer === 'number' && Number.isInteger(answer) && answer >= 1
      ? answer
      : this.config.limits[resourceClass];
  }

  /**
   * Lanes the class may not claim from: the paused ones, the held ones and those already running their limit.
   *
   * @param resourceClass the class
   * @returns the excluded lanes, paused ones first
   */
  private excludedLanes(resourceClass: ResourceClass): (string | null)[] {
    const excluded = new Set<string | null>(
      this.options.pause ? this.options.pause.paused(resourceClass).map((entry) => entry.lane) : [],
    );
    for (const lane of this.laneHolds.held(resourceClass, this.config.now().getTime())) excluded.add(lane);
    for (const [lane, count] of this.runningOf(resourceClass)) {
      if (count >= this.limitOf(resourceClass, lane)) excluded.add(lane);
    }
    return [...excluded];
  }

  /**
   * The code a job of a handler under `onInterrupted: 'fail'` ends with when its run is cut off.
   *
   * @param job the job
   * @returns the handler's `interruptedCode`, or `internal_error`
   */
  private interruptedCodeOf(job: Job): JobErrorCode {
    return this.config.handlers[job.type]?.interruptedCode ?? 'internal_error';
  }

  /**
   * Tells the listener about a status change; a throwing listener is logged.
   *
   * @param jobId the job whose row changed, or null for several rows
   */
  private changed(jobId: string | null): void {
    try {
      this.options.onChange?.(jobId);
    } catch (cause) {
      this.config.log('Job change listener failed', cause);
    }
  }

  /**
   * The current time as ISO text.
   *
   * @returns the clock's time as `toISOString` writes it
   */
  private iso(): string {
    return this.config.now().toISOString();
  }
}
