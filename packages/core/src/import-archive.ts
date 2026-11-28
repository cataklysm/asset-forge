import type { ImportResult } from '@assetforge/contracts';
import { ArchiveTooLargeError, safeErrorMessage, ValidationFailedError } from './errors.js';
import { lastPathSegment } from './file-names.js';
import { importStream, type ImportContext, type ImportOptions } from './import-file.js';
import { logImportFailure } from './import-log.js';
import { isRefusedImportName, isZipArchive, REFUSED_IMPORT_MESSAGE } from './import-refusals.js';
import type { ArchiveEntry, ArchiveReader, OpenArchive } from './ports/source-files.js';

/** At most this many entries (directories included) per `files:import` call, over all its archives. */
export const MAX_ARCHIVE_ENTRIES = 5000;
/** At most this many declared uncompressed bytes per `files:import` call, over all its archives. */
export const MAX_ARCHIVE_BYTES = 20 * 1024 ** 3;
/** An entry whose file name (last path segment) is longer than this many characters is refused. */
export const MAX_ARCHIVE_ENTRY_NAME_LENGTH = 255;

/** The result of an archive without a single file entry. */
export const ARCHIVE_EMPTY_MESSAGE: string = new ValidationFailedError('This archive contains no files').message;
/** The result of an entry that is a symlink, unsupported, or has an unusable name. */
export const ARCHIVE_ENTRY_REFUSED_MESSAGE: string = new ValidationFailedError('This archive entry cannot be imported')
  .message;
/** The result of an entry that could not be opened. */
export const ARCHIVE_TRUNCATED_MESSAGE: string = new ValidationFailedError('This archive could not be read to the end')
  .message;

/** What the current call may still unpack; `importArchive` subtracts every archive it unpacks. */
export interface ArchiveBudget {
  entries: number;
  bytes: number;
}

/** Observers and the cancel check of `importArchive`, for the progress of a running import. */
export interface ArchiveImportHooks {
  /**
   * Once the directory has passed the limits: how many entries give a result (directories and `__MACOSX/` do not).
   *
   * @param count the number of entries that give a result
   */
  onEntries?(count: number): void;
  /**
   * Checked before every entry; once true, no further entry is started and the remaining ones give no result.
   *
   * @returns whether the import is cancelled
   */
  isCancelled?(): boolean;
  /**
   * An entry starts, with its declared uncompressed size.
   *
   * @param declaredSize the declared uncompressed size in bytes
   */
  onEntryStart?(declaredSize: number): void;
  /**
   * The cumulative number of bytes of the current entry written to staging.
   *
   * @param bytesWritten the bytes written so far
   */
  onProgress?(bytesWritten: number): void;
  /** An entry has its result: placed (after `onImported`) or refused. */
  onEntryDone?(): void;
}

/** What the unpacking of one opened archive works with. */
interface ArchiveRun {
  context: ImportContext;
  sourcePath: string;
  archive: OpenArchive;
  options: ImportOptions;
  onImported: (result: ImportResult) => Promise<void>;
  hooks: ArchiveImportHooks;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Directory entries and macOS resource-fork clutter give no result at all.
 *
 * @param entry the archive entry
 * @returns whether the entry is skipped
 */
function isSkipped(entry: ArchiveEntry): boolean {
  return entry.isDirectory || entry.name.replace(/\\/g, '/').startsWith('__MACOSX/');
}

/**
 * The message refusing an entry, or null when it is imported.
 *
 * @param entry the archive entry
 * @param fileName the last segment of its path
 * @returns the refusal; null when the entry is imported
 */
function refusal(entry: ArchiveEntry, fileName: string): string | null {
  if (
    entry.isSymlink ||
    entry.isUnsupported ||
    fileName === '' ||
    fileName.length > MAX_ARCHIVE_ENTRY_NAME_LENGTH ||
    CONTROL_CHARACTER.test(fileName)
  ) {
    return ARCHIVE_ENTRY_REFUSED_MESSAGE;
  }
  if (isRefusedImportName(fileName) || isZipArchive(fileName)) return REFUSED_IMPORT_MESSAGE;
  return null;
}

/**
 * The result of a source without a file.
 *
 * @param sourcePath the archive
 * @param entryName the entry; null for a result of the whole archive
 * @param error the message
 * @returns the result
 */
function failedResult(sourcePath: string, entryName: string | null, error: string): ImportResult {
  return { sourcePath, entryName, file: null, error, duplicateOf: [] };
}

/**
 * Unpacks the archive at `sourcePath`: every entry is imported flat under the last segment of
 * its path, in directory order. The limits are checked from the directory before anything is
 * written. `onImported` runs for each result with a complete file before the next entry starts.
 * Never rejects; failures are results. An archive cancelled before its first entry answers no result.
 *
 * @param context what the import reads and writes, with the archive reader
 * @param sourcePath the absolute path of the archive
 * @param budget what the current call may still unpack; reduced by this archive
 * @param onImported runs for each result with a complete file
 * @param hooks observers and the cancel check
 * @returns the results, one per entry that gives one, or one for the whole archive
 */
export async function importArchive(
  context: ImportContext & { archives: ArchiveReader },
  sourcePath: string,
  budget: ArchiveBudget,
  onImported: (result: ImportResult) => Promise<void>,
  hooks: ArchiveImportHooks = {},
): Promise<ImportResult[]> {
  let archive;
  try {
    archive = await context.archives.open(sourcePath, { maxEntries: budget.entries });
  } catch (error) {
    logImportFailure(context.log, 'archive', {}, error);
    return [failedResult(sourcePath, null, safeErrorMessage(error, 'Import failed'))];
  }

  try {
    const options: ImportOptions = hooks.onProgress === undefined ? {} : { onProgress: hooks.onProgress };
    return await unpackArchive({ context, sourcePath, archive, options, onImported, hooks }, budget);
  } finally {
    try {
      await archive.close();
    } catch {
      // Every result is already decided; a failing close changes none of them.
    }
  }
}

/**
 * Checks the directory against the budget, takes it from the budget, then imports the entries.
 *
 * @param run the opened archive and what its unpacking works with
 * @param budget what the current call may still unpack; reduced by this archive
 * @returns the results
 */
async function unpackArchive(run: ArchiveRun, budget: ArchiveBudget): Promise<ImportResult[]> {
  const { entries } = run.archive;
  const bytes = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  if (entries.length > budget.entries || bytes > budget.bytes) {
    return [failedResult(run.sourcePath, null, new ArchiveTooLargeError().message)];
  }
  budget.entries -= entries.length;
  budget.bytes -= bytes;

  const counted = entries.filter((entry) => !isSkipped(entry)).length;
  if (counted > 0) run.hooks.onEntries?.(counted);

  const { results, isCancelled } = await importEntries(run);
  if (results.length > 0) return results;
  return isCancelled ? [] : [failedResult(run.sourcePath, null, ARCHIVE_EMPTY_MESSAGE)];
}

/**
 * Imports the entries one after the other in directory order until the import is cancelled.
 *
 * @param run the opened archive and what its unpacking works with
 * @returns the results and whether the import was cancelled
 */
async function importEntries(run: ArchiveRun): Promise<{ results: ImportResult[]; isCancelled: boolean }> {
  const results: ImportResult[] = [];
  for (const [index, entry] of run.archive.entries.entries()) {
    if (isSkipped(entry)) continue;
    if (run.hooks.isCancelled?.() === true) return { results, isCancelled: true };
    run.hooks.onEntryStart?.(entry.uncompressedSize);
    results.push(await importEntry(run, index, entry));
    run.hooks.onEntryDone?.();
  }
  return { results, isCancelled: false };
}

/**
 * Imports one entry, or refuses it.
 *
 * @param run the opened archive and what its unpacking works with
 * @param index the position of the entry in the directory
 * @param entry the entry
 * @returns its result, after `onImported` for a complete file
 */
async function importEntry(run: ArchiveRun, index: number, entry: ArchiveEntry): Promise<ImportResult> {
  const { sourcePath } = run;
  const entryName = entry.name;
  const fileName = lastPathSegment(entryName);
  const refused = refusal(entry, fileName);
  if (refused !== null) return failedResult(sourcePath, entryName, refused);
  let stream;
  try {
    stream = await run.archive.openEntry(index);
  } catch (error) {
    // Only this entry fails; a later one may still be readable, so each is tried.
    logImportFailure(run.context.log, 'archive entry', { entry: index }, error);
    return failedResult(sourcePath, entryName, ARCHIVE_TRUNCATED_MESSAGE);
  }
  const imported = await importStream(run.context, { sourcePath, entryName, name: fileName, stream }, run.options);
  if (imported.file?.status === 'complete') await run.onImported(imported);
  return imported;
}
