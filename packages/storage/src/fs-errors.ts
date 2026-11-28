import { StorageAccessDeniedError, StorageFullError } from '@assetforge/core';

/** The codes of a permission failure. */
const ACCESS_DENIED_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

/**
 * Whether a file-system failure means the entry does not exist.
 *
 * @param error what the call threw
 * @returns true for `ENOENT` and `ENOTDIR`
 */
export function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Maps permission and disk-full failures to domain errors that the UI can explain.
 * Node's own messages contain absolute paths, so the message names only the relative
 * path; the original error stays available as `cause`. Everything else is returned as is.
 *
 * @param error what the call threw
 * @param relativePath the workspace path the call was about; empty for the workspace folder
 * @returns the domain error, or `error` itself
 */
export function translateFsError(error: unknown, relativePath: string): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const target = relativePath === '' ? 'the workspace folder' : relativePath;
  if (code !== undefined && ACCESS_DENIED_CODES.has(code)) {
    return new StorageAccessDeniedError(`No permission to access ${target}`, { cause: error });
  }
  if (code === 'ENOSPC') {
    return new StorageFullError(`Not enough free space to write ${target}`, { cause: error });
  }
  return error;
}
