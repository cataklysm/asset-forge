import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** A temporary file this old belongs to a write that will never be renamed. */
const STALE_TMP_MS = 60 * 60 * 1000;

/** One cached file that counts towards a directory's total. */
interface CacheEntry {
  /** The file's absolute path. */
  path: string;
  /** Its size in bytes. */
  size: number;
  /** Its modification time, which the cache bumps on every hit. */
  mtimeMs: number;
}

/** What one walk over a cache directory collects. */
interface WalkState {
  /** The files that count towards the total. */
  entries: CacheEntry[];
  /** Files removed so far: stale temporary files during the walk, evicted entries after it. */
  removedFiles: number;
  /** A temporary file modified before this time is stale. */
  staleBefore: number;
}

/**
 * Whether a file system error says the path does not exist.
 *
 * @param error what the call threw
 * @returns true for `ENOENT`
 */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Reads a directory; a directory that does not exist (any more) is empty.
 *
 * @param read reads the directory
 * @returns the names in it, or none for a missing directory
 */
async function listOrEmpty<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/**
 * Unlinks a file.
 *
 * @param path the file
 * @returns true when it was removed by this call, false when it was already gone
 */
async function removeIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/**
 * Walks `dir` recursively (including its two-character shard directories) as one LRU set.
 * Deletes temporary files older than one hour, then, if the remaining entries exceed
 * `limitBytes`, deletes the least recently used (oldest mtime) until the total is at most
 * `limitBytes * targetRatio`. Temporary files never count towards the total. Files that vanish
 * during the walk are skipped.
 *
 * @param dir the cache directory
 * @param limitBytes the directory's budget
 * @param targetRatio the share of the budget an eviction trims down to
 * @returns how many files were removed
 */
export async function evictLeastRecentlyUsed(
  dir: string,
  limitBytes: number,
  targetRatio: number,
): Promise<{ removedFiles: number }> {
  const state: WalkState = { entries: [], removedFiles: 0, staleBefore: Date.now() - STALE_TMP_MS };
  await walk(dir, state);

  let total = state.entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= limitBytes) return { removedFiles: state.removedFiles };
  const target = limitBytes * targetRatio;
  state.entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of state.entries) {
    if (total <= target) break;
    if (await removeIfPresent(entry.path)) state.removedFiles++;
    total -= entry.size;
  }
  return { removedFiles: state.removedFiles };
}

/**
 * Collects the files below one directory and removes its stale temporary files.
 *
 * @param current the directory walked now
 * @param state what the walk collects
 * @returns resolves once the directory and everything below it is walked
 */
async function walk(current: string, state: WalkState): Promise<void> {
  for (const name of await listOrEmpty(() => readdir(current))) {
    const path = join(current, name);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    // lstat: symbolic links and junctions are neither followed nor counted.
    if (info.isDirectory()) {
      await walk(path, state);
      continue;
    }
    if (!info.isFile()) continue;
    if (name.endsWith('.tmp')) {
      if (info.mtimeMs < state.staleBefore && (await removeIfPresent(path))) state.removedFiles++;
      continue;
    }
    state.entries.push({ path, size: info.size, mtimeMs: info.mtimeMs });
  }
}
