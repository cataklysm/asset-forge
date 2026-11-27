import type { Readable } from 'node:stream';
import type { FileRecord, ImportResult } from '@assetforge/contracts';
import { AssetForgeError, ChecksumMismatchError, ValidationFailedError } from './errors.js';
import { mimeFromFileName, sanitizeFileName } from './file-names.js';
import { fileKind, hasThumbnail, isOpenable, isPreviewable, isRefusedImport } from './media-types.js';
import { inboxPath, stagingPath } from './paths.js';
import type { FileRepository, ImageProbe, SourceFiles, Storage } from './ports.js';

export interface ImportContext {
  storage: Storage;
  storageId: string;
  files: FileRepository;
  sources: SourceFiles;
  probe: ImageProbe;
  newId(): string;
  now(): Date;
}

/**
 * The text stored in `file.error` and returned to the renderer. Domain errors carry a
 * message written for that purpose; any other error (typically a Node fs error) may
 * contain absolute paths, so only its short error code survives.
 */
export function safeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AssetForgeError) return error.message;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code) ? `${fallback} (${code})` : fallback;
}

/** Message of the result for a file whose type is never imported; contains no path. */
export const REFUSED_IMPORT_MESSAGE: string = new ValidationFailedError('This file type cannot be imported').message;

/**
 * True when a source or archive entry of this name is never imported: by its own name, or by the
 * name it would be stored under, since truncation can drop a long fake extension and expose a
 * refused one (`<96 × a>.exe.<16 × b>` is stored as `<96 × a>.exe`).
 */
export function isRefusedImportName(fileName: string): boolean {
  return isRefusedImport(fileName) || isRefusedImport(sanitizeFileName(fileName));
}

const messageOf = (error: unknown) => safeErrorMessage(error, 'Import failed');

/** An opened source: a file on disk (`entryName` null) or an entry of the archive at `sourcePath`. */
export interface ImportSource {
  sourcePath: string;
  entryName: string | null;
  /** The file name the import stores; already checked against the refused types. */
  name: string;
  stream: Readable;
}

/**
 * Imports one source file. The step order is the crash-safety contract:
 * pending row -> staging -> checksum verification -> move -> complete.
 * Per-file failures never reject; they are reported in the result.
 */
export async function importFile(ctx: ImportContext, sourcePath: string, hooks: ImportFileHooks = {}): Promise<ImportResult> {
  const sourceName = sourcePath.slice(Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\')) + 1);
  if (isRefusedImportName(sourceName)) {
    return { sourcePath, entryName: null, file: null, error: REFUSED_IMPORT_MESSAGE, duplicateOf: [] };
  }

  let opened;
  try {
    opened = await ctx.sources.open(sourcePath);
  } catch (error) {
    return { sourcePath, entryName: null, file: null, error: messageOf(error), duplicateOf: [] };
  }
  if (opened.sizeBytes !== undefined) hooks.onSize?.(opened.sizeBytes);
  const options: ImportOptions = hooks.onProgress === undefined ? {} : { onProgress: hooks.onProgress };
  return importStream(ctx, { sourcePath, entryName: null, name: opened.name, stream: opened.stream }, options);
}

/** Observers of `importFile`, for the progress of a running import. */
export interface ImportFileHooks {
  /** The size of the opened source, when the source files answer it. */
  onSize?(sizeBytes: number): void;
  /** The cumulative number of bytes written to staging. */
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
   */
  keepStaged?(staged: { sizeBytes: number }): boolean;
  /** A failure removes staging and deletes the pending row instead of marking it failed; the result has no file. */
  discardOnFailure?: boolean;
  /** Called on a failed import with the error that ended the source stream, when the stream failed. */
  onStreamError?(error: unknown): void;
  /** Passed on to `Storage.writeStream`: the cumulative number of bytes written to staging. */
  onProgress?(bytesWritten: number): void;
}

/** Removes the paths, best effort; startup recovery cleans leftovers of pending rows. */
async function removeQuietly(storage: Storage, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await storage.remove(path);
    } catch {
      // Best effort.
    }
  }
}

/** The import steps of an opened source; takes ownership of its stream and never rejects. */
export async function importStream(ctx: ImportContext, source: ImportSource, options: ImportOptions = {}): Promise<ImportResult> {
  const { sourcePath, entryName, name, stream } = source;
  const id = ctx.newId();
  const staging = stagingPath(id);
  const finalPath = inboxPath(id, name);
  const pending = {
    id,
    storageId: ctx.storageId,
    originalName: name,
    relativePath: finalPath,
    mimeType: mimeFromFileName(name),
    importedAt: ctx.now().toISOString(),
    kind: fileKind(name),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  };

  // Only listened to for a caller that asks: the first error the source stream emits.
  let streamError: { error: unknown } | null = null;
  if (options.onStreamError !== undefined) {
    stream.on('error', (error: unknown) => {
      streamError ??= { error };
    });
  }

  try {
    await ctx.files.insertPending(pending);
  } catch (error) {
    // The storage adapter does not destroy a source it never started piping; release the handle.
    stream.destroy();
    return { sourcePath, entryName, file: null, error: messageOf(error), duplicateOf: [] };
  }

  // `move` rejects when the target exists, so the final path is ours to clean up only after it succeeded.
  let moved = false;
  try {
    const { sizeBytes, sha256 } =
      options.onProgress === undefined
        ? await ctx.storage.writeStream(staging, stream)
        : await ctx.storage.writeStream(staging, stream, { onProgress: options.onProgress });
    const verified = await ctx.storage.hashFile(staging);
    if (verified !== sha256) {
      throw new ChecksumMismatchError(`Checksum mismatch after staging: expected ${sha256}, got ${verified}`);
    }
    const discardStaged = async () => {
      await removeQuietly(ctx.storage, [staging]);
      try {
        await ctx.files.deletePending(id);
      } catch {
        // The row stays pending; recovery deletes a download row and fails any other on the next open.
      }
    };
    if (options.keepStaged !== undefined && !options.keepStaged({ sizeBytes })) {
      await discardStaged();
      return { sourcePath, entryName, file: null, error: null, duplicateOf: [] };
    }
    const duplicateOf = (await ctx.files.findCompleteBySha256(sha256)).map((f) => f.id);
    if (options.skipDuplicate === true && duplicateOf.length > 0) {
      await discardStaged();
      return { sourcePath, entryName, file: null, error: null, duplicateOf };
    }
    await ctx.storage.move(staging, finalPath);
    moved = true;
    // A failed measurement never fails the import; the file is measured on demand later.
    let size: { width: number; height: number } | null = null;
    if (isPreviewable(pending.mimeType)) {
      try {
        size = await ctx.probe.measure(await ctx.storage.absolutePath(finalPath));
      } catch {
        size = null;
      }
    }
    await ctx.files.markComplete(id, { sizeBytes, sha256, width: size?.width ?? null, height: size?.height ?? null });
    const file: FileRecord = {
      id,
      storageId: ctx.storageId,
      assetId: null,
      role: null,
      originalName: name,
      relativePath: finalPath,
      mimeType: pending.mimeType,
      sizeBytes,
      sha256,
      status: 'complete',
      error: null,
      importedAt: pending.importedAt,
      previewable: isPreviewable(pending.mimeType),
      thumbnail: hasThumbnail(pending.mimeType),
      openable: isOpenable(finalPath),
      kind: pending.kind,
      width: size?.width ?? null,
      height: size?.height ?? null,
      durationMs: null,
      tags: [],
      hasProposal: false,
      deletedAt: null,
      trashedAssetId: null,
      trashedAssetName: null,
      trashedRole: null,
    };
    return { sourcePath, entryName, file, error: null, duplicateOf };
  } catch (error) {
    const message = messageOf(error);
    // Read before our own destroy, which ends the stream without an error.
    const ended = (streamError as { error: unknown } | null) ?? (stream.errored == null ? null : { error: stream.errored });
    stream.destroy();
    await removeQuietly(ctx.storage, moved ? [staging, finalPath] : [staging]);
    if (ended !== null) options.onStreamError?.(ended.error);
    if (options.discardOnFailure === true) {
      try {
        await ctx.files.deletePending(id);
      } catch {
        // The row stays pending; recovery deletes a download row and fails any other on the next open.
      }
      return { sourcePath, entryName, file: null, error: message, duplicateOf: [] };
    }
    try {
      await ctx.files.markFailed(id, message);
    } catch {
      // The row stays pending and is failed by recovery on the next open.
    }
    const file: FileRecord = {
      id,
      storageId: ctx.storageId,
      assetId: null,
      role: null,
      originalName: name,
      relativePath: finalPath,
      mimeType: pending.mimeType,
      sizeBytes: null,
      sha256: null,
      status: 'failed',
      error: message,
      importedAt: pending.importedAt,
      previewable: isPreviewable(pending.mimeType),
      thumbnail: hasThumbnail(pending.mimeType),
      openable: isOpenable(finalPath),
      kind: pending.kind,
      width: null,
      height: null,
      durationMs: null,
      tags: [],
      hasProposal: false,
      deletedAt: null,
      trashedAssetId: null,
      trashedAssetName: null,
      trashedRole: null,
    };
    return { sourcePath, entryName, file, error: message, duplicateOf: [] };
  }
}
