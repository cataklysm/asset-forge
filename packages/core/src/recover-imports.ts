import { STAGING_DIR, stagingPath } from './paths.js';
import type { FileRepository } from './ports/file-repositories.js';
import type { Storage } from './ports/storage.js';

export const INTERRUPTED_IMPORT_MESSAGE = 'Import was interrupted';

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
 */
export async function recoverIncompleteImports(ctx: {
  storage: Storage;
  files: FileRepository;
}): Promise<RecoveryResult> {
  const result: RecoveryResult = { failedIds: [], discardedIds: [], removedStagingFiles: [], skippedPaths: [] };

  let rows;
  let downloads: Set<string>;
  try {
    rows = await ctx.files.listByStatus('pending');
    // Without this list a download row could be failed and left in the inbox; leave every row for the next open.
    downloads = new Set(await ctx.files.listPendingDownloadIds());
  } catch {
    return result;
  }

  for (const row of rows) {
    const staging = stagingPath(row.id);
    let current = staging;
    try {
      const stagingExisted = await ctx.storage.exists(staging);
      await ctx.storage.remove(staging);
      if (stagingExisted) result.removedStagingFiles.push(staging);
      current = row.relativePath;
      await ctx.storage.remove(row.relativePath);
    } catch {
      result.skippedPaths.push(current);
      continue;
    }
    try {
      if (downloads.has(row.id)) {
        if (await ctx.files.deletePending(row.id)) result.discardedIds.push(row.id);
      } else {
        await ctx.files.markFailed(row.id, INTERRUPTED_IMPORT_MESSAGE);
        result.failedIds.push(row.id);
      }
    } catch {
      // The row stays pending and is retried on the next open.
    }
  }

  let entries: string[];
  try {
    entries = await ctx.storage.list(STAGING_DIR);
  } catch {
    return result;
  }
  for (const entry of entries) {
    const path = `${STAGING_DIR}/${entry}`;
    try {
      await ctx.storage.remove(path);
      result.removedStagingFiles.push(path);
    } catch {
      result.skippedPaths.push(path);
    }
  }

  return result;
}
