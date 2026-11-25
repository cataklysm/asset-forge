import { ipcContract, type IpcChannel, type IpcResult } from '@assetforge/contracts';
import { AssetForgeError, type WorkspaceManager } from '@assetforge/core';
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
}

export function createWorkspaceHandlers(manager: WorkspaceManager, dialogs: Dialogs): IpcHandlers {
  return {
    'workspace:list': () => manager.list(),
    'workspace:current': async () => manager.current(),
    'workspace:create': (request) => manager.create(request),
    'workspace:open': (request) => manager.open(request),
    'workspace:close': async () => {
      await manager.close();
      return null;
    },
    'files:import': (request) => manager.importFiles(request.sourcePaths),
    'files:list': (request) => manager.listFiles(request),
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

function failure(code: string, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } };
}

function internalError(): IpcResult<never> {
  return failure('internal_error', 'Unexpected error');
}
