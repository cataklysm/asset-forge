import { StorageAccessDeniedError, StorageFullError } from '@assetforge/core';

export function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

const ACCESS_DENIED_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

/**
 * Maps permission and disk-full failures to domain errors that the UI can explain.
 * Node's own messages contain absolute paths, so the message names only the relative
 * path; the original error stays available as `cause`. Everything else is returned as is.
 */
export function translateFsError(err: unknown, relPath: string): unknown {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const target = relPath === '' ? 'the workspace folder' : relPath;
  if (code !== undefined && ACCESS_DENIED_CODES.has(code)) {
    return new StorageAccessDeniedError(`No permission to access ${target}`, { cause: err });
  }
  if (code === 'ENOSPC') {
    return new StorageFullError(`Not enough free space to write ${target}`, { cause: err });
  }
  return err;
}
