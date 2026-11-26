import type { ImportResult } from '@assetforge/contracts';
import { ArchiveTooLargeError, ValidationFailedError } from './errors.js';
import { importStream, REFUSED_IMPORT_MESSAGE, safeErrorMessage, type ImportContext } from './import-file.js';
import { isRefusedImport, isZipArchive } from './media-types.js';
import type { ArchiveEntry, ArchiveReader } from './ports.js';

/** At most this many entries (directories included) per `files:import` call, over all its archives. */
export const MAX_ARCHIVE_ENTRIES = 5000;
/** At most this many declared uncompressed bytes per `files:import` call, over all its archives. */
export const MAX_ARCHIVE_BYTES = 20 * 1024 ** 3;

export const ARCHIVE_EMPTY_MESSAGE: string = new ValidationFailedError('This archive contains no files').message;
export const ARCHIVE_ENTRY_REFUSED_MESSAGE: string = new ValidationFailedError('This archive entry cannot be imported').message;
export const ARCHIVE_TRUNCATED_MESSAGE: string = new ValidationFailedError('This archive could not be read to the end').message;

/** What the current call may still unpack; `importArchive` subtracts every archive it unpacks. */
export interface ArchiveBudget {
  entries: number;
  bytes: number;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** Directory entries and macOS resource-fork clutter give no result at all. */
function isSkipped(entry: ArchiveEntry): boolean {
  return entry.isDirectory || entry.name.replace(/\\/g, '/').startsWith('__MACOSX/');
}

/** The message refusing an entry, or null when it is imported. */
function refusal(entry: ArchiveEntry, fileName: string): string | null {
  if (entry.isSymlink || entry.isUnsupported || fileName === '' || CONTROL_CHARACTER.test(fileName)) {
    return ARCHIVE_ENTRY_REFUSED_MESSAGE;
  }
  if (isRefusedImport(fileName) || isZipArchive(fileName)) return REFUSED_IMPORT_MESSAGE;
  return null;
}

/**
 * Unpacks the archive at `sourcePath`: every entry is imported flat under the last segment of
 * its path, in directory order. The limits are checked from the directory before anything is
 * written. `onImported` runs for each result with a complete file before the next entry starts.
 * Never rejects; failures are results.
 */
export async function importArchive(
  ctx: ImportContext & { archives: ArchiveReader },
  sourcePath: string,
  budget: ArchiveBudget,
  onImported: (result: ImportResult) => Promise<void>,
): Promise<ImportResult[]> {
  const failed = (error: string): ImportResult[] => [{ sourcePath, entryName: null, file: null, error, duplicateOf: [] }];

  let archive;
  try {
    archive = await ctx.archives.open(sourcePath, { maxEntries: budget.entries });
  } catch (error) {
    return failed(safeErrorMessage(error, 'Import failed'));
  }

  try {
    const { entries } = archive;
    const bytes = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
    if (entries.length > budget.entries || bytes > budget.bytes) return failed(new ArchiveTooLargeError().message);
    budget.entries -= entries.length;
    budget.bytes -= bytes;

    const results: ImportResult[] = [];
    let truncated = false;
    for (const [index, entry] of entries.entries()) {
      if (isSkipped(entry)) continue;
      const entryName = entry.name;
      const result = (error: string): ImportResult => ({ sourcePath, entryName, file: null, error, duplicateOf: [] });
      if (truncated) {
        results.push(result(ARCHIVE_TRUNCATED_MESSAGE));
        continue;
      }
      const fileName = entryName.split(/[\\/]/).pop() ?? '';
      const refused = refusal(entry, fileName);
      if (refused !== null) {
        results.push(result(refused));
        continue;
      }
      let stream;
      try {
        stream = await archive.openEntry(index);
      } catch {
        truncated = true;
        results.push(result(ARCHIVE_TRUNCATED_MESSAGE));
        continue;
      }
      const imported = await importStream(ctx, { sourcePath, entryName, name: fileName, stream });
      if (imported.file?.status === 'complete') await onImported(imported);
      results.push(imported);
    }
    return results.length === 0 ? failed(ARCHIVE_EMPTY_MESSAGE) : results;
  } finally {
    try {
      await archive.close();
    } catch {
      // Every result is already decided; a failing close changes none of them.
    }
  }
}
