import { TRASH_DIR } from './paths.js';
import type { FileRepository } from './ports/file-repositories.js';
import type { Storage } from './ports/storage.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Startup cleanup of the trash directory: an entry named `<file id>_…` whose id has a purge
 * tombstone and no row is a binary left behind by a purge and is removed. Every other entry stays,
 * also one without row and tombstone. A tombstone is deleted once no entry of its id is left. Does
 * nothing while the storage is unreachable. Never throws.
 */
export async function sweepTrash(ctx: {
  storage: Storage;
  files: Pick<FileRepository, 'get' | 'listPurgedIds' | 'forgetPurge'>;
}): Promise<{ removed: string[]; skipped: string[] }> {
  const result = { removed: [] as string[], skipped: [] as string[] };
  let purged: Set<string>;
  let entries: string[];
  try {
    if (!(await ctx.storage.isReachable())) return result;
    purged = new Set(await ctx.files.listPurgedIds());
    if (purged.size === 0) return result;
    entries = await ctx.storage.list(TRASH_DIR);
  } catch {
    return result;
  }
  const left = new Set<string>();
  for (const name of entries) {
    const id = name.slice(0, 36);
    if (!UUID.test(id) || name[36] !== '_' || !purged.has(id)) continue;
    const path = `${TRASH_DIR}/${name}`;
    try {
      if ((await ctx.files.get(id)) !== null) {
        left.add(id);
        continue;
      }
      await ctx.storage.remove(path);
      result.removed.push(path);
    } catch {
      left.add(id);
      result.skipped.push(path);
    }
  }
  for (const id of purged) {
    if (left.has(id)) continue;
    try {
      // A share that dropped while sweeping lists nothing; never take that for "already gone".
      if (!(await ctx.storage.isReachable())) return result;
      await ctx.files.forgetPurge(id);
    } catch {
      // The tombstone stays for the next sweep.
    }
  }
  return result;
}
