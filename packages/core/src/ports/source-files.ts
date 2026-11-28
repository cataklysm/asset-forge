import type { Readable } from 'node:stream';

export interface SourceFiles {
  /** Rejects with SourceNotReadableError; `sizeBytes` is the file's size when known. */
  open(absolutePath: string): Promise<{ name: string; stream: Readable; sizeBytes?: number }>;
}

export interface ArchiveEntry {
  /** The entry's path as stored in the archive. */
  name: string;
  uncompressedSize: number;
  isDirectory: boolean;
  isSymlink: boolean;
  /** Encrypted, or a compression method other than stored/deflate. */
  isUnsupported: boolean;
}

export interface OpenArchive {
  entries: readonly ArchiveEntry[];
  /** A stream of the entry's content that fails when it does not yield exactly `uncompressedSize` bytes. */
  openEntry(index: number): Promise<Readable>;
  close(): Promise<void>;
}

export interface ArchiveReader {
  /**
   * Rejects with SourceNotReadableError (missing, not a regular file, not readable),
   * ArchiveNotReadableError (not a ZIP) or ArchiveTooLargeError (more than `maxEntries` entries, decided before reading the directory).
   */
  open(absolutePath: string, limits: { maxEntries: number }): Promise<OpenArchive>;
}
