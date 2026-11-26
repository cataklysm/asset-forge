import { ANALYZE_FILE_JOB, JOB_ERROR_MESSAGES } from '@assetforge/contracts';
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
  laneName,
  listJobs,
  listWaitingLanes,
  NotFoundError,
  previewAnalysis,
  ProviderNotConfiguredError,
  rerouteJobs,
  retryFailedJobs,
  retryJob,
  type WorkspaceManager,
} from '@assetforge/core';
import type { AnalysisPromptStore } from './analysis-prompts.js';
import type { DescribeController } from './describe-controller.js';
import type { IpcHandlers } from './ipc.js';
import type { JobHost } from './job-host.js';
import { PROVIDER_NOT_FOUND, type ProviderStore } from './provider-store.js';

// Kept free of Electron imports. Every repository call is one atomic transaction, so these run
// through `read` rather than the serial queue; accepting and discarding a proposal change tags and
// go through `exclusive` like every other tag change. No core use case wakes the scheduler; the handlers do.
// Prompt and provider entry are resolved inside the workspace read, so without a workspace a call
// answers no_workspace_open whatever the ids.

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
  | 'jobs:waitingByProvider'
  | 'jobs:resume'
  | 'jobs:reroute'
  | 'jobs:clearFinished'
>;

export function createJobHandlers(
  manager: WorkspaceManager,
  jobs: JobHost,
  describe: DescribeController,
  prompts: AnalysisPromptStore,
  providers: ProviderStore,
): JobHandlers {
  /** A job row changed outside the scheduler: raise the counter and let the scheduler look for work. */
  const touched = () => {
    jobs.changed();
    jobs.wake();
  };
  /** The entry a preview or an enqueue runs on: the given one (else not_found), the one used last, the first. */
  const entryFor = (providerId: string | undefined) => {
    const entry = providers.resolve(providerId);
    if (entry === null) throw new ProviderNotConfiguredError(JOB_ERROR_MESSAGES.provider_not_configured);
    return entry;
  };
  /** The current name of an existing entry; otherwise the name copied into a payload, if any. */
  const nameOf = (lane: string | null, copied: string | null): string | null =>
    (lane === null ? null : providers.get(lane)?.name) ?? copied;

  return {
    'analysis:preview': (r) =>
      manager.read((s) => {
        const entry = entryFor(r.providerId);
        return previewAnalysis(s, { target: r.target, model: r.model, provider: OLLAMA_PROVIDER, entry });
      }),
    'analysis:enqueue': async (r) => {
      const { target, model, mode, force } = r;
      const result = await manager.read(async (s) => {
        const prompt = prompts.resolve('tagging', r.promptId);
        const entry = entryFor(r.providerId);
        const { name, text, maxTags } = prompt;
        const counts = await enqueueAnalysis(s, {
          target,
          model,
          mode,
          force,
          provider: OLLAMA_PROVIDER,
          prompt: { name, text, maxTags },
          entry: { id: entry.id, name: entry.name },
        });
        // Also when nothing was queued: the owner chose this prompt and this provider. Neither throws.
        prompts.markUsed(prompt);
        providers.markUsed(entry.id);
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
      manager.read(async () => {
        const prompt = prompts.resolve('image_prompt', r.promptId);
        const entry = providers.resolve(r.providerId);
        if (entry === null) {
          // As before several providers: the request was accepted and found no provider.
          prompts.markUsed(prompt);
          return { ok: false as const, code: 'provider_not_configured' as const };
        }
        const result = await describe.describe({
          requestId: r.requestId,
          fileId: r.fileId,
          model: r.model,
          prompt: prompt.text,
          providerId: entry.id,
        });
        // A busy answer never ran; every other answer, including a cancelled one, counts as an accepted request.
        if (result.ok || result.code !== 'busy') {
          prompts.markUsed(prompt);
          providers.markUsed(entry.id);
        }
        return result;
      }),
    'analysis:cancelDescribe': async (r) => {
      await manager.read(async () => describe.cancel(r.requestId));
      return {};
    },
    'jobs:list': async (r) => {
      const { limit, offset, status, providerId } = r;
      const page = await manager.read((s) =>
        listJobs(s, {
          limit,
          offset,
          ...(status === undefined ? {} : { status }),
          ...(providerId === undefined ? {} : { lane: providerId }),
        }),
      );
      return {
        ...page,
        items: page.items.map((job) =>
          job.type === ANALYZE_FILE_JOB ? { ...job, providerName: nameOf(job.providerId, job.providerName) } : job,
        ),
      };
    },
    'jobs:summary': async () =>
      manager.read(async (s) => {
        const counts = await countJobs(s);
        const paused = [];
        for (const { lane, reason } of jobs.paused()) {
          const providerName = nameOf(lane, null) ?? (await laneName(s, lane));
          paused.push({ providerId: lane, providerName, reason });
        }
        return { ...counts, changes: jobs.changes(), paused };
      }),
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
    'jobs:waitingByProvider': () =>
      manager.read(async (s) =>
        (await listWaitingLanes(s)).map(({ lane, payloadName, waiting }) => ({
          providerId: lane,
          providerName: nameOf(lane, payloadName),
          waiting,
        })),
      ),
    // The pause belongs to the app session, so this works without an open workspace.
    'jobs:resume': async (r) => {
      jobs.resume(r.providerId);
      return {};
    },
    // The target's pause is not lifted: the moved jobs wait in its lane until it is resumed.
    'jobs:reroute': async (r) => {
      const result = await manager.read((s) => {
        const to = providers.get(r.toProviderId);
        if (to === null) throw new NotFoundError(PROVIDER_NOT_FOUND);
        return rerouteJobs(s, { fromLane: r.fromProviderId, to: { id: to.id, name: to.name }, model: r.model });
      });
      touched();
      return result;
    },
    'jobs:clearFinished': async () => {
      const removed = await manager.read((s) => clearFinishedJobs(s));
      if (removed > 0) touched();
      return { removed };
    },
  };
}
