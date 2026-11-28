import type { ErrorCode, IpcChannel, IpcRequest, IpcResponse } from '@assetforge/contracts';

/** A failed IPC call, carrying the error code and message the main process forwarded. */
export class ApiError extends Error {
  /** The error code of the failed call. */
  readonly code: ErrorCode;

  /**
   * @param code the error code of the failed call
   * @param message the forwarded message, safe to show
   */
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

/** The listeners told about every call that fails with `storage_unreachable`. */
const unreachableListeners = new Set<() => void>();

/**
 * Subscribes to every call that fails with `storage_unreachable`.
 *
 * @param listener called once per such failure
 * @returns the unsubscribe function
 */
export function onStorageUnreachable(listener: () => void): () => void {
  unreachableListeners.add(listener);
  return () => {
    unreachableListeners.delete(listener);
  };
}

/** How `call` treats a failure. */
export interface CallOptions {
  /**
   * False keeps a `storage_unreachable` failure from the `onStorageUnreachable` listeners, for a call
   * repeated in the background whose failure must not raise the storage banner again; default true.
   */
  reportUnreachable?: boolean;
}

/**
 * Calls an IPC channel, unwrapping the result: failures (including a rejected invoke) throw `ApiError`.
 *
 * @param channel the IPC channel
 * @param request the channel's request
 * @param options whether a `storage_unreachable` failure is reported to the listeners
 * @returns resolves to the channel's answer
 * @throws ApiError with the forwarded code, or `internal_error` when the invoke itself failed
 */
export async function call<C extends IpcChannel>(
  channel: C,
  request: IpcRequest<C>,
  options: CallOptions = {},
): Promise<IpcResponse<C>> {
  let result;
  try {
    result = await window.assetForge.invoke(channel, request);
  } catch {
    throw new ApiError('internal_error', 'The application did not respond');
  }
  if (!result.ok) {
    const report = result.error.code === 'storage_unreachable' && options.reportUnreachable !== false;
    if (report) for (const listener of [...unreachableListeners]) listener();
    throw new ApiError(result.error.code, result.error.message);
  }
  return result.value;
}

/** The texts shown in place of the forwarded message for these codes. */
const ERROR_MESSAGES: Partial<Record<ErrorCode, string>> = {
  not_found: 'This item no longer exists.',
  directory_not_empty: 'The folder is not empty. Choose an empty folder for a new workspace.',
  workspace_not_found: 'No workspace was found in this folder.',
  storage_unreachable: 'The folder cannot be reached. Check that the drive or network share is available.',
  validation_failed: 'This action is not possible for this file.',
  unsupported_format_version: 'This workspace was created by a newer version of AssetForge.',
  workspace_mismatch: 'The local database does not belong to this workspace.',
  workspace_duplicate:
    'This folder is a copy of a workspace that still exists in its original location. Open the original, or remove it before opening the copy.',
  storage_access_denied: 'AssetForge has no permission to write to this folder.',
  storage_full: 'There is not enough free space in this folder.',
  trash_failed:
    'The folder could not be moved to the trash, so nothing was removed. Close programs that use it and try again.',
};

/**
 * The text to show for a failure.
 *
 * @param error whatever was thrown
 * @returns the fixed text of its code, else its message, else 'Unexpected error'
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return ERROR_MESSAGES[error.code] ?? error.message;
  return error instanceof Error ? error.message : 'Unexpected error';
}

/**
 * A message of a failed call: fixed main-process messages as sent, anything else described.
 *
 * @param error the failure
 * @returns the forwarded message unless the code is `internal_error`, else what `describeError` puts
 */
export function messageOf(error: unknown): string {
  return error instanceof ApiError && error.code !== 'internal_error' ? error.message : describeError(error);
}
