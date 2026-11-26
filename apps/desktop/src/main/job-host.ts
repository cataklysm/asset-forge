import { ANALYZE_FILE_JOB, type JobErrorCode, type ResourceClass } from '@assetforge/contracts';
import { createAnalyzeFileHandler, type JobControl, type ModelImageSource, type WorkspaceManager } from '@assetforge/core';
import { createScheduler, DEFAULT_LIMITS, type PauseGate, type Scheduler } from '@assetforge/jobs';
import type { VisionGateway } from './vision-gateway.js';

// Kept free of Electron imports. One scheduler per open workspace: the host starts it after a
// workspace opened and stops it before the workspace closes, so no job touches a closing database.
// The pause gate belongs to the app session and is handed to every scheduler, so a pause outlives
// closing and reopening a workspace.

export interface JobHost extends JobControl {
  /** Starts a scheduler for the open workspace; no-op without one or when one runs. Never rejects. */
  workspaceOpened(): Promise<void>;
  /** Stops the scheduler and waits for its jobs; no-op without one. Never rejects. */
  workspaceClosing(): Promise<void>;
  changes(): number;
  /** For the IPC handlers: a job changed outside the scheduler. */
  changed(): void;
  /** The code that paused the analysis queue, or null. */
  paused(): JobErrorCode | null;
  /** Ends a pause of the analysis queue and lets the scheduler claim again. Never throws. */
  resume(): void;
}

export interface JobHostDeps {
  manager: WorkspaceManager;
  /** The adapter in force when a job runs; null when no provider is configured. */
  gateway: Pick<VisionGateway, 'current'>;
  images: ModelImageSource;
  /** Provider id recorded with every analysis. */
  provider: string;
  /** The tagging default model at run time; null when none is set. */
  defaultModel: () => string | null;
  pause: PauseGate;
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
        const created = createScheduler({
          jobs: session.database.jobs,
          handlers: {
            [ANALYZE_FILE_JOB]: createAnalyzeFileHandler({
              session,
              vision: () => deps.gateway.current(),
              images: deps.images,
              provider: deps.provider,
              defaultModel: deps.defaultModel,
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

    paused: () => pause.reason(ANALYSIS_CLASS),

    resume() {
      try {
        pause.resume(ANALYSIS_CLASS);
      } catch (cause) {
        console.error('The job pause could not be ended', cause);
      }
      changed();
      scheduler?.wake();
    },
  };
}
