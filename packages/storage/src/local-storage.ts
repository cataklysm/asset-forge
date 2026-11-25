import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import {
  LAYOUT_DIRS,
  PathEscapeError,
  StorageAccessDeniedError,
  StorageFullError,
  type Storage,
} from '@assetforge/core';

function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

const ACCESS_DENIED_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

/**
 * Maps permission and disk-full failures to domain errors that the UI can explain.
 * Node's own messages contain absolute paths, so the message names only the relative
 * path; the original error stays available as `cause`. Everything else is returned as is.
 */
function translateFsError(err: unknown, relPath: string): unknown {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const target = relPath === '' ? 'the workspace folder' : relPath;
  if (code !== undefined && ACCESS_DENIED_CODES.has(code)) {
    return new StorageAccessDeniedError(`No permission to access ${target}`, { cause: err });
  }
  if (code === 'ENOSPC') {
    return new StorageFullError(`Not enough free space to write ${target}`, { cause: err });
  }
  return err;
}

const WINDOWS = process.platform === 'win32';

function isInside(root: string, target: string): boolean {
  const rel = path.relative(WINDOWS ? root.toLowerCase() : root, WINDOWS ? target.toLowerCase() : target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolves the real path of `p` by following links on the deepest existing
 * ancestor and re-appending the not-yet-existing remainder. A dangling link
 * is treated as an escape because creating through it would write to its
 * target.
 */
async function realpathOfDeepestAncestor(p: string): Promise<string> {
  const remainder: string[] = [];
  let current = p;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return path.join(real, ...remainder);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      try {
        await fs.lstat(current);
        throw new PathEscapeError(`Path crosses a dangling link: ${current}`);
      } catch (lstatErr) {
        if (lstatErr instanceof PathEscapeError) throw lstatErr;
        if (!isNotFound(lstatErr)) throw lstatErr;
      }
      const parent = path.dirname(current);
      if (parent === current) throw err;
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}

export class LocalFileSystemStorage implements Storage {
  private readonly root: string;

  constructor(rootPath: string) {
    this.root = path.resolve(rootPath);
  }

  async isReachable(): Promise<boolean> {
    for (const candidate of [this.root, path.dirname(this.root)]) {
      try {
        return (await fs.stat(candidate)).isDirectory();
      } catch (err) {
        if (!isNotFound(err)) return false;
        if (candidate === this.root) continue;
      }
    }
    return false;
  }

  isEmptyOrMissing(): Promise<boolean> {
    return this.guarded('', async () => {
      try {
        return (await fs.readdir(this.root)).length === 0;
      } catch (err) {
        if (isNotFound(err)) return true;
        throw err;
      }
    });
  }

  ensureLayout(): Promise<void> {
    return this.guarded('', async () => {
      await fs.mkdir(this.root, { recursive: true });
      for (const dir of LAYOUT_DIRS) {
        await fs.mkdir(await this.resolve(dir), { recursive: true });
      }
    });
  }

  readText(relPath: string): Promise<string | null> {
    return this.guarded(relPath, async () => {
      const abs = await this.resolve(relPath);
      try {
        return await fs.readFile(abs, 'utf8');
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    });
  }

  writeText(relPath: string, text: string): Promise<void> {
    return this.guarded(relPath, async () => {
      const abs = await this.resolve(relPath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const tmp = path.join(path.dirname(abs), `${path.basename(abs)}.${randomUUID()}.tmp`);
      try {
        // Flush before the rename: otherwise a crash can leave the renamed file
        // (e.g. workspace.json) truncated or zeroed.
        await fs.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx', flush: true });
        await fs.rename(tmp, abs);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
    });
  }

  writeStream(relPath: string, source: Readable): Promise<{ sizeBytes: number; sha256: string }> {
    // A failing source is the source's problem, not the workspace storage's: pass it through.
    let sourceError: unknown;
    source.once('error', (err) => {
      sourceError = err;
    });
    return this.guarded(
      relPath,
      async () => {
        const abs = await this.resolve(relPath);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        // 'wx' fails if the target exists, so an existing file is never touched
        // (and never removed by the cleanup below).
        const handle = await fs.open(abs, 'wx');
        const hash = createHash('sha256');
        let sizeBytes = 0;
        const hasher = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            hash.update(chunk);
            sizeBytes += chunk.length;
            cb(null, chunk);
          },
        });
        try {
          // `flush` fsyncs before the handle closes. The caller verifies, moves and marks
          // the file complete right after this resolves; without the flush a power loss
          // could leave a `complete` row pointing at a truncated or zeroed file.
          await pipeline(source, hasher, handle.createWriteStream({ flush: true }));
        } catch (err) {
          await handle.close().catch(() => undefined);
          await fs.rm(abs, { force: true }).catch(() => undefined);
          throw err;
        }
        return { sizeBytes, sha256: hash.digest('hex') };
      },
      (err) => err === sourceError,
    );
  }

  hashFile(relPath: string): Promise<string> {
    return this.guarded(relPath, async () => {
      const abs = await this.resolve(relPath);
      const hash = createHash('sha256');
      await pipeline(createReadStream(abs), hash);
      return hash.digest('hex');
    });
  }

  move(from: string, to: string): Promise<void> {
    return this.guarded(to, async () => {
      const src = await this.resolve(from);
      const dst = await this.resolve(to);
      if (await this.pathExists(dst)) {
        throw Object.assign(new Error(`Target already exists: ${to}`), { code: 'EEXIST' });
      }
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.rename(src, dst);
    });
  }

  exists(relPath: string): Promise<boolean> {
    return this.guarded(relPath, async () => this.pathExists(await this.resolve(relPath, true)));
  }

  remove(relPath: string): Promise<void> {
    return this.guarded(relPath, async () => {
      await fs.rm(await this.resolve(relPath), { force: true });
    });
  }

  list(relDir: string): Promise<string[]> {
    return this.guarded(relDir, async () => {
      const abs = await this.resolve(relDir, true);
      try {
        return await fs.readdir(abs);
      } catch (err) {
        if (isNotFound(err)) return [];
        throw err;
      }
    });
  }

  /** The single place where file-system failures are translated (see `translateFsError`). */
  private async guarded<T>(
    relPath: string,
    op: () => Promise<T>,
    passThrough: (err: unknown) => boolean = () => false,
  ): Promise<T> {
    try {
      return await op();
    } catch (err) {
      throw passThrough(err) ? err : translateFsError(err, relPath);
    }
  }

  private async pathExists(abs: string): Promise<boolean> {
    try {
      await fs.lstat(abs);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /**
   * The single gate for all workspace paths: rejects absolute forms and `..`
   * segments lexically, then verifies via realpath of the deepest existing
   * ancestor that links/junctions do not lead outside the real root. Paths that
   * reduce to the root itself are only accepted with `allowRoot` (list, exists).
   */
  private async resolve(relPath: string, allowRoot = false): Promise<string> {
    if (
      relPath.includes('\0') ||
      relPath.startsWith('/') ||
      relPath.startsWith('\\') ||
      /^[a-zA-Z]:/.test(relPath)
    ) {
      throw new PathEscapeError(`Absolute path not allowed: ${relPath}`);
    }
    const segments = relPath.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
    if (segments.includes('..')) {
      throw new PathEscapeError(`Path escapes the workspace: ${relPath}`);
    }
    if (segments.length === 0 && !allowRoot) {
      throw new PathEscapeError(`Path resolves to the workspace root: ${JSON.stringify(relPath)}`);
    }
    const target = path.join(this.root, ...segments);
    const realRoot = await realpathOfDeepestAncestor(this.root);
    const realTarget = await realpathOfDeepestAncestor(target);
    if (!isInside(realRoot, realTarget)) {
      throw new PathEscapeError(`Path escapes the workspace: ${relPath}`);
    }
    return target;
  }
}
