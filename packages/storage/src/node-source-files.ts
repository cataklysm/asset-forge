import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { SourceNotReadableError, type SourceFiles } from '@assetforge/core';

export class NodeSourceFiles implements SourceFiles {
  async open(absolutePath: string): Promise<{ name: string; stream: Readable }> {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(absolutePath, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error('not a regular file');
      }
      // The stream takes ownership of the handle and closes it when done.
      const stream = handle.createReadStream();
      return { name: path.basename(absolutePath), stream };
    } catch (cause) {
      await handle?.close().catch(() => undefined);
      throw new SourceNotReadableError(`Cannot read source file: ${absolutePath}`, { cause });
    }
  }
}
