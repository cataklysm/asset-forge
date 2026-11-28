import type { Readable } from 'node:stream';

// What an import reads from outside the workspace: the files the user picked, and the ZIP archives among them.

/** The files outside the workspace that an import reads. Implemented outside core. */
export interface SourceFiles {
  /**
   * Opens a picked file for reading.
   *
   * @param absolutePath the file as the user picked it
   * @returns its name, its content and, when known, its size; rejects with SourceNotReadableError
   */
  open(absolutePath: string): Promise<{ name: string; stream: Readable; sizeBytes?: number }>;
}

/** One entry of an archive's directory, as the archive states it. */
export interface ArchiveEntry {
  /** The entry's path as stored in the archive. */
  name: string;
  /** The size the directory announces; the content stream holds it to exactly this. */
  uncompressedSize: number;
  /** A directory entry, which carries no content. */
  isDirectory: boolean;
  /** A symbolic link, which is never imported. */
  isSymlink: boolean;
  /** Encrypted, or a compression method other than stored/deflate. */
  isUnsupported: boolean;
}

/** An archive whose directory has been read; its entries are opened one at a time. */
export interface OpenArchive {
  /** The entries in directory order. */
  entries: readonly ArchiveEntry[];
  /**
   * Opens the content of one entry.
   *
   * @param index the position in `entries`
   * @returns a stream of the entry's content that fails when it does not yield exactly `uncompressedSize` bytes
   */
  openEntry(index: number): Promise<Readable>;
  /** Closes the archive file. */
  close(): Promise<void>;
}

/** Reads ZIP archives for the import. Implemented outside core. */
export interface ArchiveReader {
  /**
   * Opens an archive and reads its directory.
   *
   * @param absolutePath the archive as the user picked it
   * @param limits `maxEntries` the most entries the archive may have
   * @returns the open archive; rejects with SourceNotReadableError (missing, not a regular file, not readable),
   *   ArchiveNotReadableError (not a ZIP) or ArchiveTooLargeError (more than `maxEntries` entries, decided before
   *   reading the directory)
   */
  open(absolutePath: string, limits: { maxEntries: number }): Promise<OpenArchive>;
}
