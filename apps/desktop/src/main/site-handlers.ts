import { randomUUID } from 'node:crypto';
import type { SiteCrawlProgress, SiteFilter, SiteProfile } from '@assetforge/contracts';
import {
  addAssetSource,
  crawlSite,
  enqueueUrlImport,
  InvalidOperationError,
  NoWorkspaceOpenError,
  normalizeSourceUrl,
  NotFoundError,
  siteGalleryUrl,
  type SiteCrawlDependencies,
  type WorkspaceManager,
  type WorkspaceSession,
} from '@assetforge/core';
import { abortableWait } from './abortable-wait.js';
import type { IpcHandlers, IpcRequest, IpcResponse } from './ipc.js';
import type { JobHost } from './job-host.js';
import { hasActiveDownloads, refusedDownloadUrl } from './site-profile-downloads.js';
import { SITE_PROFILE_NOT_FOUND, type SiteProfileStore } from './site-profile-store.js';
import type { SiteSessions } from './site-sessions.js';

// The site import channels (spec "The crawl", "Download", "Channels"). Kept free of Electron imports: the windows
// and sessions are behind SiteSessions. Every channel works without a workspace except `sites:import`. One crawl
// runs at a time, in memory; the answer of the last one is kept until the next crawl, a change or deletion of its
// profile, or the app's end. No answer, log line or error carries a URL or a cookie.

/** The channels of the site import. */
export type SiteHandlers = Pick<
  IpcHandlers,
  | 'sites:list'
  | 'sites:save'
  | 'sites:delete'
  | 'sites:openLogin'
  | 'sites:openCheck'
  | 'sites:crawl'
  | 'sites:crawlProgress'
  | 'sites:cancelCrawl'
  | 'sites:import'
>;

const ALREADY_RUNNING = 'A site import test is already running';
const IN_USE = 'This profile is in use';
const OTHER_LOGIN = 'Another login window is open';
const RUN_AGAIN = 'Run the test again';
const ACTIVE_DOWNLOADS = 'This profile still has active downloads';

/** What `createSiteHandlers` is wired with. */
export interface SiteHandlerDependencies {
  /** The site profiles at app level. */
  store: SiteProfileStore;
  /** The login and page windows of the profiles. */
  sessions: SiteSessions;
  /** The workspace manager; `sites:import` needs an open workspace. */
  manager: WorkspaceManager;
  /** Told after an import was queued. */
  jobs: Pick<JobHost, 'changed' | 'wake'>;
  /** Reads `robots.txt` for the crawl. */
  robots: SiteCrawlDependencies['robots'];
  /** The wait between pages; `abortableWait` without one. */
  wait?: SiteCrawlDependencies['wait'];
  /** Makes the id of a crawl; `randomUUID` without one. */
  newId?: () => string;
  /** One line with at most a profile id and a fixed code. */
  log?: (line: string) => void;
}

/** The crawl that runs now. */
interface RunningCrawl {
  profileId: string;
  controller: AbortController;
  progress: { pages: number; files: number };
}

/** The answer of the last crawl, which `sites:import` queues. */
interface KeptCrawl {
  crawlId: string;
  profileId: string;
  galleryUrl: string;
  filter: SiteFilter;
  files: string[];
}

/**
 * Creates the site import channels.
 *
 * @param dependencies the profile store, the sessions, the workspace manager, the job host and the crawl's helpers
 * @returns the handlers of the `sites:*` channels
 */
export function createSiteHandlers(dependencies: SiteHandlerDependencies): SiteHandlers {
  const handlers = new SiteHandlerState(dependencies);
  return {
    'sites:list': async () => ({ profiles: dependencies.store.list() }),
    'sites:save': async (request) => handlers.save(request),
    'sites:delete': ({ id }) => handlers.delete(id),
    'sites:openLogin': async ({ profileId, url }) => handlers.openLogin(profileId, url),
    'sites:openCheck': ({ host }) => handlers.openCheck(host),
    'sites:crawl': ({ profileId, url }) => handlers.crawl(profileId, url),
    'sites:crawlProgress': async () => handlers.crawlProgress(),
    'sites:cancelCrawl': async () => handlers.cancelCrawl(),
    'sites:import': ({ crawlId, target }) => handlers.importCrawl(crawlId, target),
  };
}

/** The state of the site import channels: the crawl that runs and the answer of the last one. */
class SiteHandlerState {
  private readonly store: SiteProfileStore;
  private readonly sessions: SiteSessions;
  private readonly manager: WorkspaceManager;
  private readonly newId: () => string;
  private readonly wait: SiteCrawlDependencies['wait'];
  private running: RunningCrawl | null = null;
  private kept: KeptCrawl | null = null;

  /**
   * @param dependencies what `createSiteHandlers` was wired with
   */
  constructor(private readonly dependencies: SiteHandlerDependencies) {
    this.store = dependencies.store;
    this.sessions = dependencies.sessions;
    this.manager = dependencies.manager;
    this.newId = dependencies.newId ?? randomUUID;
    this.wait = dependencies.wait ?? abortableWait;
  }

  /**
   * Whether a crawl or the login window uses the profile.
   *
   * @param profileId the profile's id
   * @returns true while one of them is active
   */
  private inUse(profileId: string): boolean {
    return this.running?.profileId === profileId || this.sessions.loginProfileId() === profileId;
  }

  /**
   * Refuses a change of a profile that is in use.
   *
   * @param profileId the profile's id
   * @throws InvalidOperationError while a crawl or the login window uses it
   */
  private refuseInUse(profileId: string): void {
    if (this.inUse(profileId)) throw new InvalidOperationError(IN_USE);
  }

  /**
   * Drops the kept answer of a crawl of the profile.
   *
   * @param profileId the profile's id
   */
  private forget(profileId: string): void {
    if (this.kept?.profileId === profileId) this.kept = null;
  }

  /**
   * The profile of an id.
   *
   * @param id the profile's id
   * @returns the profile
   * @throws NotFoundError when it does not exist
   */
  private requireProfile(id: string): SiteProfile {
    const profile = this.store.get(id);
    if (profile === null) throw new NotFoundError(SITE_PROFILE_NOT_FOUND);
    return profile;
  }

  /**
   * `sites:save`: a profile in use is not changed.
   *
   * @param request the profile to save
   * @returns the saved profile
   */
  save(request: IpcRequest<'sites:save'>): IpcResponse<'sites:save'> {
    if (request.id !== undefined) this.refuseInUse(request.id);
    const profile = this.store.save(request);
    this.forget(profile.id);
    return profile;
  }

  /**
   * `sites:delete`: refused while the profile is in use or has active downloads in the open workspace; the session's
   * data is cleared afterwards.
   *
   * @param id the profile's id
   * @returns an empty answer
   */
  async delete(id: string): Promise<IpcResponse<'sites:delete'>> {
    this.refuseInUse(id);
    this.requireProfile(id);
    const removed = await this.removeInWorkspace(id);
    if (!removed) this.remove(id);
    try {
      await this.sessions.clear(id);
    } catch {
      this.dependencies.log?.(`site profile ${id}: session_clear_failed`);
    }
    return {};
  }

  /**
   * Removes the profile inside the open workspace's queue, after checking it has no active download.
   *
   * @param id the profile's id
   * @returns true when it was removed; false when no workspace is open or it closed meanwhile
   */
  private async removeInWorkspace(id: string): Promise<boolean> {
    if (this.manager.current() === null) return false;
    try {
      await this.manager.exclusive((session) => this.removeUnlessDownloading(session, id));
      return true;
    } catch (error) {
      // Closed meanwhile: no workspace, so no download of it can be active.
      if (!(error instanceof NoWorkspaceOpenError)) throw error;
      return false;
    }
  }

  /**
   * Removes the profile unless the workspace has an active download of it.
   *
   * @param session the open workspace
   * @param id the profile's id
   * @throws InvalidOperationError when a download of the profile is active
   */
  private async removeUnlessDownloading(session: WorkspaceSession, id: string): Promise<void> {
    if (await hasActiveDownloads(session, id)) throw new InvalidOperationError(ACTIVE_DOWNLOADS);
    this.remove(id);
  }

  /**
   * Deletes the profile and its kept crawl.
   *
   * @param id the profile's id
   */
  private remove(id: string): void {
    // A login window or a crawl may have started while the workspace check waited.
    this.refuseInUse(id);
    this.store.delete(id);
    this.forget(id);
  }

  /**
   * Focuses the open login window of the profile.
   *
   * @param profileId the profile that wants the login window
   * @returns true when the profile's window was focused, false when none is open
   * @throws InvalidOperationError when another profile's login window is open
   */
  private focusOpenLogin(profileId: string): boolean {
    const open = this.sessions.loginProfileId();
    if (open === null) return false;
    if (open !== profileId) throw new InvalidOperationError(OTHER_LOGIN);
    this.sessions.focusLogin();
    return true;
  }

  /**
   * `sites:openLogin`: focuses the profile's open window, else opens it on the typed address or the site.
   *
   * @param profileId the profile's id
   * @param url the typed address, if any
   * @returns an empty answer
   */
  openLogin(profileId: string, url: string | undefined): IpcResponse<'sites:openLogin'> {
    const profile = this.requireProfile(profileId);
    if (this.focusOpenLogin(profileId)) return {};
    // The typed address passes the URL rule of the sources (`validation_failed`); it may be on any public host.
    const target = url === undefined ? `https://${profile.site}/` : normalizeSourceUrl(url);
    this.sessions.openLogin(profile, target);
    return {};
  }

  /**
   * `sites:openCheck`: opens the login window on the newest download a browser check refused, else on the site.
   *
   * @param host the site of the profile
   * @returns an empty answer
   */
  async openCheck(host: string): Promise<IpcResponse<'sites:openCheck'>> {
    const profile = this.store.list().find((candidate) => candidate.site === host);
    if (profile === undefined) throw new NotFoundError(SITE_PROFILE_NOT_FOUND);
    if (this.focusOpenLogin(profile.id)) return {};
    const target = await this.refusedUrlInWorkspace(profile);
    // A login window may have opened while the workspace was read.
    if (this.sessions.loginProfileId() !== null) throw new InvalidOperationError(OTHER_LOGIN);
    this.sessions.openLogin(profile, target ?? `https://${profile.site}/`);
    return {};
  }

  /**
   * The URL of the newest refused download of the profile in the open workspace.
   *
   * @param profile the profile
   * @returns the URL, or null without a workspace or such a download
   */
  private async refusedUrlInWorkspace(profile: SiteProfile): Promise<string | null> {
    if (this.manager.current() === null) return null;
    try {
      return await this.manager.read((session) => refusedDownloadUrl(session, profile));
    } catch (error) {
      // Closed meanwhile: the site's start page.
      if (!(error instanceof NoWorkspaceOpenError)) throw error;
      return null;
    }
  }

  /**
   * `sites:crawl`: runs one crawl in the hidden page window and keeps its answer.
   *
   * @param profileId the profile's id
   * @param url the gallery URL
   * @returns the crawl's id and answer
   */
  async crawl(profileId: string, url: string): Promise<IpcResponse<'sites:crawl'>> {
    if (this.running !== null) throw new InvalidOperationError(ALREADY_RUNNING);
    const profile = this.requireProfile(profileId);
    // Refused before any page window opens (`validation_failed`).
    const galleryUrl = siteGalleryUrl(profile, url);
    const entry: RunningCrawl = { profileId, controller: new AbortController(), progress: { pages: 0, files: 0 } };
    this.running = entry;
    this.kept = null;
    let page: ReturnType<SiteSessions['openPage']> | null = null;
    try {
      // A page window that goes away (main window closed, app quitting) ends the crawl like a cancel.
      page = this.sessions.openPage(profile, () => entry.controller.abort());
      const answer = await crawlSite(
        { pages: page.loader, robots: this.dependencies.robots, wait: this.wait },
        {
          profile,
          url,
          signal: entry.controller.signal,
          onProgress: (progress) => {
            entry.progress = { pages: progress.pages, files: progress.files };
          },
        },
      );
      const crawlId = this.newId();
      this.kept = {
        crawlId,
        profileId,
        galleryUrl,
        filter: { kinds: [...profile.kinds], minBytes: profile.minBytes },
        files: [...answer.files],
      };
      return { crawlId, ...answer };
    } finally {
      page?.close();
      this.running = null;
    }
  }

  /**
   * `sites:crawlProgress`.
   *
   * @returns the progress of the running crawl, or null when none runs
   */
  crawlProgress(): SiteCrawlProgress | null {
    const running = this.running;
    return running === null ? null : { ...running.progress, cancelling: running.controller.signal.aborted };
  }

  /**
   * `sites:cancelCrawl`.
   *
   * @returns whether a crawl is being cancelled
   */
  cancelCrawl(): IpcResponse<'sites:cancelCrawl'> {
    if (this.running === null) return { cancelling: false };
    this.running.controller.abort();
    return { cancelling: true };
  }

  /**
   * `sites:import`: queues exactly the kept answer of the crawl.
   *
   * @param crawlId the crawl whose answer is queued
   * @param target the inbox (null) or an asset and role
   * @returns the queued, duplicate and invalid entries
   */
  async importCrawl(
    crawlId: string,
    target: IpcRequest<'sites:import'>['target'],
  ): Promise<IpcResponse<'sites:import'>> {
    const answer = this.kept;
    if (answer === null || answer.crawlId !== crawlId) throw new InvalidOperationError(RUN_AGAIN);
    const result = await this.manager.exclusive((session) => this.queueImport(session, answer, target));
    this.dependencies.jobs.changed();
    this.dependencies.jobs.wake();
    return result;
  }

  /**
   * Queues the kept files and adds the gallery as a source of the target asset.
   *
   * @param session the open workspace
   * @param answer the kept crawl
   * @param target the inbox (null) or an asset and role
   * @returns what `enqueueUrlImport` answered
   */
  private async queueImport(
    session: WorkspaceSession,
    answer: KeptCrawl,
    target: IpcRequest<'sites:import'>['target'],
  ): Promise<IpcResponse<'sites:import'>> {
    // The profile may have been changed or deleted while this waited for the queue.
    const profile = this.store.get(answer.profileId);
    if (this.kept !== answer || profile === null) throw new InvalidOperationError(RUN_AGAIN);
    const queued = await enqueueUrlImport(session, {
      urls: answer.files,
      target,
      skipDuplicates: true,
      site: { profileId: answer.profileId, site: profile.site, filter: answer.filter },
    });
    if (target !== null) {
      try {
        await addAssetSource(session, { assetId: target.assetId, url: answer.galleryUrl });
      } catch {
        // An existing source or a full list never fails the import.
      }
    }
    return queued;
  }
}
