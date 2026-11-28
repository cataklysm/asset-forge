import type { FileRecord } from '@assetforge/contracts';
import { STAGING_DIR, stagingPath } from './paths.js';
import type { FileRepository } from './ports/file-repositories.js';
import type { Storage } from './ports/storage.js';

/** The error stored on a pending row that recovery marks failed. */
export const INTERRUPTED_IMPORT_MESSAGE = 'Import was interrupted';

/** What the recovery of imports reads and writes. */
export interface ImportRecoveryDependencies {
  storage: Storage;
  files: FileRepository;
}

/** What the recovery of imports did. */
export interface RecoveryResult {
  failedIds: string[];
  /** Pending download rows (rows with an origin) that were deleted instead of failed; their requeued jobs download again. */
  discardedIds: string[];
  removedStagingFiles: string[];
  /** Paths that could not be removed; their rows stay pending and are retried on the next open. */
  skippedPaths: string[];
}

/**
 * Startup recovery: every pending row is an interrupted import. Its staging and
 * inbox files are removed and the row is marked failed — or, for a download (a row
 * carrying an origin), deleted, since a download leaves no file row unless it is
 * complete. Remaining staging entries are orphans and are removed too. Complete rows
 * are never touched.
 *
 * Recovery is housekeeping and best-effort: it never rejects because of a single
 * row or entry. Anything it cannot clean up is retried on the next open.
 *
 * @param dependencies the storage and the files of the workspace
 * @returns what was failed, discarded, removed and skipped
 */
export async function recoverIncompleteImports(dependencies: ImportRecoveryDependencies): Promise<RecoveryResult> {
  const result: RecoveryResult = { failedIds: [], discardedIds: [], removedStagingFiles: [], skippedPaths: [] };

  let rows;
  let downloads: Set<string>;
  try {
    rows = await dependencies.files.listByStatus('pending');
    // Without this list a download row could be failed and left in the inbox; leave every row for the next open.
    downloads = new Set(await dependencies.files.listPendingDownloadIds());
  } catch {
    return result;
  }

  for (const row of rows) await recoverPendingRow(dependencies, row, downloads, result);
  await removeOrphanedStaging(dependencies, result);
  return result;
}

/**
 * Removes the staging and inbox files of one pending row, then deletes the row (a download) or marks it failed.
 *
 * @param dependencies the storage and the files of the workspace
 * @param row the pending row
 * @param downloads the ids of the pending download rows
 * @param result collects what was done
 * @returns resolves once done; never rejects
 */
async function recoverPendingRow(
  dependencies: ImportRecoveryDependencies,
  row: FileRecord,
  downloads: Set<string>,
  result: RecoveryResult,
): Promise<void> {
  const staging = stagingPath(row.id);
  let current = staging;
  try {
    const hadStaging = await dependencies.storage.exists(staging);
    await dependencies.storage.remove(staging);
    if (hadStaging) result.removedStagingFiles.push(staging);
    current = row.relativePath;
    await dependencies.storage.remove(row.relativePath);
  } catch {
    result.skippedPaths.push(current);
    return;
  }
  try {
    if (downloads.has(row.id)) {
      if (await dependencies.files.deletePending(row.id)) result.discardedIds.push(row.id);
    } else {
      await dependencies.files.markFailed(row.id, INTERRUPTED_IMPORT_MESSAGE);
      result.failedIds.push(row.id);
    }
  } catch {
    // The row stays pending and is retried on the next open.
  }
}

/**
 * Removes every entry left in the staging directory: an orphan of no pending row.
 *
 * @param dependencies the storage and the files of the workspace
 * @param result collects the removed and skipped paths
 * @returns resolves once done; never rejects
 */
async function removeOrphanedStaging(dependencies: ImportRecoveryDependencies, result: RecoveryResult): Promise<void> {
  let entries: string[];
  try {
    entries = await dependencies.storage.list(STAGING_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = `${STAGING_DIR}/${entry}`;
    try {
      await dependencies.storage.remove(path);
      result.removedStagingFiles.push(path);
    } catch {
      result.skippedPaths.push(path);
    }
  }
}
