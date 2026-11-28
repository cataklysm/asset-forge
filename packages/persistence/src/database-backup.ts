import { readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { InvalidOperationError } from '@assetforge/core';
import type Database from 'better-sqlite3';

/**
 * Backups of a workspace database taken before pending migrations are applied.
 *
 * Naming: a backup lies beside the database as `<database file name>.backup-<appliedCount>-<yyyymmddhhmmss>`,
 * where `appliedCount` is the number of migrations applied before the update (the schema state the backup
 * holds) and the stamp is the UTC time the backup was started. It is written as the same name plus `.tmp`
 * through SQLite's online backup, so it is consistent with WAL, and renamed to the final name only once complete.
 * Two backups of the same state in the same second share a name; the later one replaces the earlier one.
 *
 * Retention: after a successful migration the newest `BACKUP_KEEP_COUNT` backups of the database are kept (newest
 * by stamp, then by applied count) and the older ones are deleted, best effort. The `.tmp` files of an
 * interrupted backup (with their `-journal`, `-wal` and `-shm` side files) are removed on every open, best effort.
 */

/** The number of backups kept per database. */
export const BACKUP_KEEP_COUNT = 3;

/** The fixed message when the backup before an update cannot be made; it never carries a cause or path. */
export const BACKUP_FAILED_MESSAGE = 'The database could not be backed up before the update';

/** The suffix of a backup that is still being written. */
const TEMPORARY_SUFFIX = '.tmp';

/** The side files SQLite may leave beside a database file. */
const SIDE_FILE_SUFFIXES = ['-journal', '-wal', '-shm'];

/** A finished backup: its file name and the parts of the name the retention sorts by. */
interface BackupEntry {
  /** The file name inside the database directory. */
  name: string;
  /** The applied migration count of the name. */
  appliedCount: number;
  /** The UTC stamp of the name, `yyyymmddhhmmss`. */
  stamp: string;
}

/**
 * Escapes a text for use inside a regular expression.
 *
 * @param text the literal text
 * @returns the escaped text
 */
function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The pattern of a finished backup name of one database file.
 *
 * @param databaseFileName the database file name without directory
 * @returns a pattern with the applied count and the stamp as groups
 */
function finishedBackupPattern(databaseFileName: string): RegExp {
  return new RegExp(`^${escapeForPattern(databaseFileName)}\\.backup-(\\d+)-(\\d{14})$`);
}

/**
 * The pattern of a temporary backup name of one database file, with its SQLite side files.
 *
 * @param databaseFileName the database file name without directory
 * @returns the pattern
 */
function temporaryBackupPattern(databaseFileName: string): RegExp {
  const sideFiles = SIDE_FILE_SUFFIXES.map(escapeForPattern).join('|');
  return new RegExp(`^${escapeForPattern(databaseFileName)}\\.backup-\\d+-\\d{14}\\.tmp(?:${sideFiles})?$`);
}

/**
 * The UTC stamp of a backup name.
 *
 * @param at the time
 * @returns the time as `yyyymmddhhmmss` in UTC
 */
export function backupStamp(at: Date): string {
  return at
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/[-T:]/g, '');
}

/**
 * The file name of a backup.
 *
 * @param databaseFileName the database file name without directory
 * @param appliedCount the number of migrations applied before the update
 * @param at the time the backup is started
 * @returns the backup file name
 */
export function backupFileName(databaseFileName: string, appliedCount: number, at: Date): string {
  return `${databaseFileName}.backup-${appliedCount}-${backupStamp(at)}`;
}

/**
 * The file names in the directory of the database; an unreadable directory counts as empty.
 *
 * @param databaseFilePath the database file
 * @returns the names
 */
async function namesBeside(databaseFilePath: string): Promise<string[]> {
  try {
    return await readdir(dirname(databaseFilePath));
  } catch {
    return [];
  }
}

/**
 * Removes one file, ignoring any failure.
 *
 * @param path the file
 * @returns resolves once the removal ended either way
 */
async function removeQuietly(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // Best effort: the next open tries again.
  }
}

/**
 * Removes the temporary files of an interrupted backup of this database, best effort.
 *
 * @param databaseFilePath the database file
 * @returns resolves once every leftover was tried
 */
export async function removeBackupLeftovers(databaseFilePath: string): Promise<void> {
  const pattern = temporaryBackupPattern(basename(databaseFilePath));
  const directory = dirname(databaseFilePath);
  for (const name of await namesBeside(databaseFilePath)) {
    if (pattern.test(name)) await removeQuietly(join(directory, name));
  }
}

/**
 * Writes a consistent copy of the open database beside it, through a temporary name. A failure removes the
 * temporary file and is reported with the fixed message only.
 *
 * @param sqlite the open connection
 * @param databaseFilePath the database file
 * @param appliedCount the number of migrations applied before the update
 * @param at the time the backup is started
 * @returns the path of the finished backup
 * @throws InvalidOperationError with `BACKUP_FAILED_MESSAGE` when the copy cannot be written or renamed
 */
export async function backupDatabase(
  sqlite: Database.Database,
  databaseFilePath: string,
  appliedCount: number,
  at: Date,
): Promise<string> {
  const finalPath = join(dirname(databaseFilePath), backupFileName(basename(databaseFilePath), appliedCount, at));
  const temporaryPath = finalPath + TEMPORARY_SUFFIX;
  try {
    await sqlite.backup(temporaryPath);
    await rename(temporaryPath, finalPath);
    return finalPath;
  } catch (error) {
    await removeQuietly(temporaryPath);
    throw new InvalidOperationError(BACKUP_FAILED_MESSAGE, { cause: error });
  }
}

/**
 * The finished backups of this database, newest first.
 *
 * @param databaseFilePath the database file
 * @returns the backups sorted by stamp, then applied count, both descending
 */
async function finishedBackups(databaseFilePath: string): Promise<BackupEntry[]> {
  const pattern = finishedBackupPattern(basename(databaseFilePath));
  const entries: BackupEntry[] = [];
  for (const name of await namesBeside(databaseFilePath)) {
    const match = pattern.exec(name);
    if (match) entries.push({ name, appliedCount: Number(match[1]), stamp: match[2]! });
  }
  return entries.sort((left, right) => right.stamp.localeCompare(left.stamp) || right.appliedCount - left.appliedCount);
}

/**
 * Deletes the backups of this database beyond the newest `BACKUP_KEEP_COUNT`, with their side files. Never
 * throws; a backup that cannot be deleted stays until a later update.
 *
 * @param databaseFilePath the database file
 * @returns resolves once every old backup was tried
 */
export async function pruneBackups(databaseFilePath: string): Promise<void> {
  const directory = dirname(databaseFilePath);
  const old = (await finishedBackups(databaseFilePath)).slice(BACKUP_KEEP_COUNT);
  for (const entry of old) {
    for (const suffix of ['', ...SIDE_FILE_SUFFIXES]) await removeQuietly(join(directory, entry.name + suffix));
  }
}
