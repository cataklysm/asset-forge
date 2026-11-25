import { STAGING_DIR, stagingPath } from './paths.js';
import type { FileRepository, Storage } from './ports.js';

export const INTERRUPTED_IMPORT_MESSAGE = 'Import was interrupted';

/**
 * Startup recovery: every pending row is an interrupted import. Its staging and
 * inbox files are removed and the row is marked failed. Remaining staging entries
 * are orphans and are removed too. Complete rows are never touched.
 */
export async function recoverIncompleteImports(ctx: {
  storage: Storage;
  files: FileRepository;
}): Promise<{ failedIds: string[]; removedStagingFiles: string[] }> {
  const failedIds: string[] = [];
  const removedStagingFiles: string[] = [];

  for (const row of await ctx.files.listByStatus('pending')) {
    const staging = stagingPath(row.id);
    if (await ctx.storage.exists(staging)) removedStagingFiles.push(staging);
    await ctx.storage.remove(staging);
    await ctx.storage.remove(row.relativePath);
    await ctx.files.markFailed(row.id, INTERRUPTED_IMPORT_MESSAGE);
    failedIds.push(row.id);
  }

  for (const entry of await ctx.storage.list(STAGING_DIR)) {
    const path = `${STAGING_DIR}/${entry}`;
    await ctx.storage.remove(path);
    removedStagingFiles.push(path);
  }

  return { failedIds, removedStagingFiles };
}
