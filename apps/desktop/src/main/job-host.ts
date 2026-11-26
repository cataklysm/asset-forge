import { ANALYZE_FILE_JOB, type ResourceClass } from '@assetforge/contracts';
import {
  createAnalyzeFileHandler,
  type JobControl,
  type ModelImageSource,
  type VisionProvider,
  type WorkspaceManager,
} from '@assetforge/core';
import { createScheduler, DEFAULT_LIMITS, type Scheduler } from '@assetforge/jobs';

// Kept free of Electron imports. One scheduler per open workspace: the host starts it after a
// workspace opened and stops it before the workspace closes, so no job touches a closing database.

export interface JobHost extends JobControl {
  /** Starts a scheduler for the open workspace; no-op without one or when one runs. Never rejects. */
  workspaceOpened(): Promise<void>;
  /** Stops the scheduler and waits for its jobs; no-op without one. Never rejects. */
  workspaceClosing(): Promise<void>;
  changes(): number;
  /** For the IPC handlers: a job changed outside the scheduler. */
  changed(): void;
}

export interface JobHostDeps {
  manager: WorkspaceManager;
  vision: VisionProvider;
  images: ModelImageSource;
  /** Provider and model recorded with every analysis. */
  provider: string;
  model: string;
  limits?: Record<ResourceClass, number>;
}

export function createJobHost(deps: JobHostDeps): JobHost {
  const { manager } = deps;
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
              vision: deps.vision,
              images: deps.images,
              provider: deps.provider,
              model: deps.model,
            }),
          },
          limits: deps.limits ?? DEFAULT_LIMITS,
          onChange: changed,
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
  };
}
