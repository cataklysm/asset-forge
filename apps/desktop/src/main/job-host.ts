import {
  ANALYZE_FILE_JOB,
  FILE_DOWNLOAD_JOB,
  IMAGE_GENERATE_JOB,
  SITE_CRAWL_JOB,
  type Changes,
  type JobErrorCode,
  type ResourceClass,
} from '@assetforge/contracts';
import {
  assignUnroutedJobs,
  createAnalyzeFileHandler,
  createFileDownloadHandler,
  createImageGenerateHandler,
  errorLogLine,
  reconcileGenerations,
  settleGenerationOfJob,
  writeLine,
  type GenerationImageSource,
  type ImageProviderDirectory,
  type JobControl,
  type JobHandler,
  type LineLog,
  type ModelImageSource,
  type RemoteFileSource,
  type SiteAccess,
  type VisionProvider,
  type WorkspaceManager,
  type WorkspaceSession,
} from '@assetforge/core';
import {
  createScheduler,
  DEFAULT_LIMITS,
  DEFAULT_TOTALS,
  type PauseGate,
  type RecoveredJobs,
  type Scheduler,
} from '@assetforge/jobs';
import type { ChangeFeed } from './change-feed.js';
import { createSiteDiscoveryHandler, type SiteDiscoveryRuntime } from './site-discovery.js';
import { consoleLog, jobRecoveryLine, schedulerLogLine, type JobRecoveryCounts } from './main-log.js';

// Kept free of Electron imports. One scheduler per open workspace: the host starts it after a
// workspace opened and stops it before the workspace closes, so no job touches a closing database.
// The pause gate belongs to the app session and is handed to every scheduler, so a pause outlives
// closing and reopening a workspace. An analysis job (local_gpu) and a generation job (remote_api) run in the
// lane of their provider entry (the entry id), a download job (io) in the lane of its URL's host; limit, claim
// and pause work per resource class and lane.

/** Starts and stops the scheduler of the open workspace and answers for its jobs, its pauses and its changes. */
export interface JobHost extends JobControl {
  /** Starts a scheduler for the open workspace; no-op without one or when one runs. Never rejects. */
  workspaceOpened(): Promise<void>;
  /** Stops the scheduler and waits for its jobs; no-op without one. Never rejects. */
  workspaceClosing(): Promise<void>;
  /** Every change written to the feed since the app started; never goes down. */
  changes(): number;
  /** For the IPC handlers: jobs changed outside the scheduler. */
  changed(): void;
  /** What changed since `cursor` in the open workspace; see `ChangeFeed.since`. */
  changesSince(cursor: string | null): Changes;
  /**
   * The paused lanes of the analysis, the generation and the download queue with their codes, in that order and
   * each in the order they paused; `null` is the analysis jobs without a provider, a download lane is a host.
   */
  paused(): { lane: string | null; reason: JobErrorCode; resourceClass: ResourceClass }[];
  /**
   * Ends the pause of one lane in the given queues only and lets the scheduler claim again. A provider entry id
   * and a download host may be the same string, so a resume never reaches the queues of the other kind. The change
   * counter rises only when the lane was paused in one of them. Never throws.
   */
  resume(lane: string | null, classes: readonly ResourceClass[]): void;
}

/** The scheduler's clock and timers. */
export interface SchedulerClock {
  /** @returns the current time */
  now(): Date;
  /**
   * Calls `callback` after `milliseconds`.
   *
   * @param callback what to call
   * @param milliseconds how long to wait
   * @returns a handle for `clearTimer`
   */
  setTimer(callback: () => void, milliseconds: number): unknown;
  /**
   * Cancels a timer.
   *
   * @param handle what `setTimer` answered
   */
  clearTimer(handle: unknown): void;
}

/** What the job host runs its schedulers with. */
export interface JobHostDependencies {
  /** The workspace manager. */
  manager: WorkspaceManager;
  /**
   * Takes every change: a job the scheduler changed, jobs changed in bulk, and what the handlers report. Cleared
   * when a workspace opens and when it closes.
   */
  feed: ChangeFeed;
  /** The adapter of a lane (a provider entry id) when a job runs; null when no such entry exists. */
  vision: (lane: string | null) => VisionProvider | null;
  /** Reads the JPEG an analysis sends. */
  images: ModelImageSource;
  /** The fingerprint provider id of a lane (the kind of its vision entry); null when the lane has no vision entry. */
  provider: (lane: string | null) => string | null;
  /** The pause gate of the app session. */
  pause: PauseGate;
  /** The entry that active analysis jobs without a provider are assigned to when a workspace opens; null when there is none. */
  firstEntry: () => { id: string; name: string; taggingModel: string | null } | null;
  /** The entries of the image purpose (the `venice` kind) that generation jobs resolve and run on. */
  imageProviders: ImageProviderDirectory;
  /** Reads the image a generation sends. */
  generationImages: GenerationImageSource;
  /** The network side of the URL import's download jobs. */
  remote: RemoteFileSource;
  /** The logins of the site profiles for site downloads; without it a site download fails as its profile missing. */
  sites?: SiteAccess;
  /** Existing profile sessions used by queued gallery discovery. */
  discovery?: SiteDiscoveryRuntime;
  /** Running jobs per lane of a class; `DEFAULT_LIMITS` without it. */
  limits?: Record<ResourceClass, number>;
  /** Running jobs per class across all its lanes; `DEFAULT_TOTALS` without it. */
  totals?: Partial<Record<ResourceClass, number>>;
  /** Real time without it. */
  clock?: SchedulerClock;
  /**
   * The limit of one lane, asked before every claim; an integer of at least 1 replaces the class limit for that
   * lane, anything else keeps it. Without it every lane runs the class limit.
   */
  laneLimit?: (resourceClass: ResourceClass, lane: string | null) => number | undefined;
  /**
   * Takes the lines of the host and its schedulers: fixed texts, ids, counts and safe error descriptions only. The
   * main console without it.
   */
  log?: LineLog;
}

/** The resource class of the analysis queue. */
const ANALYSIS_CLASS: ResourceClass = 'local_gpu';
/** The resource class of the generation queue. */
const GENERATION_CLASS: ResourceClass = 'remote_api';
/** The resource class of the download queue. */
const DOWNLOAD_CLASS: ResourceClass = 'io';
/** The queues whose lanes pause, in the order `paused` lists them. */
const PAUSABLE: readonly ResourceClass[] = [ANALYSIS_CLASS, GENERATION_CLASS, DOWNLOAD_CLASS];
/** The queues whose lanes are provider entries: what `jobs:resume`, a provider save and a reroute resume. */
export const PROVIDER_CLASSES: readonly ResourceClass[] = [ANALYSIS_CLASS, GENERATION_CLASS];
/** The queue whose lanes are download hosts: what `jobs:resumeHost` resumes. */
export const DOWNLOAD_CLASSES: readonly ResourceClass[] = [DOWNLOAD_CLASS];

/**
 * Creates the job host of the app session.
 *
 * @param dependencies what the schedulers run with
 * @returns the job host
 */
export function createJobHost(dependencies: JobHostDependencies): JobHost {
  const host = new JobHostRunner(dependencies);
  return {
    workspaceOpened: () => host.workspaceOpened(),
    workspaceClosing: () => host.workspaceClosing(),
    wake: () => host.wake(),
    cancel: (jobId, options) => host.cancel(jobId, options),
    cancelAll: () => host.cancelAll(),
    changes: () => dependencies.feed.total(),
    changed: () => host.changed(),
    changesSince: (cursor) => dependencies.feed.since(cursor),
    paused: () => host.paused(),
    resume: (lane, classes) => host.resume(lane, classes),
  };
}

/** The job host with the scheduler of the open workspace, if one runs. */
class JobHostRunner {
  /** The scheduler of the open workspace; null when none runs or one is stopping. */
  private scheduler: Scheduler | null = null;
  // Opening and closing run one after the other, so a stop never overlaps the start of the next scheduler.
  private lifecycle: Promise<void> = Promise.resolve();

  /** Where the host and its schedulers write their lines. */
  private readonly log: LineLog;

  /** @param dependencies what the schedulers run with */
  constructor(private readonly dependencies: JobHostDependencies) {
    this.log = dependencies.log ?? consoleLog;
  }

  /** Tells the feed that jobs changed. */
  changed(): void {
    this.dependencies.feed.jobs();
  }

  /**
   * Starts a scheduler for the open workspace; no-op without one or when one runs.
   *
   * @returns when it started; never rejects
   */
  workspaceOpened(): Promise<void> {
    return this.serial(() => this.startScheduler());
  }

  /**
   * Stops the scheduler and waits for its jobs; no-op without one.
   *
   * @returns when it stopped; never rejects
   */
  workspaceClosing(): Promise<void> {
    return this.serial(() => this.stopScheduler());
  }

  /** Lets the scheduler look for work at once. */
  wake(): void {
    this.scheduler?.wake();
  }

  /**
   * Cancels one job.
   *
   * @param jobId the job
   * @param options passed to the scheduler
   * @returns when it was cancelled
   */
  async cancel(jobId: string, options?: Parameters<Scheduler['cancel']>[1]): Promise<void> {
    if (this.scheduler !== null) return this.scheduler.cancel(jobId, options);
    await this.cancelWithoutScheduler(jobId);
  }

  /**
   * Cancels every job that exists now.
   *
   * @returns how many were cancelled
   */
  async cancelAll(): Promise<number> {
    return this.scheduler === null ? this.cancelWithoutScheduler() : this.scheduler.cancelAll();
  }

  /**
   * The paused lanes of every pausable queue.
   *
   * @returns the lanes with their codes and classes
   */
  paused(): { lane: string | null; reason: JobErrorCode; resourceClass: ResourceClass }[] {
    const { pause } = this.dependencies;
    return PAUSABLE.flatMap((resourceClass) =>
      pause.paused(resourceClass).map(({ lane, reason }) => ({ lane, reason, resourceClass })),
    );
  }

  /**
   * Ends the pause of one lane in the given queues and lets the scheduler claim again. The change counter
   * rises only when one of the queues had the lane paused. Never throws.
   *
   * @param lane the lane
   * @param classes the queues
   */
  resume(lane: string | null, classes: readonly ResourceClass[]): void {
    let hasEnded = false;
    for (const resourceClass of classes) {
      try {
        hasEnded = this.resumeOne(resourceClass, lane) || hasEnded;
      } catch (cause) {
        writeLine(this.log, errorLogLine('The job pause could not be ended', {}, cause));
      }
    }
    if (hasEnded) this.changed();
    this.scheduler?.wake();
  }

  /**
   * Ends the pause of one lane in one queue; the gate also forgets the failures counted towards a pause.
   *
   * @param resourceClass the queue
   * @param lane the lane
   * @returns whether the lane was paused there
   */
  private resumeOne(resourceClass: ResourceClass, lane: string | null): boolean {
    const { pause } = this.dependencies;
    const wasPaused = pause.paused(resourceClass).some((paused) => paused.lane === lane);
    pause.resume(resourceClass, lane);
    return wasPaused;
  }

  /**
   * Runs one lifecycle step after the one before; a failure is logged, never passed on.
   *
   * @param step the step
   * @returns when it ended
   */
  private serial(step: () => Promise<void>): Promise<void> {
    const next = this.lifecycle
      .then(step)
      .catch((error: unknown) => writeLine(this.log, errorLogLine('The job scheduler failed', {}, error)));
    this.lifecycle = next;
    return next;
  }

  /**
   * Prepares the jobs of the open workspace and starts its scheduler.
   *
   * @returns when the scheduler started
   */
  private async startScheduler(): Promise<void> {
    const { manager, feed } = this.dependencies;
    // A cursor of the workspace before must never answer changes of this one.
    feed.clear();
    if (this.scheduler !== null || manager.current() === null) return;
    // The session stays valid until `workspaceClosing` resolved: the workspace closes only after it.
    const session = await manager.read(async (current) => current);
    const counts: JobRecoveryCounts = { released: 0, retried: 0, failed: 0, ...(await this.prepareJobs(session)) };
    // The recovery of the start adds to the line of this open; a later one (after a failed listing) gets its own.
    const recovery = { duringStart: true };
    const onRecovered = (recovered: RecoveredJobs): void => {
      if (recovery.duringStart) addRecovered(counts, recovered);
      else this.writeRecovery(session, { ...recovered, unroutedAssigned: 0, generationsEnded: 0 });
    };
    const created = createWorkspaceScheduler(this.dependencies, session, { log: this.log, onRecovered });
    this.scheduler = created;
    try {
      await created.start();
    } finally {
      recovery.duringStart = false;
      this.writeRecovery(session, counts);
    }
  }

  /**
   * Writes the job recovery line of an open when it did something.
   *
   * @param session the open workspace
   * @param counts what was done
   */
  private writeRecovery(session: WorkspaceSession, counts: JobRecoveryCounts): void {
    const line = jobRecoveryLine(session.summary.id, counts);
    if (line !== null) writeLine(this.log, line);
  }

  /**
   * Routes the jobs without a provider and closes pending generations whose job ended. A failure of either is
   * logged and does not keep the scheduler from starting.
   *
   * @param session the open workspace
   * @returns how many jobs were assigned and how many generations were closed
   */
  private async prepareJobs(
    session: WorkspaceSession,
  ): Promise<Pick<JobRecoveryCounts, 'unroutedAssigned' | 'generationsEnded'>> {
    const workspace = session.summary.id;
    const counts = { unroutedAssigned: 0, generationsEnded: 0 };
    // Before the scheduler claims, so every waiting job runs in the lane the list shows.
    // A failure here must not keep the scheduler from starting: the jobs that already have a lane still run.
    try {
      const entry = await this.dependencies.firstEntry();
      if (entry !== null) counts.unroutedAssigned = await assignUnroutedJobs(session, entry);
      if (counts.unroutedAssigned > 0) this.changed();
    } catch (error) {
      writeLine(this.log, errorLogLine('Jobs without a provider could not be assigned', { workspace }, error));
    }
    // Before every start, never after: a pending generation whose job already ended is closed. A failure
    // leaves it pending until the next open, and the jobs still run.
    try {
      counts.generationsEnded = await reconcileGenerations(session);
      if (counts.generationsEnded > 0) this.changed();
    } catch (error) {
      writeLine(this.log, errorLogLine('Pending generations could not be reconciled', { workspace }, error));
    }
    return counts;
  }

  /**
   * Lets go of the scheduler and waits for it to stop.
   *
   * @returns when it stopped
   */
  private async stopScheduler(): Promise<void> {
    const { feed } = this.dependencies;
    feed.clear();
    const running = this.scheduler;
    if (running === null) return;
    this.scheduler = null;
    await running.stop();
    // The stopped runs changed rows of the closing workspace.
    feed.clear();
  }

  /**
   * Without a scheduler (none started, or one stopping: the host lets go of it before the stop) nothing runs, so
   * the waiting jobs, or the one named, are ended in the database and their generations settled cancelled. A failed
   * write rejects, so the caller is told the jobs were not cancelled. `read` does not queue, so a caller already
   * inside a workspace read never waits on itself.
   *
   * @param jobId the one job to end; all waiting ones without it
   * @returns how many were ended; 0 without a workspace
   */
  private async cancelWithoutScheduler(jobId?: string): Promise<number> {
    const { manager } = this.dependencies;
    if (manager.current() === null) return 0;
    const cancelled = await manager.read((session) =>
      session.database.jobs.cancelPending({
        ...(jobId === undefined ? {} : { id: jobId }),
        now: session.now().toISOString(),
        settled: (job) => {
          settleGenerationOfJob(session, job, { status: 'cancelled' });
        },
      }),
    );
    if (cancelled > 0) this.changed();
    return cancelled;
  }
}

/**
 * Adds the counts of a scheduler recovery to the counts of an open.
 *
 * @param counts the counts of the open, changed in place
 * @param recovered what the scheduler recovered
 */
function addRecovered(counts: JobRecoveryCounts, recovered: RecoveredJobs): void {
  counts.released += recovered.released;
  counts.retried += recovered.retried;
  counts.failed += recovered.failed;
}

/** Where a scheduler reports its lines and its recoveries. */
interface SchedulerReports {
  /** Takes the scheduler's lines, made safe by `schedulerLogLine`. */
  log: LineLog;
  /** Takes the counts of each recovery that changed a row. */
  onRecovered: (counts: RecoveredJobs) => void;
}

/**
 * The handlers of one open workspace, including discovery when configured.
 *
 * @param dependencies what the handlers run with
 * @param session the open workspace
 * @returns the handlers by job type
 */
function workspaceHandlers(dependencies: JobHostDependencies, session: WorkspaceSession): Record<string, JobHandler> {
  const { feed } = dependencies;
  return {
    ...(dependencies.discovery === undefined
      ? {}
      : { [SITE_CRAWL_JOB]: createSiteDiscoveryHandler(session, dependencies.discovery, dependencies.pause) }),
    [ANALYZE_FILE_JOB]: createAnalyzeFileHandler({
      session,
      vision: dependencies.vision,
      images: dependencies.images,
      provider: dependencies.provider,
      effects: feed,
    }),
    [IMAGE_GENERATE_JOB]: createImageGenerateHandler({
      session,
      providers: dependencies.imageProviders,
      images: dependencies.generationImages,
      effects: feed,
    }),
    [FILE_DOWNLOAD_JOB]: createFileDownloadHandler({
      session,
      remote: dependencies.remote,
      effects: feed,
      ...(dependencies.sites === undefined ? {} : { sites: dependencies.sites }),
    }),
  };
}

/**
 * Creates the scheduler of one open workspace with its configured job handlers.
 *
 * @param dependencies what the scheduler runs with
 * @param session the open workspace
 * @param reports where it reports its lines and recoveries
 * @returns the scheduler, not yet started
 */
function createWorkspaceScheduler(
  dependencies: JobHostDependencies,
  session: WorkspaceSession,
  reports: SchedulerReports,
): Scheduler {
  const { feed, clock } = dependencies;
  return createScheduler({
    // The scheduler's default writes the raw cause; its message and stack carry paths.
    log: (message, cause) => writeLine(reports.log, schedulerLogLine(message, cause)),
    onRecovered: reports.onRecovered,
    jobs: session.database.jobs,
    handlers: workspaceHandlers(dependencies, session),
    limits: dependencies.limits ?? DEFAULT_LIMITS,
    totals: { ...(dependencies.totals ?? DEFAULT_TOTALS), ...(dependencies.discovery === undefined ? {} : { cpu: 1 }) },
    // A cancel of several rows at once names no job.
    onChange: (jobId) => (jobId === null ? feed.jobs() : feed.job(jobId)),
    pause: dependencies.pause,
    laneLimit: (resourceClass, lane) =>
      resourceClass === 'cpu' && dependencies.discovery !== undefined
        ? 1
        : dependencies.laneLimit?.(resourceClass, lane),
    ...(clock === undefined
      ? {}
      : {
          now: () => clock.now(),
          setTimer: (callback, milliseconds) => clock.setTimer(callback, milliseconds),
          clearTimer: (handle) => clock.clearTimer(handle),
        }),
  });
}
