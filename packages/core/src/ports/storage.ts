import type { Readable } from 'node:stream';

// The file system of a workspace as core sees it: every path is relative to the storage root.

/**
 * The binaries of one workspace under its storage root. Every path is relative to the root and validated by the
 * adapter, so no operation escapes the workspace. Implemented outside core.
 */
export interface Storage {
  /**
   * Whether the storage can be reached at all, which tells unreachable storage apart from a missing file.
   *
   * @returns true when the root's parent volume or directory is accessible
   */
  isReachable(): Promise<boolean>;
  /**
   * Whether a new workspace may be created here.
   *
   * @returns true when the root does not exist or has no entries
   */
  isEmptyOrMissing(): Promise<boolean>;
  /** Creates the root and the directories of `LAYOUT_DIRS`. */
  ensureLayout(): Promise<void>;
  /**
   * Reads a text file.
   *
   * @param relativePath the file, relative to the root
   * @returns its text; null when it is missing
   */
  readText(relativePath: string): Promise<string | null>;
  /**
   * Writes a text file atomically: a temporary file, then a rename.
   *
   * @param relativePath the file, relative to the root
   * @param text the whole content
   */
  writeText(relativePath: string, text: string): Promise<void>;
  /**
   * Writes a stream to a file and hashes it on the way.
   *
   * @param relativePath the file, relative to the root
   * @param source the content
   * @param options `onProgress` receives the cumulative number of bytes as chunks are written
   * @returns the number of bytes written and their lowercase hex SHA-256
   */
  writeStream(
    relativePath: string,
    source: Readable,
    options?: { onProgress?(bytesWritten: number): void },
  ): Promise<{ sizeBytes: number; sha256: string }>;
  /**
   * Hashes a file.
   *
   * @param relativePath the file, relative to the root
   * @returns its lowercase hex SHA-256
   */
  hashFile(relativePath: string): Promise<string>;
  /**
   * Moves a file within the storage.
   *
   * @param from the current path, relative to the root
   * @param to the new path, relative to the root; the move rejects when it exists
   */
  move(from: string, to: string): Promise<void>;
  /**
   * Whether a file or directory exists.
   *
   * @param relativePath the entry, relative to the root
   * @returns true when it exists
   */
  exists(relativePath: string): Promise<boolean>;
  /**
   * Removes a file; a missing one is a no-op.
   *
   * @param relativePath the file, relative to the root
   */
  remove(relativePath: string): Promise<void>;
  /**
   * Lists a directory.
   *
   * @param relativeDirectory the directory, relative to the root
   * @returns the entry names; an empty list when the directory is missing
   */
  list(relativeDirectory: string): Promise<string[]>;
  /**
   * The absolute path of a path inside the storage root; validated like every other operation. Never sent to the
   * renderer.
   *
   * @param relativePath the entry, relative to the root
   * @returns its absolute path
   */
  absolutePath(relativePath: string): Promise<string>;
  /**
   * Free bytes of the volume holding the storage root.
   *
   * @returns the free bytes; null when unknown
   */
  freeBytes(): Promise<number | null>;
}
