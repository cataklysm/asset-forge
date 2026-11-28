import { randomUUID } from 'node:crypto';
import { copyFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BackupError, type DatabaseSnapshot, type SnapshotFacts } from '@assetforge/core';
import type Database from 'better-sqlite3';
import { checkExited, isCheckRunning, type BackupChecker } from './backup-check.js';

/**
 * Snapshots of a workspace database in a temporary file in its own directory, checked there by the backup check.
 *
 * Naming: `assetforge.sqlite.snapshot-<uuid>.tmp` for a snapshot and `assetforge.sqlite.restore-<uuid>.tmp` for a
 * backup staged for a restore, distinct from the backups before migrations (`.backup-`) and the replaced databases
 * (`.replaced-`). Leftovers with their side files are swept before every open.
 */

/** The number of pages the online backup copies per step; the event loop runs between the steps. */
export const SNAPSHOT_STEP_PAGES = 100;

/** The side files SQLite may leave beside a database file. */
export const SIDE_FILE_SUFFIXES = ['-journal', '-wal', '-shm'] as const;

/** A temporary file of a snapshot or a restore, with its side files. */
export const LOCAL_TEMPORARY_PATTERN =
  /^assetforge\.sqlite\.(snapshot|restore)-[0-9a-f-]{36}\.tmp(-journal|-wal|-shm)?$/;

/**
 * A new name for the temporary file of a snapshot.
 *
 * @returns `assetforge.sqlite.snapshot-<uuid>.tmp`
 */
export function snapshotTemporaryName(): string {
  return `assetforge.sqlite.snapshot-${randomUUID()}.tmp`;
}

/**
 * A new name for the temporary file of a staged restore.
 *
 * @returns `assetforge.sqlite.restore-<uuid>.tmp`
 */
export function restoreTemporaryName(): string {
  return `assetforge.sqlite.restore-${randomUUID()}.tmp`;
}

/**
 * Removes a file and its side files, ignoring any failure.
 *
 * @param path the file
 * @returns resolves once every removal was tried
 */
export async function removeWithSideFiles(path: string): Promise<void> {
  for (const suffix of ['', ...SIDE_FILE_SUFFIXES]) {
    try {
      await rm(path + suffix, { force: true });
    } catch {
      // Best effort: the sweep before the next open tries again.
    }
  }
}

/**
 * Removes a checked copy and its side files once every check worker on it has exited; never rejects.
 *
 * @param path the copy
 * @returns resolves once the workers are gone and every removal was tried
 */
export async function removeAfterCheck(path: string): Promise<void> {
  await checkExited(path);
  await removeWithSideFiles(path);
}

/**
 * Removes a copy after a failure: at once when no check worker holds it, otherwise in the background after the
 * worker has exited, so the caller is not held by a worker busy in a long SQLite call. A leftover goes on the sweep.
 *
 * @param path the copy
 * @returns resolves once removed, or at once when the removal waits for a worker
 */
export async function removeCopyOnFailure(path: string): Promise<void> {
  const removal = removeAfterCheck(path);
  if (!isCheckRunning(path)) await removal;
}

/**
 * Removes the leftover temporary files of snapshots and restores in a database directory, best effort.
 *
 * @param databaseDirectory the directory of the database
 * @returns resolves once every leftover was tried; never rejects
 */
export async function sweepLocalTemporary(databaseDirectory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(databaseDirectory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!LOCAL_TEMPORARY_PATTERN.test(name)) continue;
    try {
      await rm(join(databaseDirectory, name), { force: true });
    } catch {
      // Best effort: a file still held open goes on the next sweep.
    }
  }
}

/**
 * Copies the open database through SQLite's online backup in small steps, then checks the copy. Writes on the same
 * connection between the steps land in the copy, so it is consistent; the change count is read before, so a write
 * during the copy counts as a change for the next backup.
 *
 * @param sqlite the open connection
 * @param databaseFilePath the database file; the copy goes beside it
 * @param check the backup check
 * @param signal aborts the copy and the check
 * @returns the checked snapshot
 * @throws BackupError `backup_failed` when the copy fails, fails its check or is aborted; the copy is removed then
 */
export async function snapshotOpenDatabase(
  sqlite: Database.Database,
  databaseFilePath: string,
  check: BackupChecker,
  signal: AbortSignal,
): Promise<DatabaseSnapshot> {
  const changeCount = Number((sqlite.prepare('select total_changes() as n').get() as { n: number }).n);
  const path = join(dirname(databaseFilePath), snapshotTemporaryName());
  try {
    throwIfAborted(signal);
    await sqlite.backup(path, { progress: () => nextStep(signal) });
    return await checkedSnapshot(path, changeCount, check, signal);
  } catch (error) {
    await removeCopyOnFailure(path);
    throw asBackupError(error);
  }
}

/**
 * Copies a closed database file and its `-wal` without opening either, then checks the copy; the check folds the
 * WAL into it. The live file and its `-wal` are only read.
 *
 * @param databaseFilePath the database file
 * @param check the backup check
 * @param signal aborts the copy and the check
 * @returns the checked snapshot with change count 0
 * @throws BackupError `backup_failed` when the file is missing, the copy fails its check or is aborted
 */
export async function snapshotClosedDatabase(
  databaseFilePath: string,
  check: BackupChecker,
  signal: AbortSignal,
): Promise<DatabaseSnapshot> {
  const path = join(dirname(databaseFilePath), snapshotTemporaryName());
  try {
    throwIfAborted(signal);
    await copyFile(databaseFilePath, path);
    for (const suffix of ['-wal', '-journal']) {
      if (await isFile(databaseFilePath + suffix)) await copyFile(databaseFilePath + suffix, path + suffix);
    }
    return await checkedSnapshot(path, 0, check, signal);
  } catch (error) {
    await removeCopyOnFailure(path);
    throw asBackupError(error);
  }
}

/**
 * Checks a copy and builds the snapshot over it.
 *
 * @param path the copy
 * @param changeCount the change count to record
 * @param check the backup check
 * @param signal aborts the check
 * @returns the snapshot
 * @throws BackupError `backup_failed` when the check answers no facts or no lineage, or was aborted
 */
async function checkedSnapshot(
  path: string,
  changeCount: number,
  check: BackupChecker,
  signal: AbortSignal,
): Promise<DatabaseSnapshot> {
  const facts = await check(path, signal);
  throwIfAborted(signal);
  if (facts === null || facts.lineageId === null) throw new BackupError('backup_failed');
  const sizeBytes = (await stat(path)).size;
  return snapshotOf(facts, path, sizeBytes, changeCount);
}

/**
 * The snapshot object over a checked copy.
 *
 * @param facts the facts of the check
 * @param path the copy
 * @param sizeBytes its size
 * @param changeCount the change count to record
 * @returns the snapshot
 */
function snapshotOf(facts: SnapshotFacts, path: string, sizeBytes: number, changeCount: number): DatabaseSnapshot {
  return { ...facts, path, sizeBytes, changeCount, discard: () => removeAfterCheck(path) };
}

/**
 * The progress step of the online backup: the next number of pages, or an abort.
 *
 * @param signal the abort signal
 * @returns the number of pages of the next step
 * @throws the abort reason when the signal fired; better-sqlite3 then ends the backup and rejects
 */
function nextStep(signal: AbortSignal): number {
  throwIfAborted(signal);
  return SNAPSHOT_STEP_PAGES;
}

/**
 * Throws when the signal fired.
 *
 * @param signal the abort signal
 * @throws BackupError `backup_failed` when it fired
 */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new BackupError('backup_failed', { cause: signal.reason });
}

/**
 * A failure as the backup error: a backup error stays, anything else becomes `backup_failed` with it as the cause.
 *
 * @param error the failure
 * @returns the backup error
 */
function asBackupError(error: unknown): BackupError {
  return error instanceof BackupError ? error : new BackupError('backup_failed', { cause: error });
}

/**
 * Whether a path is a regular file.
 *
 * @param path the path
 * @returns true for a regular file; false when it is missing or anything else
 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
