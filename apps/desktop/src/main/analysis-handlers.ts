import { JOB_ERROR_MESSAGES } from '@assetforge/contracts';
import {
  acceptProposal,
  discardProposal,
  enqueueAnalysis,
  getProposal,
  previewAnalysis,
  ProviderNotConfiguredError,
  type WorkspaceManager,
  type WorkspaceSession,
} from '@assetforge/core';
import type { AnalysisPromptStore } from './analysis-prompts.js';
import type { DescribeController } from './describe-controller.js';
import type { IpcHandlers, IpcRequest, IpcResponse } from './ipc.js';
import { markJobsChanged } from './job-handlers.js';
import type { JobHost } from './job-host.js';
import type { ProviderEntry } from './provider-entry.js';
import type { ProviderStore } from './provider-store.js';

// Kept free of Electron imports. Every repository call is one atomic transaction, so these run
// through `read` rather than the serial queue; accepting and discarding a proposal change tags and
// go through `exclusive` like every other tag change. No core use case wakes the scheduler; the handlers do.
// Prompt and provider entry are resolved inside the workspace read, so without a workspace a call
// answers no_workspace_open whatever the ids.

/** The `analysis:*` channels. */
export type AnalysisHandlers = Pick<
  IpcHandlers,
  | 'analysis:preview'
  | 'analysis:enqueue'
  | 'analysis:getProposal'
  | 'analysis:acceptProposal'
  | 'analysis:discardProposal'
  | 'analysis:describe'
  | 'analysis:cancelDescribe'
>;

/** What the analysis channels work with. */
export interface AnalysisHandlerDependencies {
  /** The workspace manager. */
  manager: WorkspaceManager;
  /** The job host the queued analyses run on. */
  jobs: JobHost;
  /** Runs Image2Prompt one request at a time. */
  describe: DescribeController;
  /** The analysis prompts. */
  prompts: AnalysisPromptStore;
  /** The provider entries. */
  providers: ProviderStore;
}

/**
 * Builds the `analysis:*` channels.
 *
 * @param dependencies what the channels work with
 * @returns one handler per channel
 */
export function createAnalysisHandlers(dependencies: AnalysisHandlerDependencies): AnalysisHandlers {
  const { manager, describe } = dependencies;
  return {
    'analysis:preview': (request) => manager.read((session) => previewIn(dependencies, session, request)),
    'analysis:enqueue': (request) => enqueue(dependencies, request),
    'analysis:getProposal': (request) => manager.read((session) => getProposal(session, request.fileId)),
    'analysis:acceptProposal': (request) => acceptInWorkspace(manager, request),
    'analysis:discardProposal': (request) => discardInWorkspace(manager, request),
    'analysis:describe': (request) => manager.read(() => describeImage(dependencies, request)),
    'analysis:cancelDescribe': (request) => cancelDescribe(manager, describe, request),
  };
}

/**
 * The entry a preview or an enqueue runs on: the given one (else not_found), the one used last, the first.
 *
 * @param providers the provider entries
 * @param providerId the entry the request named, if any
 * @returns the entry
 * @throws ProviderNotConfiguredError when there is no entry at all
 */
function entryFor(providers: ProviderStore, providerId: string | undefined): ProviderEntry {
  const entry = providers.resolve(providerId);
  if (entry === null) throw new ProviderNotConfiguredError(JOB_ERROR_MESSAGES.provider_not_configured);
  return entry;
}

/**
 * Counts what an analysis start would queue and skip.
 *
 * @param dependencies the provider entries
 * @param session the open workspace
 * @param request the preview request
 * @returns the counts
 */
function previewIn(
  dependencies: AnalysisHandlerDependencies,
  session: WorkspaceSession,
  request: IpcRequest<'analysis:preview'>,
): Promise<IpcResponse<'analysis:preview'>> {
  const entry = entryFor(dependencies.providers, request.providerId);
  return previewAnalysis(session, { target: request.target, model: request.model, provider: entry.kind, entry });
}

/**
 * Queues the analysis jobs and wakes the scheduler when one was queued.
 *
 * @param dependencies what the channel works with
 * @param request the enqueue request
 * @returns the counts
 */
async function enqueue(
  dependencies: AnalysisHandlerDependencies,
  request: IpcRequest<'analysis:enqueue'>,
): Promise<IpcResponse<'analysis:enqueue'>> {
  const result = await dependencies.manager.read((session) => enqueueIn(dependencies, session, request));
  if (result.enqueued > 0) markJobsChanged(dependencies.jobs);
  return result;
}

/**
 * Queues the analysis jobs inside the workspace read, on the resolved prompt and entry.
 *
 * @param dependencies the prompts and provider entries
 * @param session the open workspace
 * @param request the enqueue request
 * @returns the counts
 */
async function enqueueIn(
  dependencies: AnalysisHandlerDependencies,
  session: WorkspaceSession,
  request: IpcRequest<'analysis:enqueue'>,
): Promise<IpcResponse<'analysis:enqueue'>> {
  const { prompts, providers } = dependencies;
  const { target, model, mode, force } = request;
  const prompt = prompts.resolve('tagging', request.promptId);
  const entry = entryFor(providers, request.providerId);
  const { name, text, maxTags } = prompt;
  const counts = await enqueueAnalysis(session, {
    target,
    model,
    mode,
    force,
    // The fingerprint provider id is the entry's kind, equal to OLLAMA_PROVIDER or OPENAI_PROVIDER.
    provider: entry.kind,
    prompt: { name, text, maxTags },
    entry: { id: entry.id, name: entry.name },
  });
  // Also when nothing was queued: the owner chose this prompt and this provider. Neither throws.
  prompts.markUsed(prompt);
  providers.markUsed(entry.id);
  return counts;
}

/**
 * Accepts the stored tag proposal of a file.
 *
 * @param manager the workspace manager
 * @param request the file, the creation time of the proposal the owner saw and the accepted names
 * @returns an empty answer
 */
async function acceptInWorkspace(
  manager: WorkspaceManager,
  request: IpcRequest<'analysis:acceptProposal'>,
): Promise<IpcResponse<'analysis:acceptProposal'>> {
  await manager.exclusive((session) => acceptProposal(session, request));
  return {};
}

/**
 * Discards the stored tag proposal of a file.
 *
 * @param manager the workspace manager
 * @param request the file
 * @returns an empty answer
 */
async function discardInWorkspace(
  manager: WorkspaceManager,
  request: IpcRequest<'analysis:discardProposal'>,
): Promise<IpcResponse<'analysis:discardProposal'>> {
  await manager.exclusive((session) => discardProposal(session, request.fileId));
  return {};
}

/**
 * Runs Image2Prompt on the resolved prompt and entry, inside the workspace read.
 *
 * @param dependencies the prompts, provider entries and describe controller
 * @param request the describe request
 * @returns the text, or why there is none
 */
async function describeImage(
  dependencies: AnalysisHandlerDependencies,
  request: IpcRequest<'analysis:describe'>,
): Promise<IpcResponse<'analysis:describe'>> {
  const { prompts, providers, describe } = dependencies;
  const prompt = prompts.resolve('image_prompt', request.promptId);
  const entry = providers.resolve(request.providerId);
  if (entry === null) {
    // As before several providers: the request was accepted and found no provider.
    prompts.markUsed(prompt);
    return { ok: false as const, code: 'provider_not_configured' as const };
  }
  const result = await describe.describe({
    requestId: request.requestId,
    fileId: request.fileId,
    model: request.model,
    prompt: prompt.text,
    providerId: entry.id,
  });
  // A busy answer never ran; every other answer, including a cancelled one, counts as an accepted request.
  if (result.ok || result.code !== 'busy') {
    prompts.markUsed(prompt);
    providers.markUsed(entry.id);
  }
  return result;
}

/**
 * Cancels a running Image2Prompt request; needs an open workspace like the request itself.
 *
 * @param manager the workspace manager
 * @param describe the describe controller
 * @param request the request to cancel
 * @returns an empty answer
 */
async function cancelDescribe(
  manager: WorkspaceManager,
  describe: DescribeController,
  request: IpcRequest<'analysis:cancelDescribe'>,
): Promise<IpcResponse<'analysis:cancelDescribe'>> {
  await manager.read(async () => describe.cancel(request.requestId));
  return {};
}
