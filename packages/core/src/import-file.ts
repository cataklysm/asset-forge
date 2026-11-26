import type { FileRecord, ImportResult } from '@assetforge/contracts';
import { AssetForgeError, ChecksumMismatchError, ValidationFailedError } from './errors.js';
import { mimeFromFileName } from './file-names.js';
import { fileKind, isOpenable, isPreviewable, isRefusedImport } from './media-types.js';
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

const messageOf = (error: unknown) => safeErrorMessage(error, 'Import failed');

/**
 * Imports one source file. The step order is the crash-safety contract:
 * pending row -> staging -> checksum verification -> move -> complete.
 * Per-file failures never reject; they are reported in the result.
 */
export async function importFile(ctx: ImportContext, sourcePath: string): Promise<ImportResult> {
  const sourceName = sourcePath.slice(Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\')) + 1);
  if (isRefusedImport(sourceName)) {
    return { sourcePath, file: null, error: REFUSED_IMPORT_MESSAGE, duplicateOf: [] };
  }

  let opened;
  try {
    opened = await ctx.sources.open(sourcePath);
  } catch (error) {
    return { sourcePath, file: null, error: messageOf(error), duplicateOf: [] };
  }
  const { name, stream } = opened;

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
  };

  try {
    await ctx.files.insertPending(pending);
  } catch (error) {
    // The storage adapter does not destroy a source it never started piping; release the handle.
    stream.destroy();
    return { sourcePath, file: null, error: messageOf(error), duplicateOf: [] };
  }

  // `move` rejects when the target exists, so the final path is ours to clean up only after it succeeded.
  let moved = false;
  try {
    const { sizeBytes, sha256 } = await ctx.storage.writeStream(staging, stream);
    const verified = await ctx.storage.hashFile(staging);
    if (verified !== sha256) {
      throw new ChecksumMismatchError(`Checksum mismatch after staging: expected ${sha256}, got ${verified}`);
    }
    const duplicateOf = (await ctx.files.findCompleteBySha256(sha256)).map((f) => f.id);
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
      openable: isOpenable(finalPath),
      kind: pending.kind,
      width: size?.width ?? null,
      height: size?.height ?? null,
      tags: [],
      hasProposal: false,
    };
    return { sourcePath, file, error: null, duplicateOf };
  } catch (error) {
    const message = messageOf(error);
    stream.destroy();
    for (const path of moved ? [staging, finalPath] : [staging]) {
      try {
        await ctx.storage.remove(path);
      } catch {
        // Best effort; startup recovery cleans leftovers of pending rows.
      }
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
      openable: isOpenable(finalPath),
      kind: pending.kind,
      width: null,
      height: null,
      tags: [],
      hasProposal: false,
    };
    return { sourcePath, file, error: message, duplicateOf: [] };
  }
}
