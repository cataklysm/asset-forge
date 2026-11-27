import {
  ANALYZE_FILE_JOB,
  FILE_DOWNLOAD_JOB,
  IMAGE_GENERATE_JOB,
  type Changes,
  type JobErrorCode,
  type ResourceClass,
} from '@assetforge/contracts';
import {
  assignUnroutedJobs,
  createAnalyzeFileHandler,
  createFileDownloadHandler,
  createImageGenerateHandler,
  reconcileGenerations,
  type GenerationImageSource,
  type ImageProviderDirectory,
  type JobControl,
  type ModelImageSource,
  type RemoteFileSource,
  type VisionProvider,
  type WorkspaceManager,
} from '@assetforge/core';
import { createScheduler, DEFAULT_LIMITS, DEFAULT_TOTALS, type PauseGate, type Scheduler } from '@assetforge/jobs';
import type { ChangeFeed } from './change-feed.js';

// Kept free of Electron imports. One scheduler per open workspace: the host starts it after a
// workspace opened and stops it before the workspace closes, so no job touches a closing database.
// The pause gate belongs to the app session and is handed to every scheduler, so a pause outlives
// closing and reopening a workspace. An analysis job (local_gpu) and a generation job (remote_api) run in the
// lane of their provider entry (the entry id), a download job (io) in the lane of its URL's host; limit, claim
// and pause work per resource class and lane.

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
   * and a download host may be the same string, so a resume never reaches the queues of the other kind. Never throws.
   */
  resume(lane: string | null, classes: readonly ResourceClass[]): void;
}

/** The scheduler's clock and timers. */
export interface SchedulerClock {
  now(): Date;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface JobHostDeps {
  manager: WorkspaceManager;
  /**
   * Takes every change: a job the scheduler changed, jobs changed in bulk, and what the handlers report. Cleared
   * when a workspace opens and when it closes.
   */
  feed: ChangeFeed;
  /** The adapter of a lane (a provider entry id) when a job runs; null when no such entry exists. */
  vision: (lane: string | null) => VisionProvider | null;
  images: ModelImageSource;
  /** The fingerprint provider id of a lane (the kind of its vision entry); null when the lane has no vision entry. */
  provider: (lane: string | null) => string | null;
  pause: PauseGate;
  /** The entry that active analysis jobs without a provider are assigned to when a workspace opens; null when there is none. */
  firstEntry: () => { id: string; name: string; taggingModel: string | null } | null;
  /** The entries of the image purpose (the `venice` kind) that generation jobs resolve and run on. */
  imageProviders: ImageProviderDirectory;
  /** Reads the image a generation sends. */
  generationImages: GenerationImageSource;
  /** The network side of the URL import's download jobs. */
  remote: RemoteFileSource;
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

export function createJobHost(deps: JobHostDeps): JobHost {
  const { manager, pause, clock, feed } = deps;
  let scheduler: Scheduler | null = null;
  const changed = () => feed.jobs();
  // Opening and closing run one after the other, so a stop never overlaps the start of the next scheduler.
  let lifecycle: Promise<void> = Promise.resolve();
  const serial = (fn: () => Promise<void>): Promise<void> => {
    const next = lifecycle.then(fn).catch((error: unknown) => console.error('The job scheduler failed', error));
    lifecycle = next;
    return next;
  };

  return {
    workspaceOpened: () =>
      serial(async () => {
        // A cursor of the workspace before must never answer changes of this one.
        feed.clear();
        if (scheduler !== null || manager.current() === null) return;
        // The session stays valid until `workspaceClosing` resolved: the workspace closes only after it.
        const session = await manager.read(async (s) => s);
        // Before the scheduler claims, so every waiting job runs in the lane the list shows.
        // A failure here must not keep the scheduler from starting: the jobs that already have a lane still run.
        try {
          const entry = await deps.firstEntry();
          if (entry !== null && (await assignUnroutedJobs(session, entry)) > 0) changed();
        } catch {
          console.error('Jobs without a provider could not be assigned');
        }
        // Before every start, never after: a pending generation whose job already ended is closed. A failure
        // leaves it pending until the next open, and the jobs still run.
        try {
          if ((await reconcileGenerations(session)) > 0) changed();
        } catch {
          console.error('Pending generations could not be reconciled');
        }
        const created = createScheduler({
          jobs: session.database.jobs,
          handlers: {
            [ANALYZE_FILE_JOB]: createAnalyzeFileHandler({
              session,
              vision: deps.vision,
              images: deps.images,
              provider: deps.provider,
              effects: feed,
            }),
            [IMAGE_GENERATE_JOB]: createImageGenerateHandler({
              session,
              providers: deps.imageProviders,
              images: deps.generationImages,
              effects: feed,
            }),
            [FILE_DOWNLOAD_JOB]: createFileDownloadHandler({ session, remote: deps.remote, effects: feed }),
          },
          limits: deps.limits ?? DEFAULT_LIMITS,
          totals: deps.totals ?? DEFAULT_TOTALS,
          // A cancel of several rows at once names no job.
          onChange: (jobId) => (jobId === null ? feed.jobs() : feed.job(jobId)),
          pause,
          ...(deps.laneLimit === undefined ? {} : { laneLimit: deps.laneLimit }),
          ...(clock === undefined
            ? {}
            : { now: () => clock.now(), setTimer: (fn, ms) => clock.setTimer(fn, ms), clearTimer: (h) => clock.clearTimer(h) }),
        });
        scheduler = created;
        await created.start();
      }),

    workspaceClosing: () =>
      serial(async () => {
        feed.clear();
        const running = scheduler;
        if (running === null) return;
        scheduler = null;
        await running.stop();
        // The stopped runs changed rows of the closing workspace.
        feed.clear();
      }),

    wake() {
      scheduler?.wake();
    },

    async cancel(jobId, options) {
      await scheduler?.cancel(jobId, options);
    },

    // Without a scheduler nothing runs; a generation left pending is closed by the reconcile on the next open.
    cancelAll: async () => (scheduler === null ? 0 : scheduler.cancelAll()),

    changes: () => feed.total(),
    changed,
    changesSince: (cursor) => feed.since(cursor),

    paused: () =>
      PAUSABLE.flatMap((resourceClass) => pause.paused(resourceClass).map(({ lane, reason }) => ({ lane, reason, resourceClass }))),

    resume(lane, classes) {
      for (const resourceClass of classes) {
        try {
          pause.resume(resourceClass, lane);
        } catch (cause) {
          console.error('The job pause could not be ended', cause);
        }
      }
      changed();
      scheduler?.wake();
    },
  };
}
