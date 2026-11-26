import { OLLAMA_PROVIDER } from '@assetforge/providers';
import {
  acceptProposal,
  builtInAnalysisPrompt,
  cancelAllJobs,
  cancelJob,
  clearFinishedJobs,
  countJobs,
  discardProposal,
  enqueueAnalysis,
  getProposal,
  listJobs,
  previewAnalysis,
  retryFailedJobs,
  retryJob,
  type WorkspaceManager,
} from '@assetforge/core';
import type { DescribeController } from './describe-controller.js';
import type { IpcHandlers } from './ipc.js';
import type { JobHost } from './job-host.js';

// Kept free of Electron imports. Every repository call is one atomic transaction, so these run
// through `read` rather than the serial queue; accepting and discarding a proposal change tags and
// go through `exclusive` like every other tag change. No core use case wakes the scheduler; the handlers do.

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

export function createJobHandlers(manager: WorkspaceManager, jobs: JobHost, describe: DescribeController): JobHandlers {
  /** A job row changed outside the scheduler: raise the counter and let the scheduler look for work. */
  const touched = () => {
    jobs.changed();
    jobs.wake();
  };

  return {
    'analysis:preview': (r) =>
      manager.read((s) => previewAnalysis(s, { target: r.target, model: r.model, provider: OLLAMA_PROVIDER })),
    'analysis:enqueue': async (r) => {
      const { target, model, mode, force } = r;
      // Stopgap until the prompt store is wired (Task 4).
      const prompt = { name: 'Default', text: builtInAnalysisPrompt('tagging').text, maxTags: 15 };
      const result = await manager.read((s) => enqueueAnalysis(s, { target, model, mode, force, provider: OLLAMA_PROVIDER, prompt }));
      if (result.enqueued > 0) touched();
      return result;
    },
    'analysis:getProposal': (r) => manager.read((s) => getProposal(s, r.fileId)),
    'analysis:acceptProposal': async (r) => {
      await manager.exclusive((s) => acceptProposal(s, { fileId: r.fileId, names: r.names }));
      return {};
    },
    'analysis:discardProposal': async (r) => {
      await manager.exclusive((s) => discardProposal(s, r.fileId));
      return {};
    },
    'analysis:describe': (r) => manager.read(() => describe.describe(r)),
    'analysis:cancelDescribe': async (r) => {
      await manager.read(async () => describe.cancel(r.requestId));
      return {};
    },
    'jobs:list': (r) => manager.read((s) => listJobs(s, r)),
    'jobs:summary': async () => {
      const counts = await manager.read((s) => countJobs(s));
      const reason = jobs.paused();
      return { ...counts, changes: jobs.changes(), paused: reason === null ? null : { reason } };
    },
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
    // The pause belongs to the app session, so this works without an open workspace.
    'jobs:resume': async () => {
      jobs.resume();
      return {};
    },
    'jobs:clearFinished': async () => {
      const removed = await manager.read((s) => clearFinishedJobs(s));
      if (removed > 0) touched();
      return { removed };
    },
  };
}
