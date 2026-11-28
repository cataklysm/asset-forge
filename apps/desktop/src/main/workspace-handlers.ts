import { join } from 'node:path';
import { SerialQueue, workspaceFolderName, type ImageProviderDirectory, type WorkspaceManager } from '@assetforge/core';
import { createAnalysisHandlers } from './analysis-handlers.js';
import type { AnalysisPromptHandlers } from './analysis-prompt-handlers.js';
import type { AnalysisPromptStore } from './analysis-prompts.js';
import type { DescribeController } from './describe-controller.js';
import { createFileHandlers } from './file-handlers.js';
import { createGenerationHandlers } from './generation-handlers.js';
import type { Dialogs, HostActions } from './host-actions.js';
import type { IpcHandlers, IpcRequest, IpcResponse } from './ipc.js';
import { createJobHandlers } from './job-handlers.js';
import type { JobHost } from './job-host.js';
import { createLibraryHandlers } from './library-handlers.js';
import { createPromptHandlers } from './prompt-handlers.js';
import type { ProviderHandlers } from './provider-handlers.js';
import type { ProviderStore } from './provider-store.js';
import type { SiteHandlers } from './site-handlers.js';

// The whole handler table: the workspace lifecycle channels here, every other channel from its own module.

/** App-level services the handlers route to; they do not need an open workspace. */
export interface AppServices {
  /** The `providers:*` channels. */
  providers: ProviderHandlers;
  /** The provider entries the analysis channels resolve and the job rows are named from. */
  providerStore: ProviderStore;
  /** The `venice` entries the generation channels and generation jobs run on. */
  imageProviders: ImageProviderDirectory;
  /** The `analysisPrompts:*` channels. */
  analysisPrompts: AnalysisPromptHandlers;
  /** The analysis prompts the analysis channels resolve. */
  prompts: AnalysisPromptStore;
  /** Runs Image2Prompt one request at a time. */
  describe: DescribeController;
  /** The `sites:*` channels. */
  sites: SiteHandlers;
  /** Whether a download lane is the site of a site profile; without it no lane is. */
  isSiteLane?: (host: string) => boolean;
}

/**
 * Builds the handler table for every IPC channel.
 *
 * @param manager the workspace manager
 * @param dialogs the native dialogs
 * @param host the actions only the host can perform
 * @param jobs the job host of the open workspace
 * @param services the app-level services
 * @returns one handler per channel
 */
export function createWorkspaceHandlers(
  manager: WorkspaceManager,
  dialogs: Dialogs,
  host: HostActions,
  jobs: JobHost,
  services: AppServices,
): IpcHandlers {
  const lifecycle = new WorkspaceLifecycle(manager, dialogs, host);
  return {
    'workspace:list': () => manager.list(),
    'workspace:current': async () => manager.current(),
    'workspace:create': (request) => lifecycle.run(() => manager.create(request)),
    'workspace:resolveCreatePath': async (request) => join(request.parentPath, workspaceFolderName(request.name)),
    'workspace:open': (request) => lifecycle.run(() => manager.open(request)),
    'workspace:remove': (request) => lifecycle.remove(request),
    'workspace:close': () => lifecycle.close(),
    ...createFileHandlers({ manager, host, jobs }),
    ...createLibraryHandlers({ manager, dialogs, host }),
    ...createAnalysisHandlers({
      manager,
      jobs,
      describe: services.describe,
      prompts: services.prompts,
      providers: services.providerStore,
    }),
    ...createJobHandlers({
      manager,
      jobs,
      providers: services.providerStore,
      imageProviders: services.imageProviders,
      ...(services.isSiteLane === undefined ? {} : { isSiteLane: services.isSiteLane }),
    }),
    ...createGenerationHandlers(manager, jobs, services.imageProviders),
    ...createPromptHandlers(manager),
    'dialog:pickDirectory': () => dialogs.pickDirectory(),
    'dialog:pickFiles': () => dialogs.pickFiles(),
    // App-level provider entries and analysis prompts: not behind the workspace guard.
    ...services.providers,
    ...services.analysisPrompts,
    // Site profiles and their crawl: app level too; only `sites:import` needs an open workspace.
    ...services.sites,
  };
}

/**
 * The workspace lifecycle channels.
 *
 * The open workspace's jobs stop before the manager may close it, outside `exclusive` (a job may
 * wait for that queue), and start again for whatever workspace is open afterwards, also after a failure.
 * Lifecycle channels run one at a time, so a second one cannot close a workspace whose jobs were just started.
 */
class WorkspaceLifecycle {
  private readonly queue = new SerialQueue();

  /**
   * @param manager the workspace manager
   * @param dialogs asks how to remove a workspace
   * @param host receives the lifecycle notifications
   */
  constructor(
    private readonly manager: WorkspaceManager,
    private readonly dialogs: Dialogs,
    private readonly host: HostActions,
  ) {}

  /**
   * Runs one lifecycle step in the queue, with the notifications around it.
   *
   * @param step the manager call
   * @returns what the step answered
   */
  run<T>(step: () => Promise<T>): Promise<T> {
    return this.queue.run(() => this.withNotifications(step));
  }

  /**
   * Tells the host a workspace is closing, runs the step and tells it when a workspace is open afterwards.
   *
   * @param step the manager call
   * @returns what the step answered
   */
  private async withNotifications<T>(step: () => Promise<T>): Promise<T> {
    await notify(this.host, 'workspaceClosing');
    try {
      return await step();
    } finally {
      if (this.manager.current() !== null) await notify(this.host, 'workspaceOpened');
    }
  }

  /**
   * Removes a workspace after the user chose how.
   *
   * @param request the workspace's id
   * @returns whether it was removed and its folder trashed
   */
  async remove({ id }: IpcRequest<'workspace:remove'>): Promise<IpcResponse<'workspace:remove'>> {
    const workspace = (await this.manager.list()).find((candidate) => candidate.id === id);
    if (!workspace) return { removed: false, folderTrashed: false };
    const choice = await this.dialogs.confirmRemoveWorkspace(workspace);
    if (choice === 'cancel') return { removed: false, folderTrashed: false };
    const remove = () => this.manager.remove({ id, trashFolder: choice === 'forget_and_trash_folder' });
    // Only the open workspace is closed by a remove; a foreign one must not stop the scheduler.
    const { folderTrashed } = await this.queue.run(() =>
      this.manager.current()?.id === id ? this.withNotifications(remove) : remove(),
    );
    return { removed: true, folderTrashed };
  }

  /**
   * Closes the open workspace.
   *
   * @returns null
   */
  async close(): Promise<null> {
    await this.run(() => this.manager.close());
    return null;
  }
}

/**
 * Calls one lifecycle hook. The hooks never reject by contract; a broken one must not fail the channel either.
 *
 * @param host the host
 * @param hook which hook to call
 */
async function notify(host: HostActions, hook: 'workspaceOpened' | 'workspaceClosing'): Promise<void> {
  try {
    await host[hook]();
  } catch (error) {
    console.error(`The ${hook} hook failed`, error);
  }
}
