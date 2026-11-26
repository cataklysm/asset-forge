import {
  cancelAllJobs,
  cancelJob,
  clearFinishedJobs,
  countJobs,
  enqueueAnalysis,
  listJobs,
  retryFailedJobs,
  retryJob,
  type WorkspaceManager,
} from '@assetforge/core';
import type { IpcHandlers } from './ipc.js';
import type { JobHost } from './job-host.js';

// Kept free of Electron imports. Every repository call is one atomic transaction, so these run
// through `read` rather than the serial queue. No core use case wakes the scheduler; the handlers do.

export type JobHandlers = Pick<
  IpcHandlers,
  | 'analysis:enqueue'
  | 'jobs:list'
  | 'jobs:summary'
  | 'jobs:cancel'
  | 'jobs:cancelAll'
  | 'jobs:retry'
  | 'jobs:retryFailed'
  | 'jobs:clearFinished'
>;

export function createJobHandlers(manager: WorkspaceManager, jobs: JobHost): JobHandlers {
  /** A job row changed outside the scheduler: raise the counter and let the scheduler look for work. */
  const touched = () => {
    jobs.changed();
    jobs.wake();
  };

  return {
    'analysis:enqueue': async (r) => {
      const result = await manager.read((s) => enqueueAnalysis(s, r));
      if (result.enqueued > 0) touched();
      return result;
    },
    'jobs:list': (r) => manager.read((s) => listJobs(s, r)),
    'jobs:summary': async () => ({ ...(await manager.read((s) => countJobs(s))), changes: jobs.changes() }),
    'jobs:cancel': async (r) => {
      await manager.read((s) => cancelJob(s, jobs, r.jobId));
      touched();
      return {};
    },
    'jobs:cancelAll': async () => {
      const cancelled = await manager.read((s) => cancelAllJobs(s, jobs));
      if (cancelled > 0) touched();
      return { cancelled };
    },
    'jobs:retry': async (r) => {
      await manager.read((s) => retryJob(s, r.jobId));
      touched();
      return {};
    },
    'jobs:retryFailed': async () => {
      const retried = await manager.read((s) => retryFailedJobs(s));
      if (retried > 0) touched();
      return { retried };
    },
    'jobs:clearFinished': async () => {
      const removed = await manager.read((s) => clearFinishedJobs(s));
      if (removed > 0) touched();
      return { removed };
    },
  };
}
