import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PathEscapeError } from '@assetforge/core';
import { isNotFound } from './fs-errors.js';

/** Paths on Windows are compared regardless of case. */
const WINDOWS = process.platform === 'win32';

/** How often an entry that exists but could not be resolved is looked at again before it counts as dangling. */
const MAX_LOOKS_AGAIN = 3;

/**
 * The lexical half of the path gate: rejects absolute forms and `..` segments. Paths that reduce to the root itself
 * are only accepted with `allowRoot` (list, exists).
 *
 * @param relativePath the workspace path as given
 * @param allowRoot whether a path that reduces to the root is accepted
 * @returns the path's segments without empty and `.` segments
 * @throws PathEscapeError for an absolute form, a NUL, a `..` segment or a refused root
 */
export function workspaceSegments(relativePath: string, allowRoot: boolean): string[] {
  if (
    relativePath.includes('\0') ||
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\') ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    throw new PathEscapeError('Absolute path not allowed');
  }
  const segments = relativePath.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw new PathEscapeError('Path escapes the workspace');
  }
  if (segments.length === 0 && !allowRoot) {
    throw new PathEscapeError('Path resolves to the workspace root');
  }
  return segments;
}

/**
 * Whether a path lies inside a root (or is the root).
 *
 * @param root an absolute path
 * @param target an absolute path
 * @returns true when `target` is `root` or below it
 */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(WINDOWS ? root.toLowerCase() : root, WINDOWS ? target.toLowerCase() : target);
  if (relative === '') return true;
  // Only a whole `..` segment leaves the root; a name such as `..config` stays inside.
  const leavesRoot = relative === '..' || relative.startsWith(`..${path.sep}`);
  return !leavesRoot && !path.isAbsolute(relative);
}

/**
 * Resolves the real path of `targetPath` by following links on the deepest existing
 * ancestor and re-appending the not-yet-existing remainder. A dangling link
 * is treated as an escape because creating through it would write to its
 * target. An entry that another writer created between the two looks (a
 * directory made by a concurrent move) is looked at again, a few times at most.
 *
 * @param targetPath an absolute path
 * @returns the real path
 * @throws PathEscapeError when the path crosses a dangling link
 */
export async function realpathOfDeepestAncestor(targetPath: string): Promise<string> {
  const remainder: string[] = [];
  let current = targetPath;
  let lookedAgain = 0;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return path.join(real, ...remainder);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      let found: Stats | null = null;
      try {
        found = await fs.lstat(current);
      } catch (lstatError) {
        if (!isNotFound(lstatError)) throw lstatError;
      }
      if (found !== null) {
        if (found.isSymbolicLink() || lookedAgain >= MAX_LOOKS_AGAIN) {
          throw new PathEscapeError('Path crosses a dangling link');
        }
        lookedAgain += 1;
        continue;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}
