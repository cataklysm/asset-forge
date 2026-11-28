import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PathEscapeError } from '@assetforge/core';
import { isNotFound } from './fs-errors.js';

const WINDOWS = process.platform === 'win32';

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(WINDOWS ? root.toLowerCase() : root, WINDOWS ? target.toLowerCase() : target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** How often an entry that exists but could not be resolved is looked at again before it counts as dangling. */
const MAX_LOOKS_AGAIN = 3;

/**
 * Resolves the real path of `p` by following links on the deepest existing
 * ancestor and re-appending the not-yet-existing remainder. A dangling link
 * is treated as an escape because creating through it would write to its
 * target. An entry that another writer created between the two looks (a
 * directory made by a concurrent move) is looked at again, a few times at most.
 */
export async function realpathOfDeepestAncestor(p: string): Promise<string> {
  const remainder: string[] = [];
  let current = p;
  let lookedAgain = 0;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return path.join(real, ...remainder);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      let found: Stats | null = null;
      try {
        found = await fs.lstat(current);
      } catch (lstatErr) {
        if (!isNotFound(lstatErr)) throw lstatErr;
      }
      if (found !== null) {
        if (found.isSymbolicLink() || lookedAgain >= MAX_LOOKS_AGAIN) {
          throw new PathEscapeError('Path crosses a dangling link');
        }
        lookedAgain += 1;
        continue;
      }
      const parent = path.dirname(current);
      if (parent === current) throw err;
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}
