import { OLLAMA_PROVIDER } from '@assetforge/providers';
import {
  acceptProposal,
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
import type { AnalysisPromptStore } from './analysis-prompts.js';
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

export function createJobHandlers(
  manager: WorkspaceManager,
  jobs: JobHost,
  describe: DescribeController,
  prompts: AnalysisPromptStore,
): JobHandlers {
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
      // Inside the read, so without a workspace the call answers no_workspace_open whatever the id.
      const result = await manager.read(async (s) => {
        const prompt = prompts.resolve('tagging', r.promptId);
        const { name, text, maxTags } = prompt;
        const counts = await enqueueAnalysis(s, { target, model, mode, force, provider: OLLAMA_PROVIDER, prompt: { name, text, maxTags } });
        // Also when nothing was queued: the owner chose this prompt. Never throws.
        prompts.markUsed(prompt);
        return counts;
      });
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
    'analysis:describe': (r) =>
      // Inside the read, so without a workspace the call answers no_workspace_open whatever the id.
      manager.read(async () => {
        const prompt = prompts.resolve('image_prompt', r.promptId);
        const result = await describe.describe({ requestId: r.requestId, fileId: r.fileId, model: r.model, prompt: prompt.text });
        // A busy answer never ran this prompt; every other answer did, or was cancelled after it started.
        if (result.ok || result.code !== 'busy') prompts.markUsed(prompt);
        return result;
      }),
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
