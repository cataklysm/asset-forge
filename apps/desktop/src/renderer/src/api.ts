import type { IpcChannel, IpcRequest, IpcResponse } from '@assetforge/contracts';

export class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
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
  if (!result.ok) throw new ApiError(result.error.code, result.error.message);
  return result.value;
}

const ERROR_MESSAGES: Record<string, string> = {
  directory_not_empty: 'The folder is not empty. Choose an empty folder for a new workspace.',
  workspace_not_found: 'No workspace was found in this folder.',
  storage_unreachable:
    'The folder cannot be reached. Check that the drive or network share is available.',
  unsupported_format_version: 'This workspace was created by a newer version of AssetForge.',
  workspace_mismatch: 'The local database does not belong to this workspace.',
  storage_access_denied: 'AssetForge has no permission to write to this folder.',
  storage_full: 'There is not enough free space in this folder.',
};

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return ERROR_MESSAGES[error.code] ?? error.message;
  return error instanceof Error ? error.message : 'Unexpected error';
}
