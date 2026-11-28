import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { LAYOUT_DIRS, PathEscapeError, type Storage } from '@assetforge/core';
import { isNotFound, translateFsError } from './fs-errors.js';
import { StreamWrite, type WrittenFile } from './stream-write.js';
import { isInside, realpathOfDeepestAncestor, workspaceSegments } from './workspace-paths.js';

/** What `writeStream` is asked with besides the path and the source. */
interface WriteStreamOptions {
  /** Told the cumulative bytes written after every chunk; a throw is ignored. */
  onProgress?(bytesWritten: number): void;
}

/**
 * The `Storage` of a workspace folder on a local disk or a mounted share. Every path goes through one gate that
 * keeps it inside the workspace, and every file-system failure is translated in one place.
 */
export class LocalFileSystemStorage implements Storage {
  /** The workspace folder as an absolute path. */
  private readonly root: string;

  /**
   * @param rootPath the workspace folder
   */
  constructor(rootPath: string) {
    this.root = path.resolve(rootPath);
  }

  /**
   * Whether the storage can be reached: the root, or while it does not exist yet its parent, is a directory.
   *
   * @returns true when reachable; false for any failure other than a missing root
   */
  async isReachable(): Promise<boolean> {
    for (const candidate of [this.root, path.dirname(this.root)]) {
      try {
        return (await fs.stat(candidate)).isDirectory();
      } catch (error) {
        if (!isNotFound(error)) return false;
        if (candidate === this.root) continue;
      }
    }
    return false;
  }

  /**
   * Whether the root holds nothing.
   *
   * @returns true for an empty or missing root
   */
  isEmptyOrMissing(): Promise<boolean> {
    return this.guarded('', async () => {
      try {
        return (await fs.readdir(this.root)).length === 0;
      } catch (error) {
        if (isNotFound(error)) return true;
        throw error;
      }
    });
  }

  /**
   * Creates the root and the directories of `LAYOUT_DIRS`.
   *
   * @returns resolves once they exist
   */
  ensureLayout(): Promise<void> {
    return this.guarded('', async () => {
      await fs.mkdir(this.root, { recursive: true });
      for (const directory of LAYOUT_DIRS) {
        await fs.mkdir(await this.resolve(directory), { recursive: true });
      }
    });
  }

  /**
   * Reads a text file as UTF-8.
   *
   * @param relativePath the workspace path
   * @returns the text; null when the file does not exist
   */
  readText(relativePath: string): Promise<string | null> {
    return this.guarded(relativePath, async () => {
      const absolutePath = await this.resolve(relativePath);
      try {
        return await fs.readFile(absolutePath, 'utf8');
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    });
  }

  /**
   * Replaces a text file atomically: written to a temporary file beside it, flushed, then renamed over it.
   *
   * @param relativePath the workspace path
   * @param text the content
   * @returns resolves once the file holds the text
   */
  writeText(relativePath: string, text: string): Promise<void> {
    return this.guarded(relativePath, async () => {
      const absolutePath = await this.resolve(relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      const temporaryPath = path.join(path.dirname(absolutePath), `${path.basename(absolutePath)}.${randomUUID()}.tmp`);
      try {
        // Flush before the rename: otherwise a crash can leave the renamed file
        // (e.g. workspace.json) truncated or zeroed.
        await fs.writeFile(temporaryPath, text, { encoding: 'utf8', flag: 'wx', flush: true });
        await fs.rename(temporaryPath, absolutePath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * Writes a stream into a new file, hashing it on the way. An existing file is never touched.
   *
   * @param relativePath the workspace path of the new file
   * @param source the bytes; destroyed when the file cannot be opened
   * @param options the progress observer
   * @returns the size and checksum; a failing source rejects with the source's own error
   */
  writeStream(relativePath: string, source: Readable, options: WriteStreamOptions = {}): Promise<WrittenFile> {
    const write = new StreamWrite(source, options.onProgress);
    return this.guarded(
      relativePath,
      () => this.writeNewFile(relativePath, write),
      (error) => write.isSourceFailure(error),
    );
  }

  /**
   * The SHA-256 of a file.
   *
   * @param relativePath the workspace path
   * @returns the checksum as lower-case hex
   */
  hashFile(relativePath: string): Promise<string> {
    return this.guarded(relativePath, async () => {
      const absolutePath = await this.resolve(relativePath);
      const hash = createHash('sha256');
      await pipeline(createReadStream(absolutePath), hash);
      return hash.digest('hex');
    });
  }

  /**
   * Moves a file within the workspace; the target must not exist.
   *
   * @param from the workspace path of the file
   * @param to the workspace path it moves to
   * @returns resolves once it moved; rejects with an `EEXIST` error when the target exists. A failed rename removes
   *   the directories this call created for the target again.
   */
  move(from: string, to: string): Promise<void> {
    return this.guarded(to, async () => {
      const sourcePath = await this.resolve(from);
      const targetPath = await this.resolve(to);
      if (await this.pathExists(targetPath)) {
        // A fixed text: the caller maps it to its own message, and a path never belongs in an error.
        throw Object.assign(new Error('The target already exists'), { code: 'EEXIST' });
      }
      const created = await missingDirectories(path.dirname(targetPath));
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      try {
        await fs.rename(sourcePath, targetPath);
      } catch (error) {
        await removeEmptyDirectories(created);
        throw error;
      }
    });
  }

  /**
   * Whether an entry exists, a dangling link included.
   *
   * @param relativePath the workspace path; the root is accepted
   * @returns true when it exists
   */
  exists(relativePath: string): Promise<boolean> {
    return this.guarded(relativePath, async () => this.pathExists(await this.resolve(relativePath, true)));
  }

  /**
   * Removes a file; a missing one is no failure.
   *
   * @param relativePath the workspace path
   * @returns resolves once it is gone
   */
  remove(relativePath: string): Promise<void> {
    return this.guarded(relativePath, async () => {
      await fs.rm(await this.resolve(relativePath), { force: true });
    });
  }

  /**
   * The names in a directory.
   *
   * @param relativeDirectory the workspace path; the root is accepted
   * @returns the names; empty for a missing directory
   */
  list(relativeDirectory: string): Promise<string[]> {
    return this.guarded(relativeDirectory, async () => {
      const absolutePath = await this.resolve(relativeDirectory, true);
      try {
        return await fs.readdir(absolutePath);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
    });
  }

  /**
   * The absolute path of a workspace path, after the gate.
   *
   * @param relativePath the workspace path
   * @returns the absolute path
   */
  absolutePath(relativePath: string): Promise<string> {
    return this.guarded(relativePath, () => this.resolve(relativePath, false));
  }

  /**
   * Free bytes for this user on the volume of the root, measured on the root or its nearest existing parent.
   * Null when nothing can be measured: a storage that cannot tell never blocks a download.
   *
   * @returns the free bytes, or null
   */
  async freeBytes(): Promise<number | null> {
    let candidate = this.root;
    for (;;) {
      try {
        const stats = await fs.statfs(candidate);
        return Number(stats.bavail) * Number(stats.bsize);
      } catch (error) {
        const parent = path.dirname(candidate);
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === candidate) return null;
        candidate = parent;
      }
    }
  }

  /**
   * The body of `writeStream`: opens the new file, pipes the source through the hasher into it and removes the
   * file again when the pipe fails.
   *
   * @param relativePath the workspace path of the new file
   * @param write the source and its hashing state
   * @returns the size and checksum
   */
  private async writeNewFile(relativePath: string, write: StreamWrite): Promise<WrittenFile> {
    let handle: fs.FileHandle;
    let absolutePath: string;
    try {
      absolutePath = await this.resolve(relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      // 'wx' fails if the target exists, so an existing file is never touched
      // (and never removed by the cleanup below).
      handle = await fs.open(absolutePath, 'wx');
    } catch (error) {
      write.source.destroy();
      throw error;
    }
    const hasher = write.hasher();
    try {
      // `flush` fsyncs before the handle closes. The caller verifies, moves and marks
      // the file complete right after this resolves; without the flush a power loss
      // could leave a `complete` row pointing at a truncated or zeroed file.
      const out = handle.createWriteStream({ flush: true });
      write.watchDestination(out);
      await pipeline(write.source, hasher, out);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.rm(absolutePath, { force: true }).catch(() => undefined);
      throw error;
    }
    return write.written();
  }

  /**
   * The single place where file-system failures are translated (see `translateFsError`).
   *
   * @param relativePath the workspace path named in a translated message
   * @param operation the work
   * @param passThrough errors for which it answers true are rethrown untranslated
   * @returns what the work resolved with
   */
  private async guarded<T>(
    relativePath: string,
    operation: () => Promise<T>,
    passThrough: (error: unknown) => boolean = () => false,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw passThrough(error) ? error : translateFsError(error, relativePath);
    }
  }

  /**
   * Whether an entry exists, without following a link.
   *
   * @param absolutePath the path
   * @returns true when it exists
   */
  private async pathExists(absolutePath: string): Promise<boolean> {
    try {
      await fs.lstat(absolutePath);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /**
   * The single gate for all workspace paths: rejects absolute forms and `..`
   * segments lexically, then verifies via realpath of the deepest existing
   * ancestor that links/junctions do not lead outside the real root. Paths that
   * reduce to the root itself are only accepted with `allowRoot` (list, exists).
   *
   * @param relativePath the workspace path
   * @param allowRoot whether a path that reduces to the root is accepted
   * @returns the absolute path below the root
   * @throws PathEscapeError when the path leaves the workspace
   */
  private async resolve(relativePath: string, allowRoot = false): Promise<string> {
    const segments = workspaceSegments(relativePath, allowRoot);
    const target = path.join(this.root, ...segments);
    const realRoot = await realpathOfDeepestAncestor(this.root);
    const realTarget = await realpathOfDeepestAncestor(target);
    if (!isInside(realRoot, realTarget)) {
      throw new PathEscapeError('Path escapes the workspace');
    }
    return target;
  }
}

/**
 * The directories that a recursive `mkdir` of `directory` would create: `directory` and its parents up to the
 * nearest one that exists. Their own answer of `mkdir` is not used because on Windows it comes back as a `\\?\`
 * path.
 *
 * @param directory an absolute path
 * @returns the missing directories, the deepest first; empty when `directory` exists
 */
async function missingDirectories(directory: string): Promise<string[]> {
  const missing: string[] = [];
  for (let current = directory; ; current = path.dirname(current)) {
    try {
      await fs.lstat(current);
      return missing;
    } catch (error) {
      if (!isNotFound(error)) return missing;
    }
    if (path.dirname(current) === current) return missing;
    missing.push(current);
  }
}

/**
 * Removes directories that a failed move created, in the given order. Only empty directories go (`rmdir`), so
 * whatever another writer put there in the meantime stays; the first failure ends the walk, and no failure is
 * reported.
 *
 * @param directories the directories, the deepest first
 * @returns resolves once the walk ended
 */
async function removeEmptyDirectories(directories: readonly string[]): Promise<void> {
  for (const directory of directories) {
    try {
      await fs.rmdir(directory);
    } catch {
      return;
    }
  }
}
