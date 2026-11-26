import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  builtInAnalysisPrompt,
  countActiveAnalysisJobs,
  WorkspaceManager,
  type GenerationImageSource,
  type ImageProbe,
  type ModelImageSource,
  type WorkspaceHost,
} from '@assetforge/core';
import { IMAGE_GENERATE_JOB, WorkspaceSummarySchema, type ResourceClass } from '@assetforge/contracts';
import { createPauseGate, type PauseGate } from '@assetforge/jobs';
import { openWorkspaceDatabase } from '@assetforge/persistence';
import { createOllamaVision, createVeniceImage, OLLAMA_PROVIDER } from '@assetforge/providers';
import { LocalFileSystemStorage, NodeSourceFiles, ZipArchiveReader } from '@assetforge/storage';
import { createAnalysisPromptHandlers } from './analysis-prompt-handlers.js';
import { createAnalysisPromptStore } from './analysis-prompts.js';
import { createDescribeController } from './describe-controller.js';
import { createImageProviderDirectory } from './generation-handlers.js';
import type { AppServices } from './ipc.js';
import { createJobHost, type JobHost, type SchedulerClock } from './job-host.js';
import { JsonWorkspaceRegistry } from './json-registry.js';
import { createProviderGateway, type ProviderGateway } from './provider-gateway.js';
import { createProviderHandlers } from './provider-handlers.js';
import { createProviderStore } from './provider-store.js';
import type { SecretCodec } from './secret-codec.js';

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
  limits?: Record<ResourceClass, number>;
  /** The scheduler's clock; real time without it. */
  clock?: SchedulerClock;
}): AnalysisServices {
  const store = createProviderStore({ userData: o.userDataPath, secrets: o.secrets, env: o.env });
  // Registers its change listener first, so the entry's adapter is dropped before its lane resumes.
  const gateway = createProviderGateway({ store, create: createOllamaVision, createImage: createVeniceImage, log: o.log });
  const imageProviders = createImageProviderDirectory(store, gateway);
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
    vision: (lane) => gateway.vision(lane),
    images: o.images,
    provider: OLLAMA_PROVIDER,
    pause,
    firstEntry: () => store.first(),
    imageProviders,
    generationImages: o.generationImages,
    ...(o.limits === undefined ? {} : { limits: o.limits }),
    ...(o.clock === undefined ? {} : { clock: o.clock }),
  });
  jobHost = host;
  // A saved or deleted entry may fix what paused its lane; the other lanes stay as they are.
  store.onChange((id) => host.resume(id));
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
