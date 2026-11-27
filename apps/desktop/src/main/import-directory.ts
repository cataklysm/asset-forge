import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { writeAtomic } from './atomic-file.js';

export const IMPORT_DIRECTORY_FILE = 'import-directory.json';

export interface ImportDirectoryMemory {
  /** The remembered directory when it is stored well-formed and still exists as a directory. Never throws. */
  current(): string | undefined;
  /** Stores the directory of the first path. Best effort, never throws. */
  remember(filePaths: readonly string[]): void;
}

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

/** App-level memory of the directory the last import came from; the path never leaves the main process. */
export function createImportDirectoryMemory(filePath: string): ImportDirectoryMemory {
  const current = (): string | undefined => {
    const directory = readStored(filePath);
    if (directory === undefined) return undefined;
    try {
      return statSync(directory).isDirectory() ? directory : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    current,
    remember(filePaths) {
      const first = filePaths[0];
      if (first === undefined) return;
      try {
        const directory = dirname(first);
        if (readStored(filePath) === directory) return;
        writeAtomic(filePath, JSON.stringify({ v: 1, directory }));
      } catch {
        // Best effort: a failed write only means the picker opens where it would have anyway.
      }
    },
  };
}
