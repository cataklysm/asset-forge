import type { FileRecord, ImportResult } from '@assetforge/contracts';
import { ChecksumMismatchError } from './errors.js';
import { mimeFromFileName } from './file-names.js';
import { inboxPath, stagingPath } from './paths.js';
import type { FileRepository, SourceFiles, Storage } from './ports.js';

export interface ImportContext {
  storage: Storage;
  files: FileRepository;
  sources: SourceFiles;
  newId(): string;
  now(): Date;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Imports one source file. The step order is the crash-safety contract:
 * pending row -> staging -> checksum verification -> move -> complete.
 * Per-file failures never reject; they are reported in the result.
 */
export async function importFile(ctx: ImportContext, sourcePath: string): Promise<ImportResult> {
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
    originalName: name,
    relativePath: finalPath,
    mimeType: mimeFromFileName(name),
    importedAt: ctx.now().toISOString(),
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
    await ctx.files.markComplete(id, { sizeBytes, sha256 });
    const file: FileRecord = {
      id,
      assetId: null,
      originalName: name,
      relativePath: finalPath,
      mimeType: pending.mimeType,
      sizeBytes,
      sha256,
      status: 'complete',
      error: null,
      importedAt: pending.importedAt,
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
      assetId: null,
      originalName: name,
      relativePath: finalPath,
      mimeType: pending.mimeType,
      sizeBytes: null,
      sha256: null,
      status: 'failed',
      error: message,
      importedAt: pending.importedAt,
    };
    return { sourcePath, file, error: message, duplicateOf: [] };
  }
}
