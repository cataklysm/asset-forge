import { type ErrorCode, ipcContract, type IpcChannel, type IpcError, type IpcResult } from '@assetforge/contracts';
import { AssetForgeError } from '@assetforge/core';
import type { z } from 'zod';

// The IPC boundary: the handler table's type, and the validation of every request and answer that crosses it.
// Kept free of Electron imports so the routing and validation logic is unit-testable.

/** The request of a channel, as its contract parses it. */
export type IpcRequest<C extends IpcChannel> = z.infer<(typeof ipcContract)[C]['request']>;

/** The answer of a channel, as its contract parses it. */
export type IpcResponse<C extends IpcChannel> = z.infer<(typeof ipcContract)[C]['response']>;

/** One handler per channel of the contract. */
export type IpcHandlers = {
  [C in keyof typeof ipcContract]: (request: IpcRequest<C>) => Promise<IpcResponse<C>>;
};

/**
 * Whether a channel name is one of the contract.
 *
 * @param channel the name the renderer sent
 * @returns true for a known channel
 */
export function isIpcChannel(channel: string): channel is IpcChannel {
  return Object.hasOwn(ipcContract, channel);
}

/**
 * Validates the request, runs the handler and validates its response, so nothing
 * unvalidated crosses the IPC boundary in either direction. Unexpected errors are
 * logged here and reach the renderer only as a generic `internal_error`.
 *
 * @param handlers the handler table
 * @param channel the channel the renderer named
 * @param rawRequest the request as it arrived
 * @returns the validated answer or the error the renderer sees
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
 *
 * @param error what the handler threw
 * @param channel the channel, named in the log line
 * @returns the error to send
 */
export function toIpcError(error: unknown, channel?: string): IpcError {
  if (error instanceof AssetForgeError) {
    return { code: error.code, message: error.message };
  }
  console.error(channel === undefined ? 'IPC handler failed' : `IPC handler for ${channel} failed`, error);
  return { code: 'internal_error', message: 'Unexpected error' };
}

/**
 * A failed result.
 *
 * @param code the error code
 * @param message the fixed message
 * @returns the result
 */
function failure(code: ErrorCode, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } };
}

/**
 * The result of an unexpected error.
 *
 * @returns the generic `internal_error`
 */
function internalError(): IpcResult<never> {
  return failure('internal_error', 'Unexpected error');
}
