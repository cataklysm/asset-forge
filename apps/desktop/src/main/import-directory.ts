import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { writeAtomic } from './atomic-file.js';

/** The file name of the remembered import directory under `userData`. */
export const IMPORT_DIRECTORY_FILE = 'import-directory.json';

/** The directory the file picker of the import opens in. */
export interface ImportDirectoryMemory {
  /** @returns the remembered directory when it is stored well-formed and still exists as a directory. Never throws. */
  current(): string | undefined;
  /**
   * Stores the directory of the first path. Best effort, never throws.
   *
   * @param filePaths the files chosen
   */
  remember(filePaths: readonly string[]): void;
}

/**
 * The stored directory when the file is well-formed.
 *
 * @param filePath the file
 * @returns the absolute directory, or undefined
 */
function readStored(filePath: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { v, directory } = parsed as { v?: unknown; directory?: unknown };
    if (v !== 1 || typeof directory !== 'string' || directory === '' || !isAbsolute(directory)) return undefined;
    return directory;
  } catch {
    return undefined;
  }
}

/**
 * App-level memory of the directory the last import came from; the path never leaves the main process.
 *
 * @param filePath the file it is kept in
 * @returns the memory
 */
export function createImportDirectoryMemory(filePath: string): ImportDirectoryMemory {
  return {
    current: () => currentDirectory(filePath),
    remember: (filePaths) => rememberDirectory(filePath, filePaths),
  };
}

/**
 * The stored directory when it still exists as a directory. Never throws.
 *
 * @param filePath the file it is kept in
 * @returns the directory, or undefined
 */
function currentDirectory(filePath: string): string | undefined {
  const directory = readStored(filePath);
  if (directory === undefined) return undefined;
  try {
    return statSync(directory).isDirectory() ? directory : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stores the directory of the first path unless it is already stored. Best effort, never throws.
 *
 * @param filePath the file it is kept in
 * @param filePaths the files chosen
 */
function rememberDirectory(filePath: string, filePaths: readonly string[]): void {
  const first = filePaths[0];
  if (first === undefined) return;
  try {
    const directory = dirname(first);
    if (readStored(filePath) === directory) return;
    writeAtomic(filePath, JSON.stringify({ v: 1, directory }));
  } catch {
    // Best effort: a failed write only means the picker opens where it would have anyway.
  }
}
