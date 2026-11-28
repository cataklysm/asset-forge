import { randomUUID } from 'node:crypto';
import {
  builtInAnalysisPrompt,
  countActiveAnalysisJobs,
  createRobotsReader,
  InvalidOperationError,
  type GenerationImageSource,
  type ImageProviderDirectory,
  type ModelImageSource,
  type RemoteFileSource,
  type SiteCrawlDependencies,
  type WorkspaceManager,
  type WorkspaceSession,
} from '@assetforge/core';
import { IMAGE_GENERATE_JOB, isVisionKind, type ProviderKind, type ResourceClass } from '@assetforge/contracts';
import { createPauseGate, type PauseGate } from '@assetforge/jobs';
import { createOllamaVision, createOpenAiVision, createVeniceImage } from '@assetforge/providers';
import { createUrlSource } from '@assetforge/storage';
import { createAnalysisPromptHandlers } from './analysis-prompt-handlers.js';
import { createAnalysisPromptStore } from './analysis-prompts.js';
import { createChangeFeed } from './change-feed.js';
import { createDescribeController, type DescribeController } from './describe-controller.js';
import { createImageProviderDirectory } from './image-provider-directory.js';
import { createJobHost, PROVIDER_CLASSES, type JobHost, type SchedulerClock } from './job-host.js';
import { providerLaneLimit, siteLaneLimit } from './lane-limits.js';
import { createProviderGateway, type ProviderGateway } from './provider-gateway.js';
import { createProviderHandlers } from './provider-handlers.js';
import { createProviderStore, type ProviderStore } from './provider-store.js';
import type { SecretCodec } from './secret-codec.js';
import { createSiteAccess } from './site-access.js';
import { createSiteHandlers } from './site-handlers.js';
import { createSiteProfileStore, type SiteProfileStore } from './site-profile-store.js';
import type { SiteSessions } from './site-sessions.js';
import type { AppServices } from './workspace-handlers.js';

// The app-level side of the wiring: provider entries, the job host, analysis prompts and site profiles.

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

/** The app-level services with what the host itself needs of them. */
export interface AnalysisServices extends AppServices {
  /** One adapter per provider entry. */
  gateway: ProviderGateway;
  /** One per app session: a pause outlives closing and reopening a workspace. */
  pause: PauseGate;
  /** The job host of the open workspace. */
  jobHost: JobHost;
  /** Starts the jobs of the open workspace. Never rejects. */
  workspaceOpened(): Promise<void>;
  /** Cancels a running describe request and stops the jobs. Never rejects. */
  workspaceClosing(): Promise<void>;
}

/** What the host passes to the app-level wiring. */
export interface AnalysisServiceOptions {
  /** The workspace manager. */
  manager: WorkspaceManager;
  /** The app's `userData` directory. */
  userDataPath: string;
  /** Encrypts and decrypts the API keys. */
  secrets: SecretCodec;
  /** The process environment, read for the environment mode. */
  env: NodeJS.ProcessEnv;
  /** Reads the image an analysis sends. */
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
  /** The scheduler's class limits; its defaults without it. */
  limits?: Record<ResourceClass, number>;
  /** The scheduler's totals; its defaults without it. */
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
}

/**
 * The provider entries, one adapter per entry, the job host with the app session's pause gate and the
 * describe controller. The provider store is the only source of base URLs, keys and models.
 *
 * @param options what the host passes
 * @returns the services
 */
export function createAnalysisServices(options: AnalysisServiceOptions): AnalysisServices {
  const store = createProviderStore({ userData: options.userDataPath, secrets: options.secrets, env: options.env });
  // Registers its change listener first, so the entry's adapter is dropped before its lane resumes.
  const gateway = createProviderGateway({
    store,
    createVision: { ollama: createOllamaVision, openai: createOpenAiVision },
    createImage: createVeniceImage,
    log: options.log,
  });
  const imageProviders = createImageProviderDirectory(store, gateway);
  // No address policy is passed: the default one admits public addresses only, and nothing in the app weakens it.
  // The robots.txt of a crawl is read through the same source, without options (no login, the downloader's agent).
  const remote = options.remote ?? createUrlSource({ userAgent: `AssetForge/${options.appVersion}` });
  const siteStore = createSiteProfileStore({ userData: options.userDataPath });
  const siteSessions = options.siteSessions ?? noSiteSessions;
  const { host, pause } = createJobs(options, { store, gateway, imageProviders, remote, siteStore, siteSessions });
  // A saved or deleted entry may fix what paused its lane, or change its parallel requests; the other lanes and every
  // download host stay as they are.
  store.onChange((id) => host.resume(id, PROVIDER_CLASSES));
  const describe = createDescribeController({
    manager: options.manager,
    vision: (id) => gateway.vision(id),
    images: options.images,
  });
  const prompts = createAnalysisPromptStore({
    userData: options.userDataPath,
    newId: randomUUID,
    builtIn: builtInAnalysisPrompt,
    log: options.log,
  });

  const providers = createProviderHandlers(store, gateway, {
    hasActiveJobs: (id) => hasActiveProviderJobs(options.manager, id),
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
    isSiteLane: (lane) => siteStore.list().some((profile) => profile.site === lane),
    sites: createSiteHandlers({
      store: siteStore,
      sessions: siteSessions,
      manager: options.manager,
      jobs: host,
      robots: createRobotsReader(remote),
      ...(options.siteWait === undefined ? {} : { wait: options.siteWait }),
      log: options.log,
    }),
    workspaceOpened: () => workspaceOpened(describe, host),
    workspaceClosing: () => workspaceClosing(describe, host),
  };
}

/** The parts the job host is wired from. */
interface JobParts {
  /** The provider entries. */
  store: ProviderStore;
  /** One adapter per entry. */
  gateway: ProviderGateway;
  /** The image entries the generation jobs run on. */
  imageProviders: ImageProviderDirectory;
  /** The network side of the downloads. */
  remote: RemoteFileSource;
  /** The site profiles. */
  siteStore: SiteProfileStore;
  /** The browser sessions of the site profiles. */
  siteSessions: SiteSessions;
}

/**
 * The job host with the app session's pause gate.
 *
 * @param options what the host passes
 * @param parts the entries, adapters and site profiles
 * @returns the job host and the pause gate
 */
function createJobs(options: AnalysisServiceOptions, parts: JobParts): { host: JobHost; pause: PauseGate } {
  const { store, gateway, imageProviders, remote, siteStore, siteSessions } = parts;
  const providerLimit = providerLaneLimit(store);
  const siteLimit = siteLaneLimit(siteStore);
  // The pause gate exists before the job host it reports to.
  const created: { host: JobHost | null } = { host: null };
  const pause = createPauseGate({
    // A pause or resume changes the summary; the listener must not throw.
    onChange: () => {
      try {
        created.host?.changed();
      } catch {
        // The counter only drives polling; nothing to do.
      }
    },
  });
  const host = createJobHost({
    manager: options.manager,
    feed: createChangeFeed(),
    vision: (lane) => gateway.vision(lane),
    images: options.images,
    // The fingerprint provider id is the kind of the lane's vision entry (OLLAMA_PROVIDER or OPENAI_PROVIDER).
    provider: (lane) => fingerprintProvider(store, lane),
    pause,
    firstEntry: () => store.first(),
    imageProviders,
    generationImages: options.generationImages,
    remote,
    sites: createSiteAccess(siteStore, siteSessions, { remote }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.totals === undefined ? {} : { totals: options.totals }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    laneLimit: (resourceClass, lane) => providerLimit(resourceClass, lane) ?? siteLimit(resourceClass, lane),
  });
  created.host = host;
  return { host, pause };
}

/**
 * The fingerprint provider id of a lane: the kind of its vision entry.
 *
 * @param store the provider entries
 * @param lane the lane
 * @returns the kind, or null when the lane has no vision entry
 */
function fingerprintProvider(store: ProviderStore, lane: string | null): ProviderKind | null {
  const entry = lane === null ? null : store.get(lane);
  return entry !== null && isVisionKind(entry.kind) ? entry.kind : null;
}

/**
 * Whether the open workspace has active analysis or generation jobs of an entry.
 * Without an open workspace no job can be active here; jobs of another workspace fail later as not configured.
 *
 * @param manager the workspace manager
 * @param id the entry
 * @returns true while one of its jobs is active
 */
async function hasActiveProviderJobs(manager: WorkspaceManager, id: string): Promise<boolean> {
  return manager.current() !== null && (await manager.read((session) => countActiveProviderJobs(session, id))) > 0;
}

/**
 * The active analysis and generation jobs of an entry.
 *
 * @param session the open workspace
 * @param id the entry
 * @returns their number
 */
async function countActiveProviderJobs(session: WorkspaceSession, id: string): Promise<number> {
  return (
    (await countActiveAnalysisJobs(session, id)) + (await session.database.jobs.countActiveInLane(IMAGE_GENERATE_JOB, id))
  );
}

/**
 * Lets describe requests start again and starts the jobs of the open workspace.
 *
 * @param describe the describe controller
 * @param host the job host
 */
async function workspaceOpened(describe: DescribeController, host: JobHost): Promise<void> {
  describe.unblock();
  await host.workspaceOpened();
}

/**
 * Cancels the describe requests and stops the jobs before a workspace closes.
 *
 * @param describe the describe controller
 * @param host the job host
 */
async function workspaceClosing(describe: DescribeController, host: JobHost): Promise<void> {
  // No new describe request starts until the lifecycle step is over: `workspaceOpened` follows
  // when a workspace is open afterwards, and without one the request answers no_workspace_open.
  describe.block();
  await describe.cancelAll();
  await host.workspaceClosing();
}
