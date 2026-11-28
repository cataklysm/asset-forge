import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { SourceNotReadableError, type SourceFiles } from '@assetforge/core';

/** The import's source files on the local file system: regular files only, read as streams. */
export class NodeSourceFiles implements SourceFiles {
  /**
   * Opens a source file.
   *
   * @param absolutePath the file chosen by the user
   * @returns its base name, its bytes as a stream and its size
   * @throws SourceNotReadableError when it cannot be opened or is not a regular file
   */
  async open(absolutePath: string): Promise<{ name: string; stream: Readable; sizeBytes: number }> {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(absolutePath, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error('not a regular file');
      }
      // The stream takes ownership of the handle and closes it when done.
      const stream = handle.createReadStream();
      return { name: path.basename(absolutePath), stream, sizeBytes: stat.size };
    } catch (cause) {
      await handle?.close().catch(() => undefined);
      throw new SourceNotReadableError({ cause });
    }
  }
}
