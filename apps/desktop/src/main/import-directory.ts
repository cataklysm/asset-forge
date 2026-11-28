import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, posix, win32 } from 'node:path';
import { writeAtomic } from './atomic-file.js';

/** The file name of the remembered import directory under `userData`. */
export const IMPORT_DIRECTORY_FILE = 'import-directory.json';

/** The directory the file picker of the import opens in. */
export interface ImportDirectoryMemory {
  /**
   * @returns the remembered directory when it is stored well-formed and still exists as a directory, checked
   *   within a short limit. Never rejects.
   */
  current(): Promise<string | undefined>;
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
 * How long the picker waits for the remembered directory to be checked. A disconnected mapped drive or an
 * unreachable share can hold a check for seconds; the picker then opens where it would have anyway.
 */
export const DIRECTORY_CHECK_TIMEOUT_MS = 1000;

/** What the memory needs besides its file; the defaults check the real file system. */
export interface ImportDirectoryOptions {
  /** Whether a path is an existing directory; may reject. */
  isDirectory?: (path: string) => Promise<boolean>;
  /** How long a check may take before the directory counts as gone. */
  timeoutMs?: number;
  /** The platform whose path rules decide whether two spellings name the same directory. */
  platform?: NodeJS.Platform;
}

/**
 * App-level memory of the directory the last import came from; the path never leaves the main process.
 *
 * @param filePath the file it is kept in
 * @param options the directory check and its limit
 * @returns the memory
 */
export function createImportDirectoryMemory(
  filePath: string,
  options: ImportDirectoryOptions = {},
): ImportDirectoryMemory {
  const check: DirectoryCheck = {
    isDirectory: options.isDirectory ?? isDirectoryOnDisk,
    timeoutMs: options.timeoutMs ?? DIRECTORY_CHECK_TIMEOUT_MS,
    inFlight: new Map(),
  };
  const platform = options.platform ?? process.platform;
  return {
    current: () => currentDirectory(filePath, check),
    remember: (filePaths) => rememberDirectory(filePath, filePaths, platform),
  };
}

/** The directory check with its limit, options resolved. */
interface DirectoryCheck {
  /** Whether a path is an existing directory; may reject. */
  isDirectory: (path: string) => Promise<boolean>;
  /** How long a check may take. */
  timeoutMs: number;
  /**
   * The check still running per directory. A check that outlived its limit stays here until it settles, so a hung
   * share holds one file system request rather than one per opened picker.
   */
  inFlight: Map<string, Promise<boolean>>;
}

/**
 * Whether a path is an existing directory on disk, checked without blocking the event loop.
 *
 * @param path the path
 * @returns true for a directory, false for anything else or a failed check
 */
async function isDirectoryOnDisk(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The stored directory when it still exists as a directory and the check answers in time. Never rejects.
 *
 * @param filePath the file it is kept in
 * @param check the directory check and its limit
 * @returns the directory, or undefined
 */
async function currentDirectory(filePath: string, check: DirectoryCheck): Promise<string | undefined> {
  const directory = readStored(filePath);
  if (directory === undefined) return undefined;
  return (await withinLimit(check, directory)) ? directory : undefined;
}

/**
 * Runs the directory check, counting a rejection or an answer later than the limit as false.
 *
 * @param check the directory check and its limit
 * @param directory the directory to check
 * @returns whether the directory exists, as far as the check could tell in time
 */
function withinLimit(check: DirectoryCheck, directory: string): Promise<boolean> {
  const running = sharedCheck(check, directory);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), check.timeoutMs);
    void running.then((isDirectory) => {
      clearTimeout(timer);
      resolve(isDirectory);
    });
  });
}

/**
 * The running check of a directory, started when none runs. It never rejects and leaves the map when it settles.
 *
 * @param check the directory check and the checks in flight
 * @param directory the directory to check
 * @returns whether the directory exists; false for a rejection or a throw
 */
function sharedCheck(check: DirectoryCheck, directory: string): Promise<boolean> {
  const existing = check.inFlight.get(directory);
  if (existing) return existing;
  const running = Promise.resolve()
    .then(() => check.isDirectory(directory))
    .catch(() => false)
    .finally(() => check.inFlight.delete(directory));
  check.inFlight.set(directory, running);
  return running;
}

/**
 * Stores the directory of the first path unless the same directory is already stored. Best effort, never throws.
 *
 * @param filePath the file it is kept in
 * @param filePaths the files chosen
 * @param platform the platform whose path rules compare the spellings
 */
function rememberDirectory(filePath: string, filePaths: readonly string[], platform: NodeJS.Platform): void {
  const first = filePaths[0];
  if (first === undefined) return;
  try {
    const directory = dirname(first);
    const stored = readStored(filePath);
    if (stored !== undefined && isSameDirectory(stored, directory, platform)) return;
    writeAtomic(filePath, JSON.stringify({ v: 1, directory }));
  } catch {
    // Best effort: a failed write only means the picker opens where it would have anyway.
  }
}

/**
 * Whether two absolute spellings name the same directory: resolved, without a trailing separator and, on Windows,
 * regardless of case and of the separator used.
 *
 * @param first one spelling
 * @param second the other spelling
 * @param platform the platform whose path rules apply
 * @returns true when both name the same directory
 */
export function isSameDirectory(first: string, second: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return posix.resolve(first) === posix.resolve(second);
  return win32.resolve(first).toLowerCase() === win32.resolve(second).toLowerCase();
}
