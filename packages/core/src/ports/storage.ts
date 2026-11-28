import type { Readable } from 'node:stream';

export interface Storage {
  isReachable(): Promise<boolean>; // root's parent volume/dir is accessible
  isEmptyOrMissing(): Promise<boolean>; // root does not exist or has no entries
  ensureLayout(): Promise<void>; // creates root and LAYOUT_DIRS
  readText(relPath: string): Promise<string | null>; // null if missing
  writeText(relPath: string, text: string): Promise<void>; // atomic: temp file + rename
  /** `onProgress` receives the cumulative number of bytes as chunks are written. */
  writeStream(
    relPath: string,
    source: Readable,
    options?: { onProgress?(bytesWritten: number): void },
  ): Promise<{ sizeBytes: number; sha256: string }>;
  hashFile(relPath: string): Promise<string>; // lowercase hex SHA-256
  move(from: string, to: string): Promise<void>; // rejects if `to` exists
  exists(relPath: string): Promise<boolean>;
  remove(relPath: string): Promise<void>; // no-op if missing
  list(relDir: string): Promise<string[]>; // entry names; [] if dir missing
  /** Absolute path of a path inside the storage root; validated like every other operation. Never sent to the renderer. */
  absolutePath(relativePath: string): Promise<string>;
  /** Free bytes of the volume holding the storage root; null when unknown. */
  freeBytes(): Promise<number | null>;
}
