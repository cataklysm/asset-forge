import type { ErrorCode, IpcChannel, IpcRequest, IpcResponse } from '@assetforge/contracts';

export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

const unreachableListeners = new Set<() => void>();

/** Subscribes to every call that fails with `storage_unreachable`; returns the unsubscribe function. */
export function onStorageUnreachable(listener: () => void): () => void {
  unreachableListeners.add(listener);
  return () => {
    unreachableListeners.delete(listener);
  };
}

/** Calls an IPC channel, unwrapping the result: failures (including a rejected invoke) throw `ApiError`. */
export async function call<C extends IpcChannel>(
  channel: C,
  request: IpcRequest<C>,
): Promise<IpcResponse<C>> {
  let result;
  try {
    result = await window.assetForge.invoke(channel, request);
  } catch {
    throw new ApiError('internal_error', 'The application did not respond');
  }
  if (!result.ok) {
    if (result.error.code === 'storage_unreachable') for (const listener of [...unreachableListeners]) listener();
    throw new ApiError(result.error.code, result.error.message);
  }
  return result.value;
}

const ERROR_MESSAGES: Partial<Record<ErrorCode, string>> = {
  not_found: 'This item no longer exists.',
  directory_not_empty: 'The folder is not empty. Choose an empty folder for a new workspace.',
  workspace_not_found: 'No workspace was found in this folder.',
  storage_unreachable:
    'The folder cannot be reached. Check that the drive or network share is available.',
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

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return ERROR_MESSAGES[error.code] ?? error.message;
  return error instanceof Error ? error.message : 'Unexpected error';
}
