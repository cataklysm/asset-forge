import type { SiteCrawlResult } from '@assetforge/contracts';
import {
  clampRetryAfterMs,
  crawlSite,
  JobError,
  parseSiteCrawlCheckpoint,
  SiteCrawlBlockedError,
  type Job,
  type JobHandler,
  type SiteCrawlCheckpoint,
  type SiteCrawlRecord,
  type WorkspaceSession,
} from '@assetforge/core';
import type { PauseGate } from '@assetforge/jobs';
import { abortableWait } from './abortable-wait.js';
import { requireCrawl, type SiteDiscoveryRuntime } from './site-discovery.js';

/** Browser pages of one saved crawl are closed before its scheduler releases the workspace. */
class DiscoveryRun {
  private readonly gone = new AbortController();
  private readonly activeSignal: AbortSignal;
  private writes = Promise.resolve();

  /**
   * Holds the workspace, browser session and checkpoint of one run.
   * @param session open workspace
   * @param runtime profile sessions and robots
   * @param pause source pauses
   * @param record captured request
   * @param signal scheduler cancellation
   */
  constructor(
    private readonly session: WorkspaceSession,
    private readonly runtime: SiteDiscoveryRuntime,
    private readonly pause: PauseGate,
    private readonly record: SiteCrawlRecord,
    private readonly signal: AbortSignal,
  ) {
    this.activeSignal = AbortSignal.any([signal, this.gone.signal]);
  }

  /**
   * Loads pages, saves progress and releases native windows on every exit.
   * @returns when discovery and every checkpoint write has ended
   */
  async run(): Promise<void> {
    const page = this.runtime.sessions.openPage(this.record.profile, () => this.gone.abort());
    try {
      const result = await this.discover(page);
      await this.finish(result);
    } catch (error) {
      this.rethrow(error);
    } finally {
      try {
        await this.writes;
      } finally {
        page.close();
      }
    }
  }

  /**
   * Delegates discovery to core with serialized persistence callbacks.
   * @param page independent browser views behind a shared profile session
   * @returns discovered candidates and diagnostics
   */
  private discover(
    page: ReturnType<SiteDiscoveryRuntime['sessions']['openPage']>,
  ): Promise<Omit<SiteCrawlResult, 'crawlId'>> {
    return crawlSite(
      { pages: page.loader, robots: this.runtime.robots, wait: this.runtime.wait ?? abortableWait },
      {
        profile: this.record.profile,
        url: this.record.galleryUrl,
        signal: this.activeSignal,
        checkpoint: parseSiteCrawlCheckpoint(this.record.checkpoint) ?? undefined,
        onProgress: (progress) => this.progress(progress),
        onCheckpoint: (checkpoint) => this.checkpoint(checkpoint),
      },
    );
  }

  /**
   * Serializes count updates independently of renderer polling.
   * @param progress current page and candidate counts
   */
  private progress(progress: { pages: number; files: number }): void {
    this.writes = this.writes.then(() => this.saveProgress(progress));
  }

  /**
   * Saves one queued progress update.
   * @param progress page and candidate counts
   * @returns when persisted
   */
  private async saveProgress(progress: { pages: number; files: number }): Promise<void> {
    await this.session.database.siteCrawls.update(this.record.id, {
      progress: { ...progress, cancelling: this.signal.aborted },
      now: this.session.now().toISOString(),
    });
  }

  /**
   * Saves a resumable state after preceding count updates.
   * @param checkpoint detached URL metadata, without credentials
   * @returns when persisted
   */
  private async checkpoint(checkpoint: SiteCrawlCheckpoint): Promise<void> {
    await this.writes;
    await this.session.database.siteCrawls.update(this.record.id, {
      checkpoint,
      result: { crawlId: this.record.id, ...checkpoint.answer },
      progress: {
        pages: checkpoint.answer.pages,
        files: checkpoint.answer.files.length,
        cancelling: this.signal.aborted,
      },
      now: this.session.now().toISOString(),
    });
  }

  /**
   * Stores review results and marks only successful discovery complete.
   * @param result saved candidates and diagnostics
   * @returns when persisted
   */
  private async finish(result: Omit<SiteCrawlResult, 'crawlId'>): Promise<void> {
    await this.writes;
    await this.session.database.siteCrawls.update(this.record.id, {
      result: { crawlId: this.record.id, ...result },
      progress: { pages: result.pages, files: result.files.length, cancelling: false },
      now: this.session.now().toISOString(),
    });
    this.signal.throwIfAborted();
    if (this.gone.signal.aborted) throw new JobError('download_unavailable');
    const now = this.session.now().toISOString();
    await this.session.database.siteCrawls.update(this.record.id, { completedAt: now, now });
  }

  /**
   * Preserves actual HTTP refusal reasons and shares quota waits with other jobs of the site.
   * @param error crawl failure
   * @throws JobError for blocked sources, or the original failure
   */
  private rethrow(error: unknown): never {
    if (!(error instanceof SiteCrawlBlockedError)) throw error;
    if (error.status === 429) throw new JobError('download_throttled', { retryAfterMs: clampRetryAfterMs(null) });
    const code = error.status === 401 ? 'download_unauthorized' : 'download_forbidden';
    this.pause.pause('cpu', this.record.profile.site, code);
    throw new JobError(code);
  }
}

/**
 * Resolves credentials live when a scheduler claims a saved request.
 * @param session open workspace
 * @param runtime current site sessions
 * @param pause source pause gate
 * @param job associated discovery job
 * @param signal scheduler cancellation
 * @returns when the crawl and native cleanup end
 */
async function runDiscovery(
  session: WorkspaceSession,
  runtime: SiteDiscoveryRuntime,
  pause: PauseGate,
  job: Job,
  signal: AbortSignal,
): Promise<void> {
  const record = await requireCrawl(session, job.id);
  if (runtime.store.get(record.profile.id) === null) throw new JobError('download_profile_missing');
  await new DiscoveryRun(session, runtime, pause, record, signal).run();
}

/**
 * Wires browser discovery into the existing persistent scheduler.
 * @param session workspace held until the scheduler stops
 * @param runtime site profile sessions
 * @param pause source pause gate
 * @returns the discovery handler
 */
export function createSiteDiscoveryHandler(
  session: WorkspaceSession,
  runtime: SiteDiscoveryRuntime,
  pause: PauseGate,
): JobHandler {
  return {
    resourceClass: 'cpu',
    onInterrupted: 'requeue',
    run: (job, signal) => runDiscovery(session, runtime, pause, job, signal),
  };
}
