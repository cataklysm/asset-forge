import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  builtInAnalysisPrompt,
  countActiveAnalysisJobs,
  createRobotsReader,
  InvalidOperationError,
  WorkspaceManager,
  type SiteCrawlDependencies,
  type GenerationImageSource,
  type ImageProbe,
  type VideoProbe,
  type ModelImageSource,
  type RemoteFileSource,
  type WorkspaceHost,
} from '@assetforge/core';
import { IMAGE_GENERATE_JOB, isVisionKind, WorkspaceSummarySchema, type ResourceClass } from '@assetforge/contracts';
import { createPauseGate, type PauseGate } from '@assetforge/jobs';
import { openWorkspaceDatabase } from '@assetforge/persistence';
import { createOllamaVision, createOpenAiVision, createVeniceImage } from '@assetforge/providers';
import { createUrlSource, LocalFileSystemStorage, NodeSourceFiles, ZipArchiveReader } from '@assetforge/storage';
import { createAnalysisPromptHandlers } from './analysis-prompt-handlers.js';
import { createAnalysisPromptStore } from './analysis-prompts.js';
import { createDescribeController } from './describe-controller.js';
import { createImageProviderDirectory } from './generation-handlers.js';
import type { AppServices } from './workspace-handlers.js';
import { createChangeFeed } from './change-feed.js';
import { createJobHost, PROVIDER_CLASSES, type JobHost, type SchedulerClock } from './job-host.js';
import { JsonWorkspaceRegistry } from './json-registry.js';
import { createProviderGateway, type ProviderGateway } from './provider-gateway.js';
import { createProviderHandlers } from './provider-handlers.js';
import { createProviderStore, type ProviderStore } from './provider-store.js';
import type { SecretCodec } from './secret-codec.js';
import { createSiteHandlers } from './site-handlers.js';
import { createSiteProfileStore, type SiteProfileStore } from './site-profile-store.js';
import { createSiteAccess } from './site-access.js';
import type { SiteSessions } from './site-sessions.js';

export interface CompositionOptions {
  userDataPath: string;
  /**
   * Required: the persistence package's `MIGRATIONS_FOLDER` is derived from its own
   * module URL, which points to the wrong place once the main process is bundled.
   * The host passes the bundled copy; tests pass `MIGRATIONS_FOLDER` explicitly.
   */
  migrationsFolder: string;
  /**
   * Moves a folder to the operating system's trash (Electron's `shell.trashItem` in the
   * app). Without it, removing a workspace together with its folder fails instead of
   * falling back to a permanent delete.
   */
  moveToTrash?: (absolutePath: string) => Promise<void>;
  /** Reads image dimensions (the media worker pool in the app). Defaults to a probe that never measures. */
  imageProbe?: ImageProbe;
  /** Reads video size and duration (the frame tool in the app). Defaults to a probe that never measures. */
  videoProbe?: VideoProbe;
}

const WorkspaceIdSchema = WorkspaceSummarySchema.shape.id;

/**
 * Wires the real adapters. Layout under userDataPath:
 * `settings.json`, `workspaces/<workspace-uuid>/assetforge.sqlite`.
 */
export function createWorkspaceHost(opts: CompositionOptions): WorkspaceHost {
  const { migrationsFolder } = opts;
  // The id comes from a manifest on disk and becomes a directory name.
  const databaseDir = (workspaceId: string) => {
    if (!WorkspaceIdSchema.safeParse(workspaceId).success) {
      throw new Error('Invalid workspace id: expected a UUID');
    }
    return join(opts.userDataPath, 'workspaces', workspaceId);
  };
  return {
    registry: new JsonWorkspaceRegistry(join(opts.userDataPath, 'settings.json')),
    sources: new NodeSourceFiles(),
    archives: new ZipArchiveReader(),
    imageProbe: opts.imageProbe ?? { measure: async () => null },
    videoProbe: opts.videoProbe ?? { measure: async () => null },
    createStorage: (rootPath) => new LocalFileSystemStorage(rootPath),
    openDatabase: async (workspaceId) =>
      openWorkspaceDatabase(join(databaseDir(workspaceId), 'assetforge.sqlite'), migrationsFolder),
    deleteDatabase: async (workspaceId) => {
      await rm(databaseDir(workspaceId), { recursive: true, force: true });
    },
    moveToTrash:
      opts.moveToTrash ??
      (async () => {
        throw new Error('No trash implementation configured');
      }),
    newId: () => randomUUID(),
    now: () => new Date(),
  };
}

export function createWorkspaceManager(opts: CompositionOptions): WorkspaceManager {
  return new WorkspaceManager(createWorkspaceHost(opts));
}

/**
 * The lane limit of the job host: for an analysis lane the `parallelRequests` of the vision entry with the lane's id,
 * read on every call so a saved value applies on the next claim; `undefined` for every other class, an unknown lane
 * and an entry without options, which keeps the class limit.
 */
export function providerLaneLimit(store: Pick<ProviderStore, 'get'>) {
  return (resourceClass: ResourceClass, lane: string | null): number | undefined => {
    if (resourceClass !== 'local_gpu' || lane === null) return undefined;
    const entry = store.get(lane);
    return entry !== null && isVisionKind(entry.kind) ? entry.options?.parallelRequests : undefined;
  };
}

/**
 * The downloads of one site profile run one after another: its jobs share the lane named after the profile's site,
 * and that lane takes one job at a time. Every other download lane keeps the class limit.
 *
 * @param sites the site profiles; read at every claim, so a new or deleted profile applies at once
 * @returns the scheduler's `laneLimit` for download lanes: 1 for the lane of a profile's site, otherwise undefined
 */
export function siteLaneLimit(sites: Pick<SiteProfileStore, 'list'>) {
  return (resourceClass: ResourceClass, lane: string | null): number | undefined =>
    resourceClass === 'io' && lane !== null && sites.list().some((profile) => profile.site === lane) ? 1 : undefined;
}

const NO_WINDOWS = 'Site logins are not available';

/** The site sessions without Electron: no window opens, no login is sent. */
const noSiteSessions: SiteSessions = {
  openLogin: () => {
    throw new InvalidOperationError(NO_WINDOWS);
  },
  loginProfileId: () => null,
  focusLogin: () => {},
  openPage: () => {
    throw new InvalidOperationError(NO_WINDOWS);
  },
  cookies: async () => [],
  userAgent: () => '',
  clear: async () => {},
};

export interface AnalysisServices extends AppServices {
  gateway: ProviderGateway;
  /** One per app session: a pause outlives closing and reopening a workspace. */
  pause: PauseGate;
  jobHost: JobHost;
  /** Starts the jobs of the open workspace. Never rejects. */
  workspaceOpened(): Promise<void>;
  /** Cancels a running describe request and stops the jobs. Never rejects. */
  workspaceClosing(): Promise<void>;
}

/**
 * The provider entries, one adapter per entry, the job host with the app session's pause gate and the
 * describe controller. The provider store is the only source of base URLs, keys and models.
 */
export function createAnalysisServices(o: {
  manager: WorkspaceManager;
  userDataPath: string;
  secrets: SecretCodec;
  env: NodeJS.ProcessEnv;
  images: ModelImageSource;
  /** Reads the image a generation sends. */
  generationImages: GenerationImageSource;
  /** One main-console line per provider failure: code and HTTP status only. */
  log: (line: string) => void;
  /** The app's version, sent in the download user agent `AssetForge/<version>`. */
  appVersion: string;
  /**
   * Tests only: the network side of the URL import. Without it (always in the app) downloads go through the URL
   * source with its default policy, which reaches public addresses only.
   */
  remote?: RemoteFileSource;
  limits?: Record<ResourceClass, number>;
  totals?: Partial<Record<ResourceClass, number>>;
  /** The scheduler's clock; real time without it. */
  clock?: SchedulerClock;
  /**
   * The login windows, hidden crawl windows and browser sessions of the site profiles (Electron's in the app).
   * Without it no window can open: a login or crawl answers `invalid_operation` and a site download sends no login.
   */
  siteSessions?: SiteSessions;
  /** Tests only: the pause between two page loads of a crawl; a real, abortable timer without it. */
  siteWait?: SiteCrawlDependencies['wait'];
}): AnalysisServices {
  const store = createProviderStore({ userData: o.userDataPath, secrets: o.secrets, env: o.env });
  // Registers its change listener first, so the entry's adapter is dropped before its lane resumes.
  const gateway = createProviderGateway({
    store,
    createVision: { ollama: createOllamaVision, openai: createOpenAiVision },
    createImage: createVeniceImage,
    log: o.log,
  });
  const imageProviders = createImageProviderDirectory(store, gateway);
  // No address policy is passed: the default one admits public addresses only, and nothing in the app weakens it.
  // The robots.txt of a crawl is read through the same source, without options (no login, the downloader's agent).
  const remote = o.remote ?? createUrlSource({ userAgent: `AssetForge/${o.appVersion}` });
  const siteStore = createSiteProfileStore({ userData: o.userDataPath });
  const siteSessions = o.siteSessions ?? noSiteSessions;
  const providerLimit = providerLaneLimit(store);
  const siteLimit = siteLaneLimit(siteStore);
  let jobHost: JobHost | null = null;
  const pause = createPauseGate({
    // A pause or resume changes the summary; the listener must not throw.
    onChange: () => {
      try {
        jobHost?.changed();
      } catch {
        // The counter only drives polling; nothing to do.
      }
    },
  });
  const host = createJobHost({
    manager: o.manager,
    feed: createChangeFeed(),
    vision: (lane) => gateway.vision(lane),
    images: o.images,
    // The fingerprint provider id is the kind of the lane's vision entry (OLLAMA_PROVIDER or OPENAI_PROVIDER).
    provider: (lane) => {
      const entry = lane === null ? null : store.get(lane);
      return entry !== null && isVisionKind(entry.kind) ? entry.kind : null;
    },
    pause,
    firstEntry: () => store.first(),
    imageProviders,
    generationImages: o.generationImages,
    remote,
    sites: createSiteAccess(siteStore, siteSessions, { remote }),
    ...(o.limits === undefined ? {} : { limits: o.limits }),
    ...(o.totals === undefined ? {} : { totals: o.totals }),
    ...(o.clock === undefined ? {} : { clock: o.clock }),
    laneLimit: (resourceClass, lane) => providerLimit(resourceClass, lane) ?? siteLimit(resourceClass, lane),
  });
  jobHost = host;
  // A saved or deleted entry may fix what paused its lane, or change its parallel requests; the other lanes and every
  // download host stay as they are.
  store.onChange((id) => host.resume(id, PROVIDER_CLASSES));
  const describe = createDescribeController({ manager: o.manager, vision: (id) => gateway.vision(id), images: o.images });
  const prompts = createAnalysisPromptStore({
    userData: o.userDataPath,
    newId: randomUUID,
    builtIn: builtInAnalysisPrompt,
    log: o.log,
  });

  const providers = createProviderHandlers(store, gateway, {
    // Without an open workspace no job can be active here; jobs of another workspace fail later as not configured.
    hasActiveJobs: async (id) =>
      o.manager.current() !== null &&
      (await o.manager.read(
        async (s) => (await countActiveAnalysisJobs(s, id)) + (await s.database.jobs.countActiveInLane(IMAGE_GENERATE_JOB, id)),
      )) > 0,
  });

  return {
    providerStore: store,
    imageProviders,
    gateway,
    pause,
    jobHost: host,
    providers,
    analysisPrompts: createAnalysisPromptHandlers(prompts),
    prompts,
    describe,
    isSiteLane: (host) => siteStore.list().some((profile) => profile.site === host),
    sites: createSiteHandlers({
      store: siteStore,
      sessions: siteSessions,
      manager: o.manager,
      jobs: host,
      robots: createRobotsReader(remote),
      ...(o.siteWait === undefined ? {} : { wait: o.siteWait }),
      log: o.log,
    }),
    workspaceOpened: async () => {
      describe.unblock();
      await host.workspaceOpened();
    },
    async workspaceClosing() {
      // No new describe request starts until the lifecycle step is over: `workspaceOpened` follows
      // when a workspace is open afterwards, and without one the request answers no_workspace_open.
      describe.block();
      await describe.cancelAll();
      await host.workspaceClosing();
    },
  };
}
