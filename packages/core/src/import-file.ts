import type { Readable } from 'node:stream';
import type { FileRecord, ImportResult } from '@assetforge/contracts';
import { AssetForgeError, ChecksumMismatchError } from './errors.js';
import { isRefusedImportName, REFUSED_IMPORT_MESSAGE } from './import-refusals.js';
import { fileKind, hasThumbnail, isOpenable, isPreviewable, mimeFromFileName } from './media-types.js';
import { inboxPath, stagingPath } from './paths.js';
import type { FileRepository } from './ports/file-repositories.js';
import type { ImageProbe } from './ports/media-probes.js';
import type { SourceFiles } from './ports/source-files.js';
import type { Storage } from './ports/storage.js';

/** What an import reads and writes. */
export interface ImportContext {
  storage: Storage;
  storageId: string;
  files: FileRepository;
  sources: SourceFiles;
  probe: ImageProbe;
  /**
   * A fresh id for the file row.
   *
   * @returns the id
   */
  newId(): string;
  /**
   * The current time.
   *
   * @returns the time
   */
  now(): Date;
}

/**
 * The text stored in `file.error` and returned to the renderer. Domain errors carry a
 * message written for that purpose; any other error (typically a Node fs error) may
 * contain absolute paths, so only its short error code survives.
 *
 * @param error the error that ended the step
 * @param fallback the text for an error that is not a domain error
 * @returns the message to store and show
 */
export function safeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AssetForgeError) return error.message;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code) ? `${fallback} (${code})` : fallback;
}

/**
 * The message of a failed import.
 *
 * @param error the error that ended the import
 * @returns the message to store and show
 */
function messageOf(error: unknown): string {
  return safeErrorMessage(error, 'Import failed');
}

/** An opened source: a file on disk (`entryName` null) or an entry of the archive at `sourcePath`. */
export interface ImportSource {
  sourcePath: string;
  entryName: string | null;
  /** The file name the import stores; already checked against the refused types. */
  name: string;
  stream: Readable;
}

/** Observers of `importFile`, for the progress of a running import. */
export interface ImportFileHooks {
  /**
   * The size of the opened source, when the source files answer it.
   *
   * @param sizeBytes the size in bytes
   */
  onSize?(sizeBytes: number): void;
  /**
   * The cumulative number of bytes written to staging.
   *
   * @param bytesWritten the bytes written so far
   */
  onProgress?(bytesWritten: number): void;
}

/** Options of `importStream`; without them it behaves as the file import always did. */
export interface ImportOptions {
  /** Inserted with the pending row, in the same transaction. */
  origin?: { id: string; url: string };
  /**
   * After the checksum, before the move: a complete file outside the trash with this SHA-256 ends the import
   * without a file. Staging is removed, the pending row deleted, and `duplicateOf` lists those files oldest first.
   */
  skipDuplicate?: boolean;
  /**
   * After the checksum, before the duplicate check: false ends the import without a file, like a skipped duplicate
   * but with an empty `duplicateOf`. Staging is removed and the pending row (with its origin) deleted.
   *
   * @param staged the size of the staged file
   * @returns whether the import goes on
   */
  keepStaged?(staged: { sizeBytes: number }): boolean;
  /** A failure removes staging and deletes the pending row instead of marking it failed; the result has no file. */
  discardOnFailure?: boolean;
  /**
   * Called on a failed import with the error that ended the source stream, when the stream failed.
   *
   * @param error the error the source stream emitted
   */
  onStreamError?(error: unknown): void;
  /**
   * Passed on to `Storage.writeStream`: the cumulative number of bytes written to staging.
   *
   * @param bytesWritten the bytes written so far
   */
  onProgress?(bytesWritten: number): void;
}

/** One running `importStream`: its inputs, its paths and pending row, and the state its steps share. */
interface ImportRun {
  context: ImportContext;
  source: ImportSource;
  options: ImportOptions;
  id: string;
  staging: string;
  finalPath: string;
  pending: Parameters<FileRepository['insertPending']>[0];
  /** Only listened to for a caller that asks: the first error the source stream emits. */
  streamError: { error: unknown } | null;
  /** `move` rejects when the target exists, so the final path is ours to clean up only after it succeeded. */
  isMoved: boolean;
}

/** The fields in which a complete and a failed file record differ. */
interface RecordState {
  status: 'complete' | 'failed';
  error: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
}

/**
 * Imports one source file. The step order is the crash-safety contract:
 * pending row -> staging -> checksum verification -> move -> complete.
 * Per-file failures never reject; they are reported in the result.
 *
 * @param context what the import reads and writes
 * @param sourcePath the absolute path of the source file
 * @param hooks observers of the progress
 * @returns the result for the source
 */
export async function importFile(
  context: ImportContext,
  sourcePath: string,
  hooks: ImportFileHooks = {},
): Promise<ImportResult> {
  if (isRefusedImportName(baseNameOf(sourcePath))) {
    return { sourcePath, entryName: null, file: null, error: REFUSED_IMPORT_MESSAGE, duplicateOf: [] };
  }

  let opened;
  try {
    opened = await context.sources.open(sourcePath);
  } catch (error) {
    return { sourcePath, entryName: null, file: null, error: messageOf(error), duplicateOf: [] };
  }
  if (opened.sizeBytes !== undefined) hooks.onSize?.(opened.sizeBytes);
  const options: ImportOptions = hooks.onProgress === undefined ? {} : { onProgress: hooks.onProgress };
  return importStream(context, { sourcePath, entryName: null, name: opened.name, stream: opened.stream }, options);
}

/**
 * The last segment of a path with `/` or `\` separators.
 *
 * @param sourcePath the path
 * @returns the file name
 */
function baseNameOf(sourcePath: string): string {
  return sourcePath.slice(Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\')) + 1);
}

/**
 * Removes the paths, best effort; startup recovery cleans leftovers of pending rows.
 *
 * @param storage the storage of the workspace
 * @param paths the relative paths to remove
 * @returns resolves once done; never rejects
 */
async function removeQuietly(storage: Storage, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await storage.remove(path);
    } catch {
      // Best effort.
    }
  }
}

/**
 * The import steps of an opened source; takes ownership of its stream and never rejects.
 *
 * @param context what the import reads and writes
 * @param source the opened source
 * @param options the variations of the import
 * @returns the result for the source
 */
export async function importStream(
  context: ImportContext,
  source: ImportSource,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const run = startRun(context, source, options);
  try {
    await context.files.insertPending(run.pending);
  } catch (error) {
    // The storage adapter does not destroy a source it never started piping; release the handle.
    source.stream.destroy();
    return resultWithoutFile(run, messageOf(error), []);
  }
  try {
    return await stageAndComplete(run);
  } catch (error) {
    return failRun(run, error);
  }
}

/**
 * The run of one import: a new id, its paths and pending row; listens for a stream error when the caller asks.
 *
 * @param context what the import reads and writes
 * @param source the opened source
 * @param options the variations of the import
 * @returns the run
 */
function startRun(context: ImportContext, source: ImportSource, options: ImportOptions): ImportRun {
  const { name } = source;
  const id = context.newId();
  const staging = stagingPath(id);
  const finalPath = inboxPath(id, name);
  const pending = {
    id,
    storageId: context.storageId,
    originalName: name,
    relativePath: finalPath,
    mimeType: mimeFromFileName(name),
    importedAt: context.now().toISOString(),
    kind: fileKind(name),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  };
  const run: ImportRun = { context, source, options, id, staging, finalPath, pending, streamError: null, isMoved: false };
  if (options.onStreamError !== undefined) {
    source.stream.on('error', (error: unknown) => {
      run.streamError ??= { error };
    });
  }
  return run;
}

/**
 * Staging, checksum, the caller's keep and duplicate checks, the move and the complete row.
 *
 * @param run the running import
 * @returns the result: the complete file, or no file when the caller's checks end the import
 * @throws whatever ends the import; `failRun` turns it into the result
 */
async function stageAndComplete(run: ImportRun): Promise<ImportResult> {
  const { context, options, staging, finalPath } = run;
  const { sizeBytes, sha256 } = await writeStaging(run);
  const verified = await context.storage.hashFile(staging);
  if (verified !== sha256) {
    throw new ChecksumMismatchError(`Checksum mismatch after staging: expected ${sha256}, got ${verified}`);
  }
  if (options.keepStaged !== undefined && !options.keepStaged({ sizeBytes })) {
    await discardStaged(run);
    return resultWithoutFile(run, null, []);
  }
  const duplicateOf = (await context.files.findCompleteBySha256(sha256)).map((file) => file.id);
  if (options.skipDuplicate === true && duplicateOf.length > 0) {
    await discardStaged(run);
    return resultWithoutFile(run, null, duplicateOf);
  }
  await context.storage.move(staging, finalPath);
  run.isMoved = true;
  const size = await measureQuietly(run);
  const width = size?.width ?? null;
  const height = size?.height ?? null;
  await context.files.markComplete(run.id, { sizeBytes, sha256, width, height });
  const file = recordOf(run, { status: 'complete', error: null, sizeBytes, sha256, width, height });
  return { ...resultWithoutFile(run, null, duplicateOf), file };
}

/**
 * Writes the source stream to staging, reporting progress when the caller asks.
 *
 * @param run the running import
 * @returns the size and SHA-256 of what was written
 */
function writeStaging(run: ImportRun): Promise<{ sizeBytes: number; sha256: string }> {
  const { storage } = run.context;
  const { onProgress } = run.options;
  return onProgress === undefined
    ? storage.writeStream(run.staging, run.source.stream)
    : storage.writeStream(run.staging, run.source.stream, { onProgress });
}

/**
 * The image size of the moved file. A failed measurement never fails the import; the file is measured on demand
 * later.
 *
 * @param run the running import, after the move
 * @returns the size; null for a file that is not previewable or when the measurement failed
 */
async function measureQuietly(run: ImportRun): Promise<{ width: number; height: number } | null> {
  if (!isPreviewable(run.pending.mimeType)) return null;
  try {
    return await run.context.probe.measure(await run.context.storage.absolutePath(run.finalPath));
  } catch {
    return null;
  }
}

/**
 * Ends an import the caller's checks refused: staging removed, then the pending row deleted.
 *
 * @param run the running import
 * @returns resolves once done; never rejects
 */
async function discardStaged(run: ImportRun): Promise<void> {
  await removeQuietly(run.context.storage, [run.staging]);
  await deletePendingQuietly(run);
}

/**
 * Deletes the pending row, best effort.
 *
 * @param run the running import
 * @returns resolves once done; never rejects
 */
async function deletePendingQuietly(run: ImportRun): Promise<void> {
  try {
    await run.context.files.deletePending(run.id);
  } catch {
    // The row stays pending; recovery deletes a download row and fails any other on the next open.
  }
}

/**
 * Ends a failed import: the stream destroyed, staging (and the final path once moved) removed, the caller told of
 * a stream error, then the pending row deleted or marked failed.
 *
 * @param run the running import
 * @param error the error that ended it
 * @returns the result: the failed file, or no file with `discardOnFailure`
 */
async function failRun(run: ImportRun, error: unknown): Promise<ImportResult> {
  const { context, source, options } = run;
  const message = messageOf(error);
  // Read before our own destroy, which ends the stream without an error.
  const ended = run.streamError ?? (source.stream.errored == null ? null : { error: source.stream.errored });
  source.stream.destroy();
  await removeQuietly(context.storage, run.isMoved ? [run.staging, run.finalPath] : [run.staging]);
  if (ended !== null) options.onStreamError?.(ended.error);
  if (options.discardOnFailure === true) {
    await deletePendingQuietly(run);
    return resultWithoutFile(run, message, []);
  }
  try {
    await context.files.markFailed(run.id, message);
  } catch {
    // The row stays pending and is failed by recovery on the next open.
  }
  const file = recordOf(run, { status: 'failed', error: message, sizeBytes: null, sha256: null, width: null, height: null });
  return { ...resultWithoutFile(run, message, []), file };
}

/**
 * The result of the run without a file.
 *
 * @param run the running import
 * @param error the message of a failure; null otherwise
 * @param duplicateOf the complete files with the same content
 * @returns the result
 */
function resultWithoutFile(run: ImportRun, error: string | null, duplicateOf: string[]): ImportResult {
  return { sourcePath: run.source.sourcePath, entryName: run.source.entryName, file: null, error, duplicateOf };
}

/**
 * The record of the imported file in the inbox, as the row now reads.
 *
 * @param run the running import
 * @param state the fields in which a complete and a failed file differ
 * @returns the file record
 */
function recordOf(run: ImportRun, state: RecordState): FileRecord {
  const { pending } = run;
  return {
    id: run.id,
    storageId: run.context.storageId,
    assetId: null,
    role: null,
    originalName: run.source.name,
    relativePath: run.finalPath,
    mimeType: pending.mimeType,
    sizeBytes: state.sizeBytes,
    sha256: state.sha256,
    status: state.status,
    error: state.error,
    importedAt: pending.importedAt,
    previewable: isPreviewable(pending.mimeType),
    thumbnail: hasThumbnail(pending.mimeType),
    openable: isOpenable(run.finalPath),
    kind: pending.kind,
    width: state.width,
    height: state.height,
    durationMs: null,
    tags: [],
    hasProposal: false,
    deletedAt: null,
    trashedAssetId: null,
    trashedAssetName: null,
    trashedRole: null,
  };
}
