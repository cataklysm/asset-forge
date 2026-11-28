import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** A temporary file this old belongs to a write that will never be renamed. */
const STALE_TMP_MS = 60 * 60 * 1000;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** Reads a directory; a directory that does not exist (any more) is empty. */
async function listOrEmpty<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Unlinks a file; true when it was removed by this call, false when it was already gone. */
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
 */
export async function evictLeastRecentlyUsed(
  dir: string,
  limitBytes: number,
  targetRatio: number,
): Promise<{ removedFiles: number }> {
  const entries: { path: string; size: number; mtimeMs: number }[] = [];
  let removedFiles = 0;
  const staleBefore = Date.now() - STALE_TMP_MS;

  async function walk(current: string): Promise<void> {
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
        await walk(path);
        continue;
      }
      if (!info.isFile()) continue;
      if (name.endsWith('.tmp')) {
        if (info.mtimeMs < staleBefore && (await removeIfPresent(path))) removedFiles++;
        continue;
      }
      entries.push({ path, size: info.size, mtimeMs: info.mtimeMs });
    }
  }
  await walk(dir);

  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= limitBytes) return { removedFiles };
  const target = limitBytes * targetRatio;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (total <= target) break;
    if (await removeIfPresent(entry.path)) removedFiles++;
    total -= entry.size;
  }
  return { removedFiles };
}
