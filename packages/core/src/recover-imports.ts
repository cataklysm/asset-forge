import { STAGING_DIR, stagingPath } from './paths.js';
import type { FileRepository, Storage } from './ports.js';

export const INTERRUPTED_IMPORT_MESSAGE = 'Import was interrupted';

export interface RecoveryResult {
  failedIds: string[];
  removedStagingFiles: string[];
  /** Paths that could not be removed; their rows stay pending and are retried on the next open. */
  skippedPaths: string[];
}

/**
 * Startup recovery: every pending row is an interrupted import. Its staging and
 * inbox files are removed and the row is marked failed. Remaining staging entries
 * are orphans and are removed too. Complete rows are never touched.
 *
 * Recovery is housekeeping and best-effort: it never rejects because of a single
 * row or entry. Anything it cannot clean up is retried on the next open.
 */
export async function recoverIncompleteImports(ctx: {
  storage: Storage;
  files: FileRepository;
}): Promise<RecoveryResult> {
  const result: RecoveryResult = { failedIds: [], removedStagingFiles: [], skippedPaths: [] };

  let rows;
  try {
    rows = await ctx.files.listByStatus('pending');
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
      await ctx.files.markFailed(row.id, INTERRUPTED_IMPORT_MESSAGE);
      result.failedIds.push(row.id);
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
