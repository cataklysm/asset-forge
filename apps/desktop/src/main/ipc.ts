import {
  type ErrorCode,
  ipcContract,
  type IpcChannel,
  type IpcError,
  type IpcResult,
  type WorkspaceSummary,
} from '@assetforge/contracts';
import { join } from 'node:path';
import {
  AssetForgeError,
  SerialQueue,
  workspaceFolderName,
  type WorkspaceManager,
} from '@assetforge/core';
import type { z } from 'zod';
import type { DescribeController } from './describe-controller.js';
import { createJobHandlers } from './job-handlers.js';
import type { JobHost } from './job-host.js';
import { createLibraryHandlers } from './library-handlers.js';
import type { SettingsHandlers } from './settings-handlers.js';

// Kept free of Electron imports so the routing and validation logic is unit-testable.

export type IpcHandlers = {
  [C in keyof typeof ipcContract]: (
    request: z.infer<(typeof ipcContract)[C]['request']>,
  ) => Promise<z.infer<(typeof ipcContract)[C]['response']>>;
};

export interface Dialogs {
  pickDirectory(): Promise<string | null>;
  pickFiles(): Promise<string[]>;
  /** Asks the user how to remove a workspace; the renderer cannot answer this itself. */
  confirmRemoveWorkspace(workspace: WorkspaceSummary): Promise<RemoveChoice>;
  /** Asks whether the workflow of an asset may be removed. */
  confirmRemoveWorkflow(assetName: string): Promise<boolean>;
}

/** Actions only the host (Electron) can perform. */
export interface HostActions {
  /** Electron shell.openPath: resolves '' on success, an error text otherwise. */
  openPath(absolutePath: string): Promise<string>;
  showItemInFolder(absolutePath: string): void;
  /** Called after a workspace lifecycle channel when a workspace is open afterwards. Never rejects. */
  workspaceOpened(): Promise<void>;
  /** Called before a workspace lifecycle channel calls the manager. Never rejects. */
  workspaceClosing(): Promise<void>;
}

export type RemoveChoice = 'cancel' | 'forget' | 'forget_and_trash_folder';

/** App-level services the handlers route to; they do not need an open workspace. */
export interface AppServices {
  settings: SettingsHandlers;
  describe: DescribeController;
}

export function createWorkspaceHandlers(
  manager: WorkspaceManager,
  dialogs: Dialogs,
  host: HostActions,
  jobs: JobHost,
  services: AppServices,
): IpcHandlers {
  // The open workspace's jobs stop before the manager may close it, outside `exclusive` (a job may
  // wait for that queue), and start again for whatever workspace is open afterwards, also after a failure.
  // Lifecycle channels run one at a time, so a second one cannot close a workspace whose jobs were just started.
  const lifecycleQueue = new SerialQueue();
  const lifecycle = <T>(fn: () => Promise<T>): Promise<T> =>
    lifecycleQueue.run(async () => {
      await notify(host, 'workspaceClosing');
      try {
        return await fn();
      } finally {
        if (manager.current() !== null) await notify(host, 'workspaceOpened');
      }
    });

  return {
    'workspace:list': () => manager.list(),
    'workspace:current': async () => manager.current(),
    'workspace:create': (request) => lifecycle(() => manager.create(request)),
    'workspace:resolveCreatePath': async (request) =>
      join(request.parentPath, workspaceFolderName(request.name)),
    'workspace:open': (request) => lifecycle(() => manager.open(request)),
    'workspace:remove': async ({ id }) => {
      const workspace = (await manager.list()).find((w) => w.id === id);
      if (!workspace) return { removed: false, folderTrashed: false };
      const choice = await dialogs.confirmRemoveWorkspace(workspace);
      if (choice === 'cancel') return { removed: false, folderTrashed: false };
      const { folderTrashed } = await lifecycle(() =>
        manager.remove({ id, trashFolder: choice === 'forget_and_trash_folder' }),
      );
      return { removed: true, folderTrashed };
    },
    'workspace:close': async () => {
      await lifecycle(() => manager.close());
      return null;
    },
    ...createLibraryHandlers(manager, dialogs, host),
    ...createJobHandlers(manager, jobs, services.describe),
    'dialog:pickDirectory': () => dialogs.pickDirectory(),
    'dialog:pickFiles': () => dialogs.pickFiles(),
    // App-level settings: not behind the workspace guard.
    ...services.settings,
  };
}

/** The hooks never reject by contract; a broken one must not fail the channel either. */
async function notify(host: HostActions, hook: 'workspaceOpened' | 'workspaceClosing'): Promise<void> {
  try {
    await host[hook]();
  } catch (error) {
    console.error(`The ${hook} hook failed`, error);
  }
}

export function isIpcChannel(channel: string): channel is IpcChannel {
  return Object.hasOwn(ipcContract, channel);
}

/**
 * Validates the request, runs the handler and validates its response, so nothing
 * unvalidated crosses the IPC boundary in either direction. Unexpected errors are
 * logged here and reach the renderer only as a generic `internal_error`.
 */
export async function dispatch(
  handlers: IpcHandlers,
  channel: string,
  rawRequest: unknown,
): Promise<IpcResult<unknown>> {
  if (!isIpcChannel(channel)) {
    return failure('unknown_channel', 'Unknown IPC channel');
  }
  const contract = ipcContract[channel];
  const request = contract.request.safeParse(rawRequest);
  if (!request.success) {
    return failure('invalid_request', 'Request does not match the IPC contract');
  }
  try {
    const handler = handlers[channel] as (request: unknown) => Promise<unknown>;
    const raw = await handler(request.data);
    const response = contract.response.safeParse(raw);
    if (!response.success) {
      console.error(`IPC response for ${channel} violates the contract`, response.error);
      return internalError();
    }
    return { ok: true, value: response.data };
  } catch (error) {
    return { ok: false, error: toIpcError(error, channel) };
  }
}

/**
 * The error the renderer sees: a domain error keeps its code and message; anything else is
 * logged here and becomes a generic `internal_error`, so cause messages and paths stay in main.
 */
export function toIpcError(error: unknown, channel?: string): IpcError {
  if (error instanceof AssetForgeError) {
    return { code: error.code, message: error.message };
  }
  console.error(channel === undefined ? 'IPC handler failed' : `IPC handler for ${channel} failed`, error);
  return { code: 'internal_error', message: 'Unexpected error' };
}

function failure(code: ErrorCode, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } };
}

function internalError(): IpcResult<never> {
  return failure('internal_error', 'Unexpected error');
}
