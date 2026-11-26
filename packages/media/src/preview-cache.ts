import { lstat, readdir, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkerPool } from './worker-pool.js';

export type PreviewSize = 'thumb' | 'detail' | 'full';

export const PREVIEW_EDGE: Record<PreviewSize, number> = { thumb: 256, detail: 1024, full: 8192 };
export const PREVIEW_FORMAT_VERSION = 1;
/** Version of the lossless `full` rendition, independent of `PREVIEW_FORMAT_VERSION`. */
export const FULL_FORMAT_VERSION = 1;
export const CACHE_LIMIT_BYTES = 2 * 1024 ** 3;
export const CACHE_TARGET_RATIO = 0.9;
export const CLEANUP_EVERY = 500;
/** Full renditions are large, so they trigger a cleanup far sooner than thumbnails. */
export const FULL_CLEANUP_EVERY = 8;

const DIRECTORIES: Record<PreviewSize, string> = { thumb: 'thumbnails', detail: 'previews', full: 'full' };
const SHA256 = /^[0-9a-f]{64}$/;
/** A temporary file this old belongs to a write that will never be renamed. */
const STALE_TMP_MS = 60 * 60 * 1000;

/** Path relative to the cache root, e.g. `thumbnails/ab/<sha256>-256-v1.webp` or `full/ab/<sha256>-8192-v1.png`. */
export function previewRelativePath(sha256: string, size: PreviewSize): string {
  if (size === 'full') {
    return `${DIRECTORIES.full}/${sha256.slice(0, 2)}/${sha256}-${PREVIEW_EDGE.full}-v${FULL_FORMAT_VERSION}.png`;
  }
  return `${DIRECTORIES[size]}/${sha256.slice(0, 2)}/${sha256}-${PREVIEW_EDGE[size]}-v${PREVIEW_FORMAT_VERSION}.webp`;
}

export interface PreviewRequest {
  sha256: string;
  sourcePath: string;
  size: PreviewSize;
}

export interface PreviewService {
  /** Absolute path of the cached WebP (PNG for `full`), or null for "no preview". Never throws. */
  get(request: PreviewRequest): Promise<string | null>;
  /**
   * Evicts least recently used entries from `thumbnails`, `previews` and `full`, each directory
   * separately against `limitBytes`; concurrent calls share one run. Never throws.
   */
  cleanup(): Promise<void>;
  close(): Promise<void>;
}

export interface PreviewServiceOptions {
  cacheDir: string;
  pool: WorkerPool;
  limitBytes?: number;
  cleanupEvery?: number;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Content-keyed preview cache below `cacheDir`. Previews are generated on demand through the
 * worker pool; identical concurrent requests share one generation. A source that produced no
 * preview is remembered for the session, a source that cannot be reached is not.
 */
export function createPreviewService(options: PreviewServiceOptions): PreviewService {
  const { cacheDir, pool } = options;
  const limitBytes = options.limitBytes ?? CACHE_LIMIT_BYTES;
  const cleanupEvery = options.cleanupEvery ?? CLEANUP_EVERY;
  const failed = new Set<string>();
  const inflight = new Map<string, Promise<string | null>>();
  const newEntries: Record<PreviewSize, number> = { thumb: 0, detail: 0, full: 0 };
  let cleaning: Promise<void> | undefined;
  let closed = false;

  async function resolvePreview(key: string, request: PreviewRequest): Promise<string | null> {
    const targetPath = join(cacheDir, previewRelativePath(request.sha256, request.size));
    if (await exists(targetPath)) {
      const now = new Date();
      await utimes(targetPath, now, now).catch(() => undefined);
      return targetPath;
    }
    if (!(await exists(request.sourcePath))) return null;
    const result = await pool.run({
      sourcePath: request.sourcePath,
      targetPath,
      longestEdge: PREVIEW_EDGE[request.size],
      format: request.size === 'full' ? 'png' : 'webp',
    });
    if (result === 'ok') {
      // Thumbnails and previews share one counter, full renditions have their own.
      const counter = request.size === 'full' ? 'full' : 'thumb';
      newEntries[counter]++;
      if (newEntries[counter] >= (counter === 'full' ? FULL_CLEANUP_EVERY : cleanupEvery)) {
        newEntries[counter] = 0;
        void cleanup();
      }
      return targetPath;
    }
    // A pool that was closed or a source that vanished meanwhile says nothing about the content.
    if (!closed && (await exists(request.sourcePath))) failed.add(key);
    return null;
  }

  function cleanup(): Promise<void> {
    cleaning ??= (async () => {
      // Each directory has its own budget (ReadMe §15.3).
      for (const directory of Object.values(DIRECTORIES)) {
        await evictLeastRecentlyUsed(join(cacheDir, directory), limitBytes, CACHE_TARGET_RATIO).catch(
          () => undefined,
        );
      }
    })().finally(() => {
      cleaning = undefined;
    });
    return cleaning;
  }

  return {
    get(request) {
      if (closed || !SHA256.test(request.sha256) || !(request.size in PREVIEW_EDGE)) {
        return Promise.resolve(null);
      }
      const key = `${request.sha256}:${request.size}`;
      if (failed.has(key)) return Promise.resolve(null);
      const running = inflight.get(key);
      if (running) return running;
      const promise = resolvePreview(key, request)
        .catch(() => null)
        .finally(() => inflight.delete(key));
      inflight.set(key, promise);
      return promise;
    },
    cleanup,
    async close() {
      closed = true;
      await pool.close();
      await cleaning;
    },
  };
}

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
