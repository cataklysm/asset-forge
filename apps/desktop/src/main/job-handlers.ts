import { IMAGE_GENERATE_JOB, ImageGeneratePayloadSchema, JOB_ERROR_MESSAGES, type ProviderKind } from '@assetforge/contracts';
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
  InvalidOperationError,
  laneName,
  listJobs,
  listWaitingLanes,
  NotFoundError,
  previewAnalysis,
  ProviderNotConfiguredError,
  rerouteJobs,
  retryFailedJobs,
  retryGeneration,
  retryJob,
  type ImageProviderDirectory,
  type WorkspaceManager,
  type WorkspaceSession,
} from '@assetforge/core';
import type { AnalysisPromptStore } from './analysis-prompts.js';
import type { DescribeController } from './describe-controller.js';
import type { IpcHandlers } from './ipc.js';
import type { JobHost } from './job-host.js';
import { CANNOT_ANALYSE, type ProviderStore } from './provider-store.js';

const GENERATION_NOT_FOUND = 'This generation does not exist';

/** The provider name stored with the generation of the lane's newest generation job; null when there is none. */
async function generationLaneName(s: WorkspaceSession, lane: string | null): Promise<string | null> {
  const parsed = ImageGeneratePayloadSchema.safeParse(await s.database.jobs.latestPayloadOfLane(IMAGE_GENERATE_JOB, lane));
  if (!parsed.success) return null;
  return (await s.database.generations.get(parsed.data.generationId))?.providerName ?? null;
}

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
  | 'jobs:resumeHost'
  | 'jobs:reroute'
  | 'jobs:clearFinished'
>;

export function createJobHandlers(
  manager: WorkspaceManager,
  jobs: JobHost,
  describe: DescribeController,
  prompts: AnalysisPromptStore,
  providers: ProviderStore,
  imageProviders: ImageProviderDirectory,
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
  /** True when the lane belongs to an existing `venice` entry: its jobs are generations, never analyses. */
  const isImageLane = (lane: string | null): boolean => lane !== null && providers.get(lane)?.kind === 'venice';

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
        items: page.items.map((job) => ({ ...job, providerName: nameOf(job.providerId, job.providerName) })),
      };
    },
    'jobs:summary': async () =>
      manager.read(async (s) => {
        const counts = await countJobs(s);
        const paused = [];
        const pausedHosts = [];
        for (const { lane, reason, resourceClass } of jobs.paused()) {
          // A download lane is the host of its URLs; a download job always has one.
          if (resourceClass === 'io') {
            if (lane !== null) pausedHosts.push({ host: lane, reason });
            continue;
          }
          // A generation lane pauses only for a venice entry; an analysis lane only for an ollama one.
          const kind: ProviderKind = resourceClass === 'remote_api' ? 'venice' : 'ollama';
          const providerName = nameOf(lane, null) ?? (kind === 'ollama' ? await laneName(s, lane) : await generationLaneName(s, lane));
          paused.push({ providerId: lane, providerName, kind, reason });
        }
        return { ...counts, changes: jobs.changes(), paused, pausedHosts };
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
      await manager.read(async (s) => {
        const job = await s.database.jobs.get(r.jobId);
        if (job?.type !== IMAGE_GENERATE_JOB) return retryJob(s, r.jobId);
        // A generation runs again as itself, with a new job and its stored settings, never as the old job row.
        const parsed = ImageGeneratePayloadSchema.safeParse(job.payload);
        const id = (await s.database.generations.byJob(job.id))?.id ?? (parsed.success ? parsed.data.generationId : null);
        if (id === null || (await s.database.generations.get(id)) === null) throw new NotFoundError(GENERATION_NOT_FOUND);
        await retryGeneration(s, { providers: imageProviders, control: jobs }, id);
      });
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
        (await listWaitingLanes(s))
          // Jobs in a venice lane can be moved to no analysis provider, so that lane is never offered.
          .filter(({ lane }) => !isImageLane(lane))
          .map(({ lane, payloadName, waiting }) => ({
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
    // Like `jobs:resume`: a paused download host belongs to the app session, not to a workspace.
    'jobs:resumeHost': async (r) => {
      jobs.resume(r.host);
      return {};
    },
    // The target's pause is not lifted: the moved jobs wait in its lane until it is resumed. The source lane
    // has no waiting jobs left, so its pause ends; resume already raises the counter and wakes the scheduler.
    'jobs:reroute': async (r) => {
      const result = await manager.read((s) => {
        // Only analysis jobs move, and only between analysis entries; generation jobs never move.
        if (isImageLane(r.fromProviderId)) throw new InvalidOperationError(CANNOT_ANALYSE);
        const to = providers.resolve(r.toProviderId, 'ollama')!;
        return rerouteJobs(s, { fromLane: r.fromProviderId, to: { id: to.id, name: to.name }, model: r.model });
      });
      if (result.moved > 0) jobs.resume(r.fromProviderId);
      return result;
    },
    'jobs:clearFinished': async () => {
      const removed = await manager.read((s) => clearFinishedJobs(s));
      if (removed > 0) touched();
      return { removed };
    },
  };
}
