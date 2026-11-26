import { ArchiveNotReadableError, type ArchiveReader, type OpenArchive } from '@assetforge/core';

/** Reads ZIP archives for the import. Placeholder until the reader adapter lands: refuses every archive. */
export class ZipArchiveReader implements ArchiveReader {
  async open(_absolutePath: string, _limits: { maxEntries: number }): Promise<OpenArchive> {
    throw new ArchiveNotReadableError();
  }
}
