import { StorageUnreachableError } from './errors.js';
import type { Storage } from './ports/storage.js';

/** The fixed message when the storage of an open workspace cannot be reached. */
export const WORKSPACE_STORAGE_UNREACHABLE_MESSAGE = 'The storage of this workspace is not reachable';

/**
 * Refuses while the storage of an open workspace cannot be reached, so a dropped share is never taken for a missing
 * file.
 *
 * @param storage the storage of the open workspace
 * @returns resolves when the storage is reachable
 * @throws StorageUnreachableError otherwise
 */
export async function requireReachableStorage(storage: Storage): Promise<void> {
  if (!(await storage.isReachable())) throw new StorageUnreachableError(WORKSPACE_STORAGE_UNREACHABLE_MESSAGE);
}
