import { ANALYZE_FILE_JOB, type JobErrorCode, type ResourceClass } from '@assetforge/contracts';
import {
  assignUnroutedJobs,
  createAnalyzeFileHandler,
  type JobControl,
  type ModelImageSource,
  type VisionProvider,
  type WorkspaceManager,
} from '@assetforge/core';
import { createScheduler, DEFAULT_LIMITS, type PauseGate, type Scheduler } from '@assetforge/jobs';

// Kept free of Electron imports. One scheduler per open workspace: the host starts it after a
// workspace opened and stops it before the workspace closes, so no job touches a closing database.
// The pause gate belongs to the app session and is handed to every scheduler, so a pause outlives
// closing and reopening a workspace. An analysis job runs in the lane of its provider entry (the entry id);
// limit, claim and pause work per lane.

export interface JobHost extends JobControl {
  /** Starts a scheduler for the open workspace; no-op without one or when one runs. Never rejects. */
  workspaceOpened(): Promise<void>;
  /** Stops the scheduler and waits for its jobs; no-op without one. Never rejects. */
  workspaceClosing(): Promise<void>;
  changes(): number;
  /** For the IPC handlers: a job changed outside the scheduler. */
  changed(): void;
  /** The paused lanes of the analysis queue with their codes, in the order they paused; `null` is the jobs without a provider. */
  paused(): { lane: string | null; reason: JobErrorCode }[];
  /** Ends the pause of one lane of the analysis queue and lets the scheduler claim again. Never throws. */
  resume(lane: string | null): void;
}

export interface JobHostDeps {
  manager: WorkspaceManager;
  /** The adapter of a lane (a provider entry id) when a job runs; null when no such entry exists. */
  vision: (lane: string | null) => VisionProvider | null;
  images: ModelImageSource;
  /** Adapter kind recorded with every analysis. */
  provider: string;
  pause: PauseGate;
  /** The entry that active analysis jobs without a provider are assigned to when a workspace opens; null when there is none. */
  firstEntry: () => { id: string; name: string; taggingModel: string | null } | null;
  limits?: Record<ResourceClass, number>;
}

/** The resource class of the analysis queue. */
const ANALYSIS_CLASS: ResourceClass = 'local_gpu';

export function createJobHost(deps: JobHostDeps): JobHost {
  const { manager, pause } = deps;
  let scheduler: Scheduler | null = null;
  let changes = 0;
  const changed = () => {
    changes += 1;
  };
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
        const created = createScheduler({
          jobs: session.database.jobs,
          handlers: {
            [ANALYZE_FILE_JOB]: createAnalyzeFileHandler({
              session,
              vision: deps.vision,
              images: deps.images,
              provider: deps.provider,
            }),
          },
          limits: deps.limits ?? DEFAULT_LIMITS,
          onChange: changed,
          pause,
        });
        scheduler = created;
        await created.start();
      }),

    workspaceClosing: () =>
      serial(async () => {
        const running = scheduler;
        if (running === null) return;
        scheduler = null;
        await running.stop();
      }),

    wake() {
      scheduler?.wake();
    },

    async cancel(jobId) {
      await scheduler?.cancel(jobId);
    },

    changes: () => changes,
    changed,

    paused: () => pause.paused(ANALYSIS_CLASS),

    resume(lane) {
      try {
        pause.resume(ANALYSIS_CLASS, lane);
      } catch (cause) {
        console.error('The job pause could not be ended', cause);
      }
      changed();
      scheduler?.wake();
    },
  };
}
