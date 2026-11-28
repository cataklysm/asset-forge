import { IMAGE_GENERATE_JOB, ImageGeneratePayloadSchema, purposeOf, type ProviderKind } from '@assetforge/contracts';
import {
  cancelAllJobs,
  cancelJob,
  NoWorkspaceOpenError,
  clearFinishedJobs,
  countJobs,
  InvalidOperationError,
  laneName,
  listJobs,
  listWaitingLanes,
  NotFoundError,
  rerouteJobs,
  retryBrowserCheckFailures,
  retryFailedJobs,
  retryGeneration,
  retryJob,
  type ImageProviderDirectory,
  type WorkspaceManager,
  type WorkspaceSession,
} from '@assetforge/core';
import type { IpcHandlers, IpcRequest, IpcResponse } from './ipc.js';
import { DOWNLOAD_CLASSES, PROVIDER_CLASSES, type JobHost } from './job-host.js';
import { CANNOT_ANALYSE } from './provider-entry.js';
import type { ProviderStore } from './provider-store.js';

// Kept free of Electron imports. Every repository call is one atomic transaction, so these run
// through `read` rather than the serial queue. No core use case wakes the scheduler; the handlers do.

const GENERATION_NOT_FOUND = 'This generation does not exist';

/** The `jobs:*` channels and the change feed. */
export type JobHandlers = Pick<
  IpcHandlers,
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
  | 'changes:since'
>;

/** What the job channels work with. */
export interface JobHandlerDependencies {
  /** The workspace manager. */
  manager: WorkspaceManager;
  /** The job host of the open workspace. */
  jobs: JobHost;
  /** The provider entries the job rows are named from. */
  providers: ProviderStore;
  /** The `venice` entries a retried generation runs on. */
  imageProviders: ImageProviderDirectory;
  /** Whether a download lane is the site of a site profile; without it no lane is. */
  isSiteLane?: (host: string) => boolean;
}

/**
 * Builds the `jobs:*` channels and `changes:since`.
 *
 * @param dependencies what the channels work with
 * @returns one handler per channel
 */
export function createJobHandlers(dependencies: JobHandlerDependencies): JobHandlers {
  const { manager, jobs } = dependencies;
  return {
    'jobs:list': (request) => listNamedJobs(dependencies, request),
    'jobs:summary': async () => manager.read((session) => summarize(dependencies, session)),
    'jobs:cancel': (request) => cancelOne(dependencies, request),
    'jobs:cancelAll': () => cancelAll(dependencies),
    'jobs:retry': (request) => retryOne(dependencies, request),
    'jobs:retryFailed': () => retryFailed(dependencies),
    'jobs:waitingByProvider': () => manager.read((session) => waitingByProvider(dependencies.providers, session)),
    // The pause belongs to the app session, so this works without an open workspace. Only the provider queues:
    // a download host may carry the same name as an entry id.
    'jobs:resume': async (request) => {
      jobs.resume(request.providerId, PROVIDER_CLASSES);
      return {};
    },
    // Like `jobs:resume`: a paused download host belongs to the app session, not to a workspace. Only the download queue.
    'jobs:resumeHost': (request) => resumeHost(dependencies, request),
    'jobs:reroute': (request) => reroute(dependencies, request),
    'jobs:clearFinished': () => clearFinished(dependencies),
    // Reads only the in-memory feed: no workspace read, so it never waits for the queue. Without a workspace every
    // cursor answers `reset`.
    'changes:since': async (request) => jobs.changesSince(manager.current() === null ? null : request.cursor),
  };
}

/**
 * A job row changed outside the scheduler: raise the counter and let the scheduler look for work.
 *
 * @param jobs the job host
 */
export function markJobsChanged(jobs: JobHost): void {
  jobs.changed();
  jobs.wake();
}

/**
 * The current name of an existing entry; otherwise the name copied into a payload, if any.
 *
 * @param providers the provider entries
 * @param lane the job's lane
 * @param copied the name copied into its payload
 * @returns the name to show
 */
function nameOf(providers: ProviderStore, lane: string | null, copied: string | null): string | null {
  return (lane === null ? null : providers.get(lane)?.name) ?? copied;
}

/**
 * True when the lane belongs to an existing image entry: its jobs are generations, never analyses.
 *
 * @param providers the provider entries
 * @param lane the lane
 * @returns whether the lane is an image entry's
 */
function isImageLane(providers: ProviderStore, lane: string | null): boolean {
  const entry = lane === null ? null : providers.get(lane);
  return entry !== null && purposeOf(entry.kind) === 'image';
}

/**
 * The provider name stored with the generation of the lane's newest generation job.
 *
 * @param session the open workspace
 * @param lane the lane
 * @returns the name, or null when there is none
 */
async function generationLaneName(session: WorkspaceSession, lane: string | null): Promise<string | null> {
  const parsed = ImageGeneratePayloadSchema.safeParse(
    await session.database.jobs.latestPayloadOfLane(IMAGE_GENERATE_JOB, lane),
  );
  if (!parsed.success) return null;
  return (await session.database.generations.get(parsed.data.generationId))?.providerName ?? null;
}

/**
 * One page of jobs, each named after its provider entry.
 *
 * @param dependencies the manager and the provider entries
 * @param request the page and its filters
 * @returns the page
 */
async function listNamedJobs(
  dependencies: JobHandlerDependencies,
  request: IpcRequest<'jobs:list'>,
): Promise<IpcResponse<'jobs:list'>> {
  const { limit, offset, status, providerId, ids } = request;
  const page = await dependencies.manager.read((session) =>
    listJobs(session, {
      limit,
      offset,
      ...(status === undefined ? {} : { status }),
      ...(providerId === undefined ? {} : { lane: providerId }),
      ...(ids === undefined ? {} : { ids }),
    }),
  );
  return {
    ...page,
    items: page.items.map((job) => ({
      ...job,
      providerName: nameOf(dependencies.providers, job.providerId, job.providerName),
    })),
  };
}

/**
 * The job counts, the change counter and the paused providers and hosts.
 *
 * @param dependencies the job host and the provider entries
 * @param session the open workspace
 * @returns the summary
 */
async function summarize(
  dependencies: JobHandlerDependencies,
  session: WorkspaceSession,
): Promise<IpcResponse<'jobs:summary'>> {
  const { jobs, providers } = dependencies;
  const counts = await countJobs(session);
  const paused = [];
  const pausedHosts = [];
  for (const { lane, reason, resourceClass } of jobs.paused()) {
    // A download lane is the host of its URLs; a download job always has one.
    if (resourceClass === 'io') {
      if (lane !== null) pausedHosts.push({ host: lane, reason });
      continue;
    }
    // The kind of the lane's entry; for a lane whose entry is gone, what its resource class implies.
    const entry = lane === null ? null : providers.get(lane);
    const kind: ProviderKind = entry?.kind ?? (resourceClass === 'remote_api' ? 'venice' : 'ollama');
    // The name copied into the jobs is read by the resource class: an analysis lane or a generation lane.
    const providerName =
      entry?.name ??
      (resourceClass === 'remote_api' ? await generationLaneName(session, lane) : await laneName(session, lane));
    paused.push({ providerId: lane, providerName, kind, reason });
  }
  return { ...counts, changes: jobs.changes(), paused, pausedHosts };
}

/**
 * Cancels one job.
 *
 * @param dependencies the manager and the job host
 * @param request the job
 * @returns an empty answer
 */
async function cancelOne(
  dependencies: JobHandlerDependencies,
  request: IpcRequest<'jobs:cancel'>,
): Promise<IpcResponse<'jobs:cancel'>> {
  const { manager, jobs } = dependencies;
  await manager.read((session) => cancelJob(session, jobs, request.jobId));
  markJobsChanged(jobs);
  return {};
}

/**
 * Cancels every active job.
 *
 * @param dependencies the manager and the job host
 * @returns how many were cancelled
 */
async function cancelAll(dependencies: JobHandlerDependencies): Promise<IpcResponse<'jobs:cancelAll'>> {
  const { manager, jobs } = dependencies;
  const cancelled = await manager.read((session) => cancelAllJobs(session, jobs));
  if (cancelled > 0) markJobsChanged(jobs);
  return { cancelled };
}

/**
 * Runs one job again; a generation job runs again as its generation.
 *
 * @param dependencies what the channel works with
 * @param request the job
 * @returns an empty answer
 */
async function retryOne(
  dependencies: JobHandlerDependencies,
  request: IpcRequest<'jobs:retry'>,
): Promise<IpcResponse<'jobs:retry'>> {
  await dependencies.manager.read((session) => retryIn(dependencies, session, request.jobId));
  markJobsChanged(dependencies.jobs);
  return {};
}

/**
 * Runs one job again inside the workspace read.
 *
 * @param dependencies the job host and the image providers
 * @param session the open workspace
 * @param jobId the job
 * @throws NotFoundError when the job is a generation job whose generation is gone
 */
async function retryIn(dependencies: JobHandlerDependencies, session: WorkspaceSession, jobId: string): Promise<void> {
  const job = await session.database.jobs.get(jobId);
  if (job?.type !== IMAGE_GENERATE_JOB) return retryJob(session, jobId);
  // A generation runs again as itself, with a new job and its stored settings, never as the old job row.
  const parsed = ImageGeneratePayloadSchema.safeParse(job.payload);
  const id =
    (await session.database.generations.byJob(job.id))?.id ?? (parsed.success ? parsed.data.generationId : null);
  if (id === null || (await session.database.generations.get(id)) === null)
    throw new NotFoundError(GENERATION_NOT_FOUND);
  await retryGeneration(session, { providers: dependencies.imageProviders, control: dependencies.jobs }, id);
}

/**
 * Runs every failed job that may be retried again.
 *
 * @param dependencies the manager and the job host
 * @returns how many were requeued
 */
async function retryFailed(dependencies: JobHandlerDependencies): Promise<IpcResponse<'jobs:retryFailed'>> {
  const retried = await dependencies.manager.read((session) => retryFailedJobs(session));
  if (retried > 0) markJobsChanged(dependencies.jobs);
  return { retried };
}

/**
 * The analysis lanes with waiting jobs, each named after its entry.
 *
 * @param providers the provider entries
 * @param session the open workspace
 * @returns one line per lane
 */
async function waitingByProvider(
  providers: ProviderStore,
  session: WorkspaceSession,
): Promise<IpcResponse<'jobs:waitingByProvider'>> {
  return (
    (await listWaitingLanes(session))
      // Jobs in a venice lane can be moved to no analysis provider, so that lane is never offered.
      .filter(({ lane }) => !isImageLane(providers, lane))
      .map(({ lane, payloadName, waiting }) => ({
        providerId: lane,
        providerName: nameOf(providers, lane, payloadName),
        waiting,
      }))
  );
}

/**
 * Resumes a paused download host.
 *
 * @param dependencies the manager, the job host and the site lane test
 * @param request the host
 * @returns an empty answer
 */
async function resumeHost(
  dependencies: JobHandlerDependencies,
  request: IpcRequest<'jobs:resumeHost'>,
): Promise<IpcResponse<'jobs:resumeHost'>> {
  const { manager, jobs, isSiteLane } = dependencies;
  // The lane of a site profile: the owner passed the site's check by hand, so the downloads it refused run again.
  if (isSiteLane?.(request.host) === true && manager.current() !== null) {
    try {
      await manager.read((session) => retryBrowserCheckFailures(session, request.host));
    } catch (error) {
      // Closed meanwhile: nothing to queue again.
      if (!(error instanceof NoWorkspaceOpenError)) throw error;
    }
  }
  // Raises the change counter and wakes the scheduler.
  jobs.resume(request.host, DOWNLOAD_CLASSES);
  return {};
}

/**
 * Moves the waiting analysis jobs of one provider to another entry and model.
 * The target's pause is not lifted: the moved jobs wait in its lane until it is resumed. The source lane
 * has no waiting jobs left, so its pause ends; resume already raises the counter and wakes the scheduler.
 *
 * @param dependencies what the channel works with
 * @param request the source, the target and the model
 * @returns how many jobs moved
 */
async function reroute(
  dependencies: JobHandlerDependencies,
  request: IpcRequest<'jobs:reroute'>,
): Promise<IpcResponse<'jobs:reroute'>> {
  const result = await dependencies.manager.read((session) => rerouteIn(dependencies.providers, session, request));
  if (result.moved > 0) dependencies.jobs.resume(request.fromProviderId, PROVIDER_CLASSES);
  return result;
}

/**
 * Moves the jobs inside the workspace read.
 *
 * @param providers the provider entries
 * @param session the open workspace
 * @param request the source, the target and the model
 * @returns how many jobs moved
 * @throws InvalidOperationError when the source is an image entry
 */
function rerouteIn(
  providers: ProviderStore,
  session: WorkspaceSession,
  request: IpcRequest<'jobs:reroute'>,
): Promise<IpcResponse<'jobs:reroute'>> {
  // Only analysis jobs move, and only between analysis entries; generation jobs never move.
  if (isImageLane(providers, request.fromProviderId)) throw new InvalidOperationError(CANNOT_ANALYSE);
  const to = providers.resolve(request.toProviderId, 'vision')!;
  return rerouteJobs(session, {
    fromLane: request.fromProviderId,
    to: { id: to.id, name: to.name },
    model: request.model,
  });
}

/**
 * Removes the finished jobs.
 *
 * @param dependencies the manager and the job host
 * @returns how many were removed
 */
async function clearFinished(dependencies: JobHandlerDependencies): Promise<IpcResponse<'jobs:clearFinished'>> {
  const removed = await dependencies.manager.read((session) => clearFinishedJobs(session));
  if (removed > 0) markJobsChanged(dependencies.jobs);
  return { removed };
}
