import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { LAYOUT_DIRS, PathEscapeError, type Storage } from '@assetforge/core';

function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
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

  async isEmptyOrMissing(): Promise<boolean> {
    try {
      return (await fs.readdir(this.root)).length === 0;
    } catch (err) {
      if (isNotFound(err)) return true;
      throw err;
    }
  }

  async ensureLayout(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    for (const dir of LAYOUT_DIRS) {
      await fs.mkdir(await this.resolve(dir), { recursive: true });
    }
  }

  async readText(relPath: string): Promise<string | null> {
    const abs = await this.resolve(relPath);
    try {
      return await fs.readFile(abs, 'utf8');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async writeText(relPath: string, text: string): Promise<void> {
    const abs = await this.resolve(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = path.join(path.dirname(abs), `${path.basename(abs)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(tmp, abs);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async writeStream(
    relPath: string,
    source: Readable,
  ): Promise<{ sizeBytes: number; sha256: string }> {
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
      await pipeline(source, hasher, handle.createWriteStream());
    } catch (err) {
      await handle.close().catch(() => undefined);
      await fs.rm(abs, { force: true }).catch(() => undefined);
      throw err;
    }
    return { sizeBytes, sha256: hash.digest('hex') };
  }

  async hashFile(relPath: string): Promise<string> {
    const abs = await this.resolve(relPath);
    const hash = createHash('sha256');
    await pipeline(createReadStream(abs), hash);
    return hash.digest('hex');
  }

  async move(from: string, to: string): Promise<void> {
    const src = await this.resolve(from);
    const dst = await this.resolve(to);
    if (await this.pathExists(dst)) {
      throw Object.assign(new Error(`Target already exists: ${to}`), { code: 'EEXIST' });
    }
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
  }

  async exists(relPath: string): Promise<boolean> {
    return this.pathExists(await this.resolve(relPath, true));
  }

  async remove(relPath: string): Promise<void> {
    await fs.rm(await this.resolve(relPath), { force: true });
  }

  async list(relDir: string): Promise<string[]> {
    const abs = await this.resolve(relDir, true);
    try {
      return await fs.readdir(abs);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
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
