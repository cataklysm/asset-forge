import type { FileTarget, ImportProgress, ImportResult } from '@assetforge/contracts';
import { relocateFile } from './asset-files.js';
import { NotFoundError } from './errors.js';
import { importArchive, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_ENTRIES, type ArchiveBudget } from './import-archive.js';
import { importFile, safeErrorMessage, type ImportContext } from './import-file.js';
import { isZipArchive } from './import-refusals.js';
import type { ArchiveReader } from './ports/source-files.js';
import type { WorkspaceHost } from './ports/workspace-host.js';
import type { WorkspaceSession } from './session.js';

/** How an import treats its sources. */
export interface ImportSourcesOptions {
  /** Unpack every `.zip` source into its entries instead of importing it as a file. */
  unpackArchives?: boolean;
}

/**
 * Refuses an import into an asset that does not exist; checked before anything is imported.
 *
 * @param session the open workspace
 * @param target the asset and role to import into; null for the inbox
 * @returns resolves when the target can take files
 * @throws `NotFoundError` for an unknown asset
 */
export async function requireTargetAsset(session: WorkspaceSession, target: FileTarget | null): Promise<void> {
  if (target !== null && (await session.database.assets.get(target.assetId)) === null) {
    throw new NotFoundError(`Asset ${target.assetId} does not exist`);
  }
}

/**
 * The progress of an import that has not started yet.
 *
 * @param sourceCount the number of sources
 * @returns the progress, with one item per source
 */
export function newImportProgress(sourceCount: number): ImportProgress {
  return { done: 0, total: sourceCount, currentBytes: 0, currentSize: null, cancelling: false };
}

/**
 * Imports the sources one after another into the inbox, then places each complete file in the target. Stops before
 * the next source or archive entry once `progress.cancelling` is set; the item in progress always finishes.
 *
 * @param host gives the source files and the ZIP reader
 * @param session the open workspace
 * @param sourcePaths the absolute paths of the sources
 * @param target the asset and role to place the files in; null leaves them in the inbox
 * @param options whether archives are unpacked
 * @param progress the live progress, updated while the import runs
 * @returns one result per source, or per archive entry for an unpacked archive
 */
export function importSources(
  host: WorkspaceHost,
  session: WorkspaceSession,
  sourcePaths: string[],
  target: FileTarget | null,
  options: ImportSourcesOptions,
  progress: ImportProgress,
): Promise<ImportResult[]> {
  return new SourceImport(host, session, target, options, progress).run(sourcePaths);
}

/**
 * The last segment of a source path, split on either separator.
 *
 * @param sourcePath a source path
 * @returns the file name; '' for a path that ends in a separator
 */
function lastPathSegment(sourcePath: string): string {
  return sourcePath.split(/[\\/]/).pop() ?? '';
}

/** One import run; its steps share the import context, the archive budget and the live progress. */
class SourceImport {
  private readonly context: ImportContext & { archives: ArchiveReader };
  private readonly budget: ArchiveBudget = { entries: MAX_ARCHIVE_ENTRIES, bytes: MAX_ARCHIVE_BYTES };

  /**
   * @param host gives the source files and the ZIP reader
   * @param session the open workspace
   * @param target the asset and role to place the files in; null leaves them in the inbox
   * @param options whether archives are unpacked
   * @param progress the live progress
   */
  constructor(
    host: WorkspaceHost,
    private readonly session: WorkspaceSession,
    private readonly target: FileTarget | null,
    private readonly options: ImportSourcesOptions,
    private readonly progress: ImportProgress,
  ) {
    this.context = {
      storage: session.storage,
      storageId: session.storageId,
      files: session.database.files,
      sources: host.sources,
      archives: host.archives,
      probe: host.imageProbe,
      newId: session.newId,
      now: session.now,
    };
  }

  /**
   * Imports the sources in order until they are done or the import is cancelled.
   *
   * @param sourcePaths the absolute paths of the sources
   * @returns the results of the sources that were imported
   */
  async run(sourcePaths: string[]): Promise<ImportResult[]> {
    const results: ImportResult[] = [];
    for (const sourcePath of sourcePaths) {
      if (this.progress.cancelling) break;
      this.startItem(null);
      if (this.options.unpackArchives === true && isZipArchive(lastPathSegment(sourcePath))) {
        results.push(...(await this.importArchiveSource(sourcePath)));
        continue;
      }
      results.push(await this.importPlainSource(sourcePath));
    }
    return results;
  }

  /**
   * Unpacks one archive source. Until its directory is read the archive is one item; then each entry with a
   * result is one.
   *
   * @param sourcePath the archive
   * @returns the results of its entries, or one result for the archive itself
   */
  private async importArchiveSource(sourcePath: string): Promise<ImportResult[]> {
    const archive = { isExpanded: false };
    const results = await importArchive(this.context, sourcePath, this.budget, (result) => this.place(result), {
      onEntries: (count) => {
        archive.isExpanded = true;
        this.progress.total += count - 1;
      },
      isCancelled: () => this.progress.cancelling,
      onEntryStart: (declaredSize) => this.startItem(declaredSize),
      onProgress: (bytesWritten) => this.recordBytes(bytesWritten),
      onEntryDone: () => this.finishItem(),
    });
    if (!archive.isExpanded) this.finishItem();
    return results;
  }

  /**
   * Imports one source as a file and places it.
   *
   * @param sourcePath the source
   * @returns its result
   */
  private async importPlainSource(sourcePath: string): Promise<ImportResult> {
    const result = await importFile(this.context, sourcePath, {
      onSize: (sizeBytes) => {
        this.progress.currentSize = sizeBytes;
      },
      onProgress: (bytesWritten) => this.recordBytes(bytesWritten),
    });
    await this.place(result);
    this.finishItem();
    return result;
  }

  /**
   * Moves a complete file into the target asset. A failure leaves the file in the inbox and is written into the
   * result.
   *
   * @param result the result of an imported file; its `file` or `error` is updated in place
   * @returns resolves once the file is placed or the failure recorded
   */
  private async place(result: ImportResult): Promise<void> {
    if (this.target === null || result.file?.status !== 'complete') return;
    try {
      result.file = await relocateFile(this.session, result.file.id, this.target);
    } catch (error) {
      // The file stays in the inbox; the result reports why it was not placed.
      result.error = safeErrorMessage(error, 'Placing the file failed');
    }
  }

  /**
   * Starts the next item of the progress.
   *
   * @param size the size of the item in bytes; null while unknown
   */
  private startItem(size: number | null): void {
    this.progress.currentBytes = 0;
    this.progress.currentSize = size;
  }

  /**
   * Records how far the current item is written.
   *
   * @param bytesWritten the bytes written so far
   */
  private recordBytes(bytesWritten: number): void {
    this.progress.currentBytes = bytesWritten;
  }

  /** Counts the current item as done. */
  private finishItem(): void {
    // The finished item's bytes never outlive its count, so `done + fraction` never exceeds `total`.
    this.progress.done += 1;
    this.startItem(null);
  }
}
