import type { FileTarget, ImportProgress, ImportResult } from '@assetforge/contracts';
import { relocateFile } from './asset-files.js';
import { NotFoundError } from './errors.js';
import { importArchive, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_ENTRIES, type ArchiveBudget } from './import-archive.js';
import { importFile, safeErrorMessage, type ImportContext } from './import-file.js';
import { isZipArchive } from './media-types.js';
import type { ArchiveReader } from './ports/source-files.js';
import type { WorkspaceHost } from './ports/workspace-host.js';
import type { WorkspaceSession } from './session.js';

export async function importSources(
  host: WorkspaceHost,
  session: WorkspaceSession,
  sourcePaths: string[],
  target: FileTarget | null,
  options: { unpackArchives?: boolean },
  setProgress: (progress: ImportProgress | null) => void,
): Promise<ImportResult[]> {
  if (target !== null && (await session.database.assets.get(target.assetId)) === null) {
    throw new NotFoundError(`Asset ${target.assetId} does not exist`);
  }
  const ctx: ImportContext & { archives: ArchiveReader } = {
    storage: session.storage,
    storageId: session.storageId,
    files: session.database.files,
    sources: host.sources,
    archives: host.archives,
    probe: host.imageProbe,
    newId: session.newId,
    now: session.now,
  };
  const place = async (result: ImportResult): Promise<void> => {
    if (target === null || result.file?.status !== 'complete') return;
    try {
      result.file = await relocateFile(session, result.file.id, target);
    } catch (error) {
      // The file stays in the inbox; the result reports why it was not placed.
      result.error = safeErrorMessage(error, 'Placing the file failed');
    }
  };
  const budget: ArchiveBudget = { entries: MAX_ARCHIVE_ENTRIES, bytes: MAX_ARCHIVE_BYTES };
  const progress: ImportProgress = { done: 0, total: sourcePaths.length, currentBytes: 0, currentSize: null, cancelling: false };
  const startItem = (size: number | null): void => {
    progress.currentBytes = 0;
    progress.currentSize = size;
  };
  const onProgress = (bytesWritten: number): void => {
    progress.currentBytes = bytesWritten;
  };
  // The finished item's bytes never outlive its count, so `done + fraction` never exceeds `total`.
  const finishItem = (): void => {
    progress.done += 1;
    startItem(null);
  };
  setProgress(progress);
  try {
    const results: ImportResult[] = [];
    for (const sourcePath of sourcePaths) {
      if (progress.cancelling) break;
      startItem(null);
      const sourceName = sourcePath.split(/[\\/]/).pop() ?? '';
      if (options.unpackArchives === true && isZipArchive(sourceName)) {
        // Until its directory is read the archive is one item; then each entry with a result is one.
        let expanded = false;
        const archiveResults = await importArchive(ctx, sourcePath, budget, place, {
          onEntries: (count) => {
            expanded = true;
            progress.total += count - 1;
          },
          isCancelled: () => progress.cancelling,
          onEntryStart: (declaredSize) => startItem(declaredSize),
          onProgress,
          onEntryDone: finishItem,
        });
        if (!expanded) finishItem();
        results.push(...archiveResults);
        continue;
      }
      const result = await importFile(ctx, sourcePath, {
        onSize: (sizeBytes) => {
          progress.currentSize = sizeBytes;
        },
        onProgress,
      });
      await place(result);
      results.push(result);
      finishItem();
    }
    return results;
  } finally {
    setProgress(null);
  }
}
