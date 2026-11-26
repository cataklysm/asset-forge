import type { EnqueueAnalysisResult } from '@assetforge/contracts';
import {
  cancelAllJobs,
  cancelJob,
  clearFinishedJobs,
  countJobs,
  enqueueAnalysis,
  InvalidOperationError,
  listJobs,
  retryFailedJobs,
  retryJob,
  type FileEnqueueResult,
  type WorkspaceManager,
} from '@assetforge/core';
import type { IpcHandlers } from './ipc.js';
import type { JobHost } from './job-host.js';

// Kept free of Electron imports. Every repository call is one atomic transaction, so these run
// through `read` rather than the serial queue. No core use case wakes the scheduler; the handlers do.

export type JobHandlers = Pick<
  IpcHandlers,
  | 'analysis:preview'
  | 'analysis:enqueue'
  | 'analysis:getProposal'
  | 'analysis:acceptProposal'
  | 'analysis:discardProposal'
  | 'analysis:describe'
  | 'analysis:cancelDescribe'
  | 'jobs:list'
  | 'jobs:summary'
  | 'jobs:cancel'
  | 'jobs:cancelAll'
  | 'jobs:retry'
  | 'jobs:retryFailed'
  | 'jobs:resume'
  | 'jobs:clearFinished'
>;

const NOT_AVAILABLE = 'This action is not available yet';

// phase 4b stub: Task 8 (the core use case returns the counts itself)
function counted(result: FileEnqueueResult): EnqueueAnalysisResult {
  const skipped = { notFound: 0, notAnalysable: 0, alreadyQueued: 0, alreadyAnalysed: 0 };
  for (const s of result.skipped) {
    if (s.reason === 'not_found') skipped.notFound++;
    else if (s.reason === 'not_analysable') skipped.notAnalysable++;
    else if (s.reason === 'already_queued') skipped.alreadyQueued++;
    else skipped.alreadyAnalysed++;
  }
  return { enqueued: result.enqueued, skipped };
}

export function createJobHandlers(manager: WorkspaceManager, jobs: JobHost): JobHandlers {
  /** A job row changed outside the scheduler: raise the counter and let the scheduler look for work. */
  const touched = () => {
    jobs.changed();
    jobs.wake();
  };

  return {
    // phase 4b stub: Task 8
    'analysis:preview': async () => {
      throw new InvalidOperationError(NOT_AVAILABLE);
    },
    'analysis:enqueue': async (r) => {
      // phase 4b stub: Task 8 (only an explicit file list in apply mode, through the phase 4a use case)
      const { target } = r;
      if (target.kind !== 'files' || r.mode !== 'apply') throw new InvalidOperationError(NOT_AVAILABLE);
      const result = await manager.read((s) => enqueueAnalysis(s, { fileIds: target.fileIds }));
      if (result.enqueued > 0) touched();
      return counted(result);
    },
    // phase 4b stub: Task 8
    'analysis:getProposal': async () => {
      throw new InvalidOperationError(NOT_AVAILABLE);
    },
    // phase 4b stub: Task 8
    'analysis:acceptProposal': async () => {
      throw new InvalidOperationError(NOT_AVAILABLE);
    },
    // phase 4b stub: Task 8
    'analysis:discardProposal': async () => {
      throw new InvalidOperationError(NOT_AVAILABLE);
    },
    // phase 4b stub: Task 8
    'analysis:describe': async () => {
      throw new InvalidOperationError(NOT_AVAILABLE);
    },
    // phase 4b stub: Task 8
    'analysis:cancelDescribe': async () => {
      throw new InvalidOperationError(NOT_AVAILABLE);
    },
    'jobs:list': (r) => manager.read((s) => listJobs(s, r)),
    // phase 4b stub: Task 8 (paused comes from the pause gate)
    'jobs:summary': async () => ({ ...(await manager.read((s) => countJobs(s))), changes: jobs.changes(), paused: null }),
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
    // phase 4b stub: Task 8
    'jobs:resume': async () => {
      throw new InvalidOperationError(NOT_AVAILABLE);
    },
    'jobs:clearFinished': async () => {
      const removed = await manager.read((s) => clearFinishedJobs(s));
      if (removed > 0) touched();
      return { removed };
    },
  };
}
