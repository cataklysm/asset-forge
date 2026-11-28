import { readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { REPLACED_KEEP_COUNT } from '@assetforge/contracts';
import { BackupError } from '@assetforge/core';
import { SIDE_FILE_SUFFIXES } from './database-snapshot.js';

/**
 * Puts a staged copy in place of a workspace database. The current database is moved aside with its side files as
 * `<database file name>.replaced-<yyyymmddThhmmssZ>` (plus `-2`, `-3`, ... when that stamp is taken) and the same
 * suffix, so it is never lost; the newest `REPLACED_KEEP_COUNT` sets are kept.
 */

/** The file operation the swap uses; tests inject a failing one. */
export interface SwapFileSystem {
  /**
   * Renames a file.
   *
   * @param from the current path
   * @param to the new path
   * @returns resolves once renamed
   */
  rename(from: string, to: string): Promise<void>;
}

/** The order the files of a database are moved aside in: side files first, the main file last. */
const MOVE_ORDER = ['-journal', '-wal', '-shm', ''] as const;

/** One set of replaced files: its name without suffix and what it sorts by. */
interface ReplacedSet {
  /** The name of the main file of the set. */
  name: string;
  /** The stamp of the name. */
  stamp: string;
  /** The counter of the name; 1 when it has none. */
  counter: number;
}

/**
 * The stamp of a replaced name.
 *
 * @param at the time
 * @returns `yyyymmddThhmmssZ` in UTC
 */
function replacedStamp(at: Date): string {
  return `${at
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/[-:]/g, '')}Z`;
}

/**
 * The name a replaced database gets.
 *
 * @param at the time of the replacement
 * @param databaseFileName the database file name without directory
 * @returns `<database file name>.replaced-<yyyymmddThhmmssZ>`
 */
export function replacedName(at: Date, databaseFileName = 'assetforge.sqlite'): string {
  return `${databaseFileName}.replaced-${replacedStamp(at)}`;
}

/**
 * The pattern of the replaced files of one database file, side files included.
 *
 * @param databaseFileName the database file name without directory
 * @returns a pattern with the stamp, the optional counter and the optional side file suffix as groups
 */
export function replacedPattern(databaseFileName: string): RegExp {
  const escaped = databaseFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\.replaced-(\\d{8}T\\d{6}Z)(?:-(\\d+))?(-journal|-wal|-shm)?$`);
}

/**
 * Moves the current database with its side files aside and renames the staged copy to the live name. No connection
 * may be open on either. The staged copy has no side files (the check put it in journal mode DELETE). Any failure
 * moves back what was moved, so the original database stays in place.
 *
 * @param databaseFilePath the live database file
 * @param stagedPath the checked copy in the same directory
 * @param now the time of the replacement
 * @param fileSystem the rename to use; the real one by default
 * @returns resolves once the copy is the live database and old replaced sets were pruned
 * @throws BackupError `backup_failed` when a rename failed
 */
export async function installDatabase(
  databaseFilePath: string,
  stagedPath: string,
  now: Date,
  fileSystem: SwapFileSystem = { rename },
): Promise<void> {
  const targetName = await freeReplacedName(databaseFilePath, now);
  const target = join(dirname(databaseFilePath), targetName);
  const moved = await moveAside(databaseFilePath, target, fileSystem);
  try {
    await fileSystem.rename(stagedPath, databaseFilePath);
  } catch (error) {
    await moveBack(databaseFilePath, target, moved, fileSystem);
    throw new BackupError('backup_failed', { cause: error });
  }
  await pruneReplaced(databaseFilePath, moved.length > 0 ? targetName : null);
}

/**
 * Moves the existing files of the database aside, side files first. A failure moves the moved ones back.
 *
 * @param databaseFilePath the live database file
 * @param target the replaced name (main file) in the same directory
 * @param fileSystem the rename to use
 * @returns the suffixes that were moved
 * @throws BackupError `backup_failed` when a rename failed; nothing is moved then
 */
async function moveAside(databaseFilePath: string, target: string, fileSystem: SwapFileSystem): Promise<string[]> {
  const present = new Set(await namesIn(dirname(databaseFilePath)));
  const moved: string[] = [];
  for (const suffix of MOVE_ORDER) {
    if (!present.has(basename(databaseFilePath) + suffix)) continue;
    try {
      await fileSystem.rename(databaseFilePath + suffix, target + suffix);
      moved.push(suffix);
    } catch (error) {
      await moveBack(databaseFilePath, target, moved, fileSystem);
      throw new BackupError('backup_failed', { cause: error });
    }
  }
  return moved;
}

/**
 * Moves replaced files back to the live name, in the reverse order; a failure is swallowed so the others still go.
 *
 * @param databaseFilePath the live database file
 * @param target the replaced name (main file)
 * @param moved the suffixes that were moved
 * @param fileSystem the rename to use
 * @returns resolves once every move back was tried
 */
async function moveBack(
  databaseFilePath: string,
  target: string,
  moved: string[],
  fileSystem: SwapFileSystem,
): Promise<void> {
  for (const suffix of [...moved].reverse()) {
    try {
      await fileSystem.rename(target + suffix, databaseFilePath + suffix);
    } catch {
      // The file keeps its replaced name and is still beside the database; nothing is deleted.
    }
  }
}

/**
 * A replaced name not taken yet by any file of a replaced set: the stamp, then `-2`, `-3` and so on.
 *
 * @param databaseFilePath the live database file
 * @param now the time of the replacement
 * @returns the name of the main file of the new set
 */
async function freeReplacedName(databaseFilePath: string, now: Date): Promise<string> {
  const base = replacedName(now, basename(databaseFilePath));
  const names = await namesIn(dirname(databaseFilePath));
  const isTaken = (candidate: string): boolean =>
    names.some((name) => name === candidate || SIDE_FILE_SUFFIXES.some((suffix) => name === candidate + suffix));
  if (!isTaken(base)) return base;
  let counter = 2;
  while (isTaken(`${base}-${counter}`)) counter++;
  return `${base}-${counter}`;
}

/**
 * Deletes the replaced sets of a database beyond `REPLACED_KEEP_COUNT`, with their side files; best effort, never
 * rejects. The kept set (the one a replacement just made) always survives, whatever its stamp, so a clock that was
 * ahead cannot delete it; the remaining slots go to the newest others.
 *
 * @param databaseFilePath the live database file
 * @param keptName the name of the set that must survive; null keeps the newest only
 * @returns resolves once every old set was tried
 */
export async function pruneReplaced(databaseFilePath: string, keptName: string | null = null): Promise<void> {
  const directory = dirname(databaseFilePath);
  const names = await namesIn(directory);
  const others = replacedSets(basename(databaseFilePath), names).filter((set) => set.name !== keptName);
  const slots = keptName === null ? REPLACED_KEEP_COUNT : REPLACED_KEEP_COUNT - 1;
  for (const set of others.slice(slots)) {
    for (const name of names.filter((candidate) => belongsToSet(candidate, set.name))) {
      try {
        await rm(join(directory, name), { force: true });
      } catch {
        // Best effort: the next replacement tries again.
      }
    }
  }
}

/**
 * The replaced sets among the names, newest first (by stamp, then counter).
 *
 * @param databaseFileName the database file name
 * @param names the names in its directory
 * @returns the sets
 */
function replacedSets(databaseFileName: string, names: string[]): ReplacedSet[] {
  const pattern = replacedPattern(databaseFileName);
  const sets = new Map<string, ReplacedSet>();
  for (const name of names) {
    const match = pattern.exec(name);
    if (!match) continue;
    const counter = match[2] === undefined ? 1 : Number(match[2]);
    const setName = name.slice(0, name.length - (match[3]?.length ?? 0));
    sets.set(setName, { name: setName, stamp: match[1]!, counter });
  }
  return [...sets.values()].sort(
    (left, right) => right.stamp.localeCompare(left.stamp) || right.counter - left.counter,
  );
}

/**
 * Whether a name is the main file or a side file of a set.
 *
 * @param name the name
 * @param setName the name of the set's main file
 * @returns true when it belongs to the set
 */
function belongsToSet(name: string, setName: string): boolean {
  return name === setName || SIDE_FILE_SUFFIXES.some((suffix) => name === setName + suffix);
}

/**
 * The names in a directory; an unreadable one counts as empty.
 *
 * @param directory the directory
 * @returns the names
 */
async function namesIn(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}
