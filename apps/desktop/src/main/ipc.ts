import {
  type ErrorCode,
  ipcContract,
  type IpcChannel,
  type IpcResult,
  type WorkspaceSummary,
} from '@assetforge/contracts';
import { join } from 'node:path';
import { AssetForgeError, workspaceFolderName, type WorkspaceManager } from '@assetforge/core';
import type { z } from 'zod';

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
}

export type RemoveChoice = 'cancel' | 'forget' | 'forget_and_trash_folder';

export function createWorkspaceHandlers(manager: WorkspaceManager, dialogs: Dialogs): IpcHandlers {
  return {
    'workspace:list': () => manager.list(),
    'workspace:current': async () => manager.current(),
    'workspace:create': (request) => manager.create(request),
    'workspace:resolveCreatePath': async (request) =>
      join(request.parentPath, workspaceFolderName(request.name)),
    'workspace:open': (request) => manager.open(request),
    'workspace:remove': async ({ id }) => {
      const workspace = (await manager.list()).find((w) => w.id === id);
      if (!workspace) return { removed: false, folderTrashed: false };
      const choice = await dialogs.confirmRemoveWorkspace(workspace);
      if (choice === 'cancel') return { removed: false, folderTrashed: false };
      const { folderTrashed } = await manager.remove({
        id,
        trashFolder: choice === 'forget_and_trash_folder',
      });
      return { removed: true, folderTrashed };
    },
    'workspace:close': async () => {
      await manager.close();
      return null;
    },
    'files:import': (request) => manager.importFiles(request.sourcePaths),
    'files:list': (request) => manager.listFiles({ ...request, scope: { kind: 'all' } }),
    'dialog:pickDirectory': () => dialogs.pickDirectory(),
    'dialog:pickFiles': () => dialogs.pickFiles(),
  };
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
    if (error instanceof AssetForgeError) {
      return failure(error.code, error.message);
    }
    console.error(`IPC handler for ${channel} failed`, error);
    return internalError();
  }
}

function failure(code: ErrorCode, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } };
}

function internalError(): IpcResult<never> {
  return failure('internal_error', 'Unexpected error');
}
