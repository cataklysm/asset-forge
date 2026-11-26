import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceManager, type ImageProbe, type ModelImageSource, type WorkspaceHost } from '@assetforge/core';
import { WorkspaceSummarySchema, type AnalysisPromptPurpose, type ResourceClass } from '@assetforge/contracts';
import { createPauseGate, type PauseGate } from '@assetforge/jobs';
import { openWorkspaceDatabase } from '@assetforge/persistence';
import { createOllamaVision, OLLAMA_PROVIDER } from '@assetforge/providers';
import { LocalFileSystemStorage, NodeSourceFiles } from '@assetforge/storage';
import { createAnalysisPromptHandlers } from './analysis-prompt-handlers.js';
import { createAnalysisPromptStore } from './analysis-prompts.js';
import { createDescribeController } from './describe-controller.js';
import type { AppServices } from './ipc.js';
import { createJobHost, type JobHost } from './job-host.js';
import { JsonWorkspaceRegistry } from './json-registry.js';
import type { SecretCodec } from './secret-codec.js';
import { createSettingsHandlers } from './settings-handlers.js';
import { createVisionGateway, type VisionGateway } from './vision-gateway.js';
import { createVisionSettingsStore, type VisionSettingsStore } from './vision-settings.js';

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

// Replaced by builtInAnalysisPrompt in Task 4.
function builtInAnalysisPromptStandIn(purpose: AnalysisPromptPurpose): { text: string; maxTags: number | null } {
  return purpose === 'tagging'
    ? { text: 'Describe this image with short English lower-case tags.', maxTags: 15 }
    : { text: 'Describe this image as a prompt for an image generator.', maxTags: null };
}

export interface AnalysisServices extends AppServices {
  store: VisionSettingsStore;
  gateway: VisionGateway;
  /** One per app session: a pause outlives closing and reopening a workspace. */
  pause: PauseGate;
  jobHost: JobHost;
  /** Starts the jobs of the open workspace. Never rejects. */
  workspaceOpened(): Promise<void>;
  /** Cancels a running describe request and stops the jobs. Never rejects. */
  workspaceClosing(): Promise<void>;
}

/**
 * The vision provider settings, the adapter built from them, the job host with the app session's pause
 * gate and the describe controller. The settings store is the only source of base URL, key and models.
 */
export function createAnalysisServices(o: {
  manager: WorkspaceManager;
  userDataPath: string;
  secrets: SecretCodec;
  env: NodeJS.ProcessEnv;
  images: ModelImageSource;
  /** One main-console line per provider failure: code and HTTP status only. */
  log: (line: string) => void;
  limits?: Record<ResourceClass, number>;
}): AnalysisServices {
  const store = createVisionSettingsStore({ userData: o.userDataPath, secrets: o.secrets, env: o.env });
  // Registers its change listener first, so the adapter is rebuilt before the queue resumes.
  const gateway = createVisionGateway({ settings: store, create: createOllamaVision, log: o.log });
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
    gateway,
    images: o.images,
    provider: OLLAMA_PROVIDER,
    defaultModel: () => store.defaults().taggingModel,
    pause,
    ...(o.limits === undefined ? {} : { limits: o.limits }),
  });
  jobHost = host;
  // New settings may fix what paused the queue.
  store.onChange(() => host.resume());
  const describe = createDescribeController({ manager: o.manager, vision: () => gateway.current(), images: o.images });
  const prompts = createAnalysisPromptStore({
    userData: o.userDataPath,
    newId: randomUUID,
    builtIn: builtInAnalysisPromptStandIn,
    log: o.log,
  });

  return {
    store,
    gateway,
    pause,
    jobHost: host,
    settings: createSettingsHandlers(store, gateway),
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
