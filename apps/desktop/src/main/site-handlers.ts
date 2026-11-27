import { randomUUID } from 'node:crypto';
import {
  FILE_DOWNLOAD_JOB,
  FileDownloadPayloadSchema,
  type JobStatus,
  type SiteCrawlProgress,
  type SiteFilter,
} from '@assetforge/contracts';
import {
  addAssetSource,
  crawlSite,
  enqueueUrlImport,
  InvalidOperationError,
  NoWorkspaceOpenError,
  normalizeSourceUrl,
  NotFoundError,
  siteGalleryUrl,
  type SiteCrawlDeps,
  type WorkspaceManager,
  type WorkspaceSession,
} from '@assetforge/core';
import type { IpcHandlers } from './ipc.js';
import type { JobHost } from './job-host.js';
import { SITE_PROFILE_NOT_FOUND, type SiteProfileStore } from './site-profile-store.js';
import type { SiteSessions } from './site-sessions.js';

// The site import channels (spec "The crawl", "Download", "Channels"). Kept free of Electron imports: the windows
// and sessions are behind SiteSessions. Every channel works without a workspace except `sites:import`. One crawl
// runs at a time, in memory; the answer of the last one is kept until the next crawl, a change or deletion of its
// profile, or the app's end. No answer, log line or error carries a URL or a cookie.

export type SiteHandlers = Pick<
  IpcHandlers,
  | 'sites:list'
  | 'sites:save'
  | 'sites:delete'
  | 'sites:openLogin'
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

const ACTIVE_STATUSES: readonly JobStatus[] = ['queued', 'running', 'waiting_remote', 'retry_wait'];

/** Resolves after `ms`; rejects with the abort reason at once when `signal` aborts. */
export function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Whether the open workspace has a queued, waiting or running download of this profile. */
async function hasActiveDownloads(s: WorkspaceSession, profileId: string): Promise<boolean> {
  for (const status of ACTIVE_STATUSES) {
    for (const job of await s.database.jobs.listByStatus(status)) {
      if (job.type !== FILE_DOWNLOAD_JOB) continue;
      const payload = FileDownloadPayloadSchema.safeParse(job.payload);
      if (payload.success && payload.data.v === 2 && payload.data.siteProfileId === profileId) return true;
    }
  }
  return false;
}

interface RunningCrawl {
  profileId: string;
  controller: AbortController;
  progress: { pages: number; files: number };
}

interface KeptCrawl {
  crawlId: string;
  profileId: string;
  galleryUrl: string;
  filter: SiteFilter;
  files: string[];
}

export function createSiteHandlers(deps: {
  store: SiteProfileStore;
  sessions: SiteSessions;
  manager: WorkspaceManager;
  jobs: Pick<JobHost, 'changed' | 'wake'>;
  robots: SiteCrawlDeps['robots'];
  wait?: SiteCrawlDeps['wait'];
  newId?: () => string;
  /** One line with at most a profile id and a fixed code. */
  log?: (line: string) => void;
}): SiteHandlers {
  const { store, sessions, manager } = deps;
  const newId = deps.newId ?? randomUUID;
  const wait = deps.wait ?? abortableWait;
  let running: RunningCrawl | null = null;
  let kept: KeptCrawl | null = null;

  const inUse = (profileId: string): boolean => running?.profileId === profileId || sessions.loginProfileId() === profileId;
  const refuseInUse = (profileId: string): void => {
    if (inUse(profileId)) throw new InvalidOperationError(IN_USE);
  };
  const forget = (profileId: string): void => {
    if (kept?.profileId === profileId) kept = null;
  };
  const requireProfile = (id: string) => {
    const profile = store.get(id);
    if (profile === null) throw new NotFoundError(SITE_PROFILE_NOT_FOUND);
    return profile;
  };

  return {
    'sites:list': async () => ({ profiles: store.list() }),

    'sites:save': async (request) => {
      if (request.id !== undefined) refuseInUse(request.id);
      const profile = store.save(request);
      forget(profile.id);
      return profile;
    },

    'sites:delete': async ({ id }) => {
      refuseInUse(id);
      requireProfile(id);
      const remove = () => {
        // A login window or a crawl may have started while the workspace check waited.
        refuseInUse(id);
        store.delete(id);
        forget(id);
      };
      let removed = false;
      if (manager.current() !== null) {
        try {
          await manager.exclusive(async (s) => {
            if (await hasActiveDownloads(s, id)) throw new InvalidOperationError(ACTIVE_DOWNLOADS);
            remove();
          });
          removed = true;
        } catch (error) {
          // Closed meanwhile: no workspace, so no download of it can be active.
          if (!(error instanceof NoWorkspaceOpenError)) throw error;
        }
      }
      if (!removed) remove();
      try {
        await sessions.clear(id);
      } catch {
        deps.log?.(`site profile ${id}: session_clear_failed`);
      }
      return {};
    },

    'sites:openLogin': async ({ profileId, url }) => {
      const profile = requireProfile(profileId);
      const open = sessions.loginProfileId();
      if (open !== null) {
        if (open !== profileId) throw new InvalidOperationError(OTHER_LOGIN);
        sessions.focusLogin();
        return {};
      }
      // The typed address passes the URL rule of the sources (`validation_failed`); it may be on any public host.
      const target = url === undefined ? `https://${profile.site}/` : normalizeSourceUrl(url);
      sessions.openLogin(profile, target);
      return {};
    },

    'sites:crawl': async ({ profileId, url }) => {
      if (running !== null) throw new InvalidOperationError(ALREADY_RUNNING);
      const profile = requireProfile(profileId);
      // Refused before any page window opens (`validation_failed`).
      const galleryUrl = siteGalleryUrl(profile, url);
      const entry: RunningCrawl = { profileId, controller: new AbortController(), progress: { pages: 0, files: 0 } };
      running = entry;
      kept = null;
      let page: ReturnType<SiteSessions['openPage']> | null = null;
      try {
        // A page window that goes away (main window closed, app quitting) ends the crawl like a cancel.
        page = sessions.openPage(profile, () => entry.controller.abort());
        const answer = await crawlSite(
          { pages: page.loader, robots: deps.robots, wait },
          {
            profile,
            url,
            signal: entry.controller.signal,
            onProgress: (p) => {
              entry.progress = { pages: p.pages, files: p.files };
            },
          },
        );
        const crawlId = newId();
        kept = {
          crawlId,
          profileId,
          galleryUrl,
          filter: { kinds: [...profile.kinds], minBytes: profile.minBytes },
          files: [...answer.files],
        };
        return { crawlId, ...answer };
      } finally {
        page?.close();
        running = null;
      }
    },

    'sites:crawlProgress': async (): Promise<SiteCrawlProgress | null> =>
      running === null ? null : { ...running.progress, cancelling: running.controller.signal.aborted },

    'sites:cancelCrawl': async () => {
      if (running === null) return { cancelling: false };
      running.controller.abort();
      return { cancelling: true };
    },

    'sites:import': async ({ crawlId, target }) => {
      const answer = kept;
      if (answer === null || answer.crawlId !== crawlId) throw new InvalidOperationError(RUN_AGAIN);
      const result = await manager.exclusive(async (s) => {
        // The profile may have been changed or deleted while this waited for the queue.
        const profile = store.get(answer.profileId);
        if (kept !== answer || profile === null) throw new InvalidOperationError(RUN_AGAIN);
        const queued = await enqueueUrlImport(s, {
          urls: answer.files,
          target,
          skipDuplicates: true,
          site: { profileId: answer.profileId, site: profile.site, filter: answer.filter },
        });
        if (target !== null) {
          try {
            await addAssetSource(s, { assetId: target.assetId, url: answer.galleryUrl });
          } catch {
            // An existing source or a full list never fails the import.
          }
        }
        return queued;
      });
      deps.jobs.changed();
      deps.jobs.wake();
      return result;
    },
  };
}
