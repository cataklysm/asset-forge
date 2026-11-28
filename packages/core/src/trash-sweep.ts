import { TRASH_DIR } from './paths.js';
import type { FileRepository } from './ports/file-repositories.js';
import type { Storage } from './ports/storage.js';

/** What the sweep of the trash directory reads and writes. */
export interface TrashSweepDependencies {
  storage: Storage;
  files: Pick<FileRepository, 'get' | 'listPurgedIds' | 'forgetPurge'>;
}

/** The outcome of a sweep: the relative paths removed and those that could not be removed. */
type SweepResult = { removed: string[]; skipped: string[] };

/** A file id as it starts a trash entry name. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Startup cleanup of the trash directory: an entry named `<file id>_…` whose id has a purge
 * tombstone and no row is a binary left behind by a purge and is removed. Every other entry stays,
 * also one without row and tombstone. A tombstone is deleted once no entry of its id is left. Does
 * nothing while the storage is unreachable. Never throws.
 *
 * @param dependencies the storage and the files of the workspace
 * @returns the relative paths removed and those skipped after a failure
 */
export async function sweepTrash(dependencies: TrashSweepDependencies): Promise<SweepResult> {
  const result: SweepResult = { removed: [], skipped: [] };
  const input = await readSweepInput(dependencies);
  if (input === null) return result;
  const left = await removeLeftBinaries(dependencies, input.purged, input.entries, result);
  await forgetTombstones(dependencies, input.purged, left);
  return result;
}

/**
 * The tombstoned ids and the trash entries, or nothing to sweep.
 *
 * @param dependencies the storage and the files of the workspace
 * @returns the ids and entry names; null while the storage is unreachable, without a tombstone or on a failure
 */
async function readSweepInput(
  dependencies: TrashSweepDependencies,
): Promise<{ purged: Set<string>; entries: string[] } | null> {
  try {
    if (!(await dependencies.storage.isReachable())) return null;
    const purged = new Set(await dependencies.files.listPurgedIds());
    if (purged.size === 0) return null;
    return { purged, entries: await dependencies.storage.list(TRASH_DIR) };
  } catch {
    return null;
  }
}

/**
 * Removes every entry whose id has a tombstone and no row, in listing order.
 *
 * @param dependencies the storage and the files of the workspace
 * @param purged the tombstoned ids
 * @param entries the names in the trash directory
 * @param result collects the removed and skipped paths
 * @returns the tombstoned ids that still have an entry
 */
async function removeLeftBinaries(
  dependencies: TrashSweepDependencies,
  purged: Set<string>,
  entries: string[],
  result: SweepResult,
): Promise<Set<string>> {
  const left = new Set<string>();
  for (const name of entries) {
    const id = name.slice(0, 36);
    if (!UUID.test(id) || name[36] !== '_' || !purged.has(id)) continue;
    const path = `${TRASH_DIR}/${name}`;
    try {
      if ((await dependencies.files.get(id)) !== null) {
        left.add(id);
        continue;
      }
      await dependencies.storage.remove(path);
      result.removed.push(path);
    } catch {
      left.add(id);
      result.skipped.push(path);
    }
  }
  return left;
}

/**
 * Deletes the tombstone of every id without an entry left; stops once the storage is unreachable.
 *
 * @param dependencies the storage and the files of the workspace
 * @param purged the tombstoned ids
 * @param left the ids that still have an entry
 * @returns resolves once done; never rejects
 */
async function forgetTombstones(
  dependencies: TrashSweepDependencies,
  purged: Set<string>,
  left: Set<string>,
): Promise<void> {
  for (const id of purged) {
    if (left.has(id)) continue;
    try {
      // A share that dropped while sweeping lists nothing; never take that for "already gone".
      if (!(await dependencies.storage.isReachable())) return;
      await dependencies.files.forgetPurge(id);
    } catch {
      // The tombstone stays for the next sweep.
    }
  }
}
