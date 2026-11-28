import {
  SITE_CRAWL_JOB,
  type SiteCrawlTask,
  type SiteCrawlTaskSummary,
  type SiteImportCandidate,
} from '@assetforge/contracts';
import {
  addAssetSource,
  buildSiteCandidates,
  enqueueUrlImport,
  InvalidOperationError,
  NotFoundError,
  parseSiteCrawlCheckpoint,
  requireAsset,
  selectedSiteUrls,
  siteGalleryUrl,
  type SiteCrawlDependencies,
  type SiteCrawlRecord,
  type SiteCrawlSummaryRecord,
  type WorkspaceManager,
  type WorkspaceSession,
} from '@assetforge/core';
import type { IpcRequest, IpcResponse } from './ipc.js';
import type { JobHost } from './job-host.js';
import { SITE_PROFILE_NOT_FOUND, type SiteProfileStore } from './site-profile-store.js';
import type { SiteSessions } from './site-sessions.js';
export { createSiteDiscoveryHandler } from './site-discovery-job.js';

/** Browser-facing discovery dependencies, shared with the persistent job handler. */
export interface SiteDiscoveryRuntime {
  store: SiteProfileStore;
  sessions: SiteSessions;
  robots: SiteCrawlDependencies['robots'];
  wait?: SiteCrawlDependencies['wait'];
}

/** The workspace and scheduler used by the queued-discovery IPC channels. */
export interface SiteDiscoveryDependencies extends SiteDiscoveryRuntime {
  manager: WorkspaceManager;
  jobs: Pick<JobHost, 'changed' | 'wake' | 'cancel' | 'resume'>;
}

const NOT_FOUND = 'This discovery task does not exist';
const NOT_READY = 'This discovery task is not ready for import';

/**
 * Looks up saved state without ever resolving an id in another workspace.
 * @param session the captured workspace
 * @param crawlId the discovery id
 * @returns saved state
 */
export async function requireCrawl(session: WorkspaceSession, crawlId: string): Promise<SiteCrawlRecord> {
  const record = await session.database.siteCrawls.get(crawlId);
  if (record === null) throw new NotFoundError(NOT_FOUND);
  return record;
}

/**
 * A task's lightweight status, read from its technical job rather than a second state machine.
 * @param session the open workspace
 * @param record saved discovery
 * @returns the queue summary
 */
async function summaryOf(
  session: WorkspaceSession,
  record: SiteCrawlRecord | SiteCrawlSummaryRecord,
): Promise<SiteCrawlTaskSummary> {
  const job = await session.database.jobs.get(record.id);
  const downloads = await session.database.siteCrawls.downloadProgress(record.id);
  let status: SiteCrawlTaskSummary['status'];
  if (record.importedAt !== null) {
    if (downloads === null || downloads.queued + downloads.running + downloads.waiting > 0) status = 'imported';
    else status = downloads.failed + downloads.cancelled > 0 ? 'import_failed' : 'completed';
  } else if (job?.status === 'running') status = 'running';
  else if (job?.status === 'queued') status = 'queued';
  else if (job?.status === 'retry_wait' || job?.status === 'waiting_remote') status = 'waiting';
  else if (job?.status === 'failed') status = 'failed';
  else if (job?.status === 'cancelled') status = 'cancelled';
  else if (job?.status === 'succeeded' || record.completedAt != null) status = 'ready';
  else status = ('cancelled' in record ? record.cancelled : record.result?.cancelled === true) ? 'cancelled' : 'failed';
  return {
    crawlId: record.id,
    jobId: record.id,
    profileId: record.profile.id,
    profileName: record.profile.name,
    site: record.profile.site,
    galleryUrl: record.galleryUrl,
    target: record.target,
    targetAssetName: record.targetAssetName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status,
    downloads,
    errorCode: job?.errorCode ?? null,
    errorMessage: job?.errorMessage ?? null,
    progress: record.progress,
  };
}

/**
 * Rechecks filenames while retaining raw discoveries and their individual source pages.
 * @param session the open workspace
 * @param record saved crawl
 * @returns review candidates, never filtered out by filename here
 */
async function candidatesOf(session: WorkspaceSession, record: SiteCrawlRecord): Promise<SiteImportCandidate[]> {
  const candidates = await buildSiteCandidates(session, record.result?.files ?? [], record.target, record.galleryUrl);
  const checkpoint = parseSiteCrawlCheckpoint(record.checkpoint);
  return candidates.map((candidate) => ({
    ...candidate,
    sourcePageUrl: checkpoint?.sourcePages[candidate.url] ?? candidate.sourcePageUrl,
  }));
}

/**
 * Builds and atomically queues captured discovery state.
 * @param session the workspace
 * @param dependencies current profiles and sessions
 * @param request source and destination
 * @returns the durable task id
 */
async function enqueueDiscovery(
  session: WorkspaceSession,
  dependencies: SiteDiscoveryDependencies,
  request: IpcRequest<'sites:enqueueCrawl'>,
): Promise<IpcResponse<'sites:enqueueCrawl'>> {
  const profile = dependencies.store.get(request.profileId);
  if (profile === null) throw new NotFoundError(SITE_PROFILE_NOT_FOUND);
  const galleryUrl = siteGalleryUrl(profile, request.url);
  const asset = request.target === null ? null : await requireAsset(session, request.target.assetId);
  const now = session.now().toISOString();
  const id = session.newId();
  const record: SiteCrawlRecord = {
    id,
    profile,
    galleryUrl,
    target: request.target,
    targetAssetName: asset?.name ?? null,
    progress: { pages: 0, files: 0, cancelling: false },
    result: null,
    checkpoint: null,
    importedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await session.database.siteCrawls.insert(record, {
    id,
    type: SITE_CRAWL_JOB,
    resourceClass: 'cpu',
    fileId: null,
    lane: profile.site,
    payload: { v: 1, crawlId: id },
    dedupeKey: null,
  });
  return { crawlId: id };
}

/**
 * Reads lightweight summaries for queue polling.
 * @param session the workspace
 * @param request pagination
 * @returns the summary page
 */
async function listDiscoveries(
  session: WorkspaceSession,
  request: IpcRequest<'sites:listCrawls'>,
): Promise<IpcResponse<'sites:listCrawls'>> {
  const page = await session.database.siteCrawls.listSummaries({
    limit: request.limit ?? 20,
    offset: request.offset ?? 0,
  });
  return { total: page.total, items: await Promise.all(page.items.map((record) => summaryOf(session, record))) };
}

/**
 * Reads one complete saved review result.
 * @param session the workspace
 * @param crawlId selected task
 * @returns full review data
 */
async function getDiscovery(session: WorkspaceSession, crawlId: string): Promise<SiteCrawlTask> {
  const record = await requireCrawl(session, crawlId);
  return {
    ...(await summaryOf(session, record)),
    result: record.result,
    candidates: await candidatesOf(session, record),
  };
}

/**
 * Retries an existing technical job using the saved checkpoint.
 * @param session the workspace
 * @param dependencies profile store and scheduler
 * @param crawlId failed or cancelled task
 * @returns whether it was requeued
 */
async function retryDiscovery(
  session: WorkspaceSession,
  dependencies: SiteDiscoveryDependencies,
  crawlId: string,
): Promise<IpcResponse<'sites:retryCrawl'>> {
  const record = await requireCrawl(session, crawlId);
  if (dependencies.store.get(record.profile.id) === null) throw new NotFoundError(SITE_PROFILE_NOT_FOUND);
  const now = session.now().toISOString();
  const existingJob = await session.database.jobs.get(crawlId);
  const count =
    existingJob === null
      ? (
          await session.database.jobs.enqueue({
            jobs: [
              {
                id: record.id,
                type: SITE_CRAWL_JOB,
                resourceClass: 'cpu',
                fileId: null,
                lane: record.profile.site,
                payload: { v: 1, crawlId: record.id },
                dedupeKey: null,
              },
            ],
            now,
          })
        ).length
      : await session.database.jobs.retry({ id: crawlId, now });
  dependencies.jobs.resume(record.profile.site, ['cpu']);
  return { retried: count > 0 };
}

/**
 * Checks whether an id belongs to saved discovery rather than a legacy preview.
 * @param session the workspace
 * @param crawlId selected task
 * @returns whether it exists
 */
async function hasDiscovery(session: WorkspaceSession, crawlId: string): Promise<boolean> {
  return (await session.database.siteCrawls.get(crawlId)) !== null;
}

/**
 * Records a gallery source without failing a valid import when its source list is already full.
 * @param session the workspace
 * @param record captured source and destination
 */
async function recordGallerySource(session: WorkspaceSession, record: SiteCrawlRecord): Promise<void> {
  if (record.target === null) return;
  try {
    await addAssetSource(session, { assetId: record.target.assetId, url: record.galleryUrl });
  } catch {
    /* Existing or full source lists do not fail a valid import. */
  }
}

/**
 * Applies an explicit selection against live asset filenames and queues its downloads.
 * @param session the workspace
 * @param dependencies current profile store
 * @param request selected discovered URLs and name overrides
 * @returns download queue outcome
 */
async function importDiscovery(
  session: WorkspaceSession,
  dependencies: SiteDiscoveryDependencies,
  request: IpcRequest<'sites:import'>,
): Promise<IpcResponse<'sites:import'>> {
  const record = await requireCrawl(session, request.crawlId);
  const task = await summaryOf(session, record);
  if (!['ready', 'cancelled', 'imported', 'completed', 'import_failed'].includes(task.status) || record.result === null)
    throw new InvalidOperationError(NOT_READY);
  if (dependencies.store.get(record.profile.id) === null) throw new NotFoundError(SITE_PROFILE_NOT_FOUND);
  if (record.target !== null) await requireAsset(session, record.target.assetId);
  // The destination is captured at enqueue, never the renderer's current asset.
  const urls = selectedSiteUrls(await candidatesOf(session, record), request);
  const queued = await enqueueUrlImport(session, {
    urls,
    target: record.target,
    skipDuplicates: true,
    site: {
      crawlId: record.id,
      profileId: record.profile.id,
      site: record.profile.site,
      filter: { kinds: [...record.profile.kinds], minBytes: record.profile.minBytes },
    },
  });
  if (queued.queued + queued.alreadyImported + queued.alreadyQueued > 0) {
    await recordGallerySource(session, record);
    const now = session.now().toISOString();
    await session.database.siteCrawls.update(record.id, { importedAt: now, now });
  }
  return queued;
}

/** Workspace-local queue and review operations; no operation waits for discovery to finish. */
export class SiteDiscoveryService {
  /** @param dependencies stores, browser sessions and the existing job host */
  constructor(private readonly dependencies: SiteDiscoveryDependencies) {}

  /** Notifies the existing scheduler after a queue mutation. */
  private changed(): void {
    this.dependencies.jobs.changed();
    this.dependencies.jobs.wake();
  }

  /**
   * Queues discovery without waiting for the browser.
   * @param request source and captured destination
   * @returns the durable id
   */
  async enqueue(request: IpcRequest<'sites:enqueueCrawl'>): Promise<IpcResponse<'sites:enqueueCrawl'>> {
    const result = await this.dependencies.manager.exclusive((session) =>
      enqueueDiscovery(session, this.dependencies, request),
    );
    this.changed();
    return result;
  }

  /**
   * Lists tasks without loading their result arrays.
   * @param request pagination
   * @returns summaries
   */
  list(request: IpcRequest<'sites:listCrawls'>): Promise<IpcResponse<'sites:listCrawls'>> {
    return this.dependencies.manager.read((session) => listDiscoveries(session, request));
  }

  /**
   * Reads saved review data.
   * @param crawlId selected task
   * @returns full task and filename matches
   */
  get(crawlId: string): Promise<SiteCrawlTask> {
    return this.dependencies.manager.read((session) => getDiscovery(session, crawlId));
  }

  /**
   * Cancels discovery explicitly, independently of dialog lifecycle.
   * @param crawlId task to stop
   * @returns whether cancellation was requested
   */
  async cancel(crawlId: string): Promise<IpcResponse<'sites:cancelCrawl'>> {
    await this.dependencies.manager.read((session) => requireCrawl(session, crawlId));
    await this.dependencies.jobs.cancel(crawlId);
    this.changed();
    return { cancelling: true };
  }

  /**
   * Removes a finished extraction from review history without touching queued downloads or files.
   * @param crawlId saved task
   * @returns whether an entry was removed
   */
  async remove(crawlId: string): Promise<IpcResponse<'sites:removeCrawl'>> {
    const removed = await this.dependencies.manager.exclusive((session) => session.database.siteCrawls.remove(crawlId));
    if (removed) this.changed();
    return { removed };
  }

  /** @returns number of completed import reviews removed without touching content or download jobs */
  async clearCompleted(): Promise<IpcResponse<'sites:clearCompletedCrawls'>> {
    const removed = await this.dependencies.manager.exclusive((session) =>
      session.database.siteCrawls.clearCompleted(),
    );
    if (removed > 0) this.changed();
    return { removed };
  }

  /**
   * Retries a task after user action or a transient failure.
   * @param crawlId failed or cancelled task
   * @returns whether it was requeued
   */
  async retry(crawlId: string): Promise<IpcResponse<'sites:retryCrawl'>> {
    const result = await this.dependencies.manager.exclusive((session) =>
      retryDiscovery(session, this.dependencies, crawlId),
    );
    this.changed();
    return result;
  }

  /**
   * Starts a fresh run of the same extraction with its current profile; existing downloads remain independent.
   * @param crawlId existing extraction
   * @returns whether it was restarted
   */
  async restart(crawlId: string): Promise<IpcResponse<'sites:restartCrawl'>> {
    const restarted = await this.dependencies.manager.exclusive(async (session) => {
      const record = await requireCrawl(session, crawlId);
      const profile = this.dependencies.store.get(record.profile.id);
      if (profile === null) throw new NotFoundError(SITE_PROFILE_NOT_FOUND);
      const changed = await session.database.siteCrawls.restart(crawlId, profile, session.now().toISOString());
      if (changed) this.dependencies.jobs.resume(profile.site, ['cpu']);
      return changed;
    });
    if (restarted) this.changed();
    return { restarted };
  }

  /**
   * Distinguishes saved tasks from legacy previews.
   * @param crawlId selected task
   * @returns whether it exists in this workspace
   */
  has(crawlId: string): Promise<boolean> {
    if (this.dependencies.manager.current() === null) return Promise.resolve(false);
    return this.dependencies.manager.read((session) => hasDiscovery(session, crawlId));
  }

  /**
   * Imports explicitly selected results into the captured destination.
   * @param request review selection
   * @returns the download queue outcome
   */
  async import(request: IpcRequest<'sites:import'>): Promise<IpcResponse<'sites:import'>> {
    const result = await this.dependencies.manager.exclusive((session) =>
      importDiscovery(session, this.dependencies, request),
    );
    this.changed();
    return result;
  }
}
