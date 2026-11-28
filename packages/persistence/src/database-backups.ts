import { copyFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { BACKUP_UNREADABLE_MESSAGE } from '@assetforge/contracts';
import {
  BackupError,
  InvalidOperationError,
  type BackupSource,
  type SnapshotFacts,
  type StagedRestore,
  type WorkspaceBackups,
} from '@assetforge/core';
import Database from 'better-sqlite3';
import type { BackupChecker } from './backup-check.js';
import { isPreMigrationBackupName, listPreMigrationBackups } from './database-backup.js';
import {
  removeAfterCheck,
  removeCopyOnFailure,
  removeWithSideFiles,
  restoreTemporaryName,
  snapshotClosedDatabase,
} from './database-snapshot.js';
import { installDatabase, revertInstall } from './database-swap.js';

/** The options of `createDatabaseBackups`. */
export interface DatabaseBackupsOptions {
  /**
   * The local database file of a workspace.
   *
   * @param workspaceId the workspace
   * @returns the absolute path of `assetforge.sqlite`
   */
  databaseFilePathOf(workspaceId: string): string;
  /** The backup check of a copy. */
  check: BackupChecker;
  /**
   * Copies a regular backup to a local file; wired by the host, which knows the backup places.
   *
   * @param source where the backup lies
   * @param destinationPath the local file to write
   * @param signal aborts the copy
   * @returns resolves once the copy is complete
   */
  copyIn(source: BackupSource, destinationPath: string, signal: AbortSignal): Promise<void>;
  /**
   * The current time; the real clock by default.
   *
   * @returns the time
   */
  now?: () => Date;
}

/** The database side of the workspace backup. */
export type DatabaseBackups = Pick<WorkspaceBackups, 'snapshotClosed' | 'localLineage' | 'listLocal'> & {
  /**
   * Copies a backup into the local database directory of a workspace and checks it there.
   *
   * @param workspaceId the workspace
   * @param source where the backup lies
   * @param signal aborts the copy and the check
   * @returns the staged copy, which can undo its install
   */
  stageRestore(workspaceId: string, source: BackupSource, signal: AbortSignal): Promise<RevertibleStagedRestore>;
};

/**
 * The database side of the workspace backup: snapshots of a closed database, its lineage, the copies made before
 * pending migrations, and the staging of a restore in the local database directory.
 *
 * @param options the database paths, the check, the copy of regular backups and the clock
 * @returns the operations
 */
export function createDatabaseBackups(options: DatabaseBackupsOptions): DatabaseBackups {
  return {
    snapshotClosed: (workspaceId, signal) =>
      snapshotClosedDatabase(options.databaseFilePathOf(workspaceId), options.check, signal),
    localLineage: async (workspaceId) => readLineage(options.databaseFilePathOf(workspaceId)),
    listLocal: (workspaceId) => listPreMigrationBackups(options.databaseFilePathOf(workspaceId)),
    stageRestore: (workspaceId, source, signal) => stageRestore(options, workspaceId, source, signal),
  };
}

/**
 * The lineage of a database file, read without migrating it. The file is opened read-write first, because a
 * read-only connection to a database in WAL mode leaves a `-wal` and `-shm` beside it that only a writing connection
 * removes on close; a file that cannot be opened for writing is read read-only.
 *
 * @param databaseFilePath the database file
 * @returns the lineage; null when the file is missing, unreadable or has none
 */
function readLineage(databaseFilePath: string): string | null {
  return lineageWith(databaseFilePath, false) ?? lineageWith(databaseFilePath, true);
}

/**
 * The lineage of a database file read through one connection.
 *
 * @param databaseFilePath the database file
 * @param readonly whether the connection is read-only
 * @returns the lineage; null on any failure or when it has none
 */
function lineageWith(databaseFilePath: string, readonly: boolean): string | null {
  let sqlite: Database.Database | null = null;
  try {
    sqlite = new Database(databaseFilePath, { readonly, fileMustExist: true });
    sqlite.pragma('trusted_schema = OFF');
    const row = sqlite.prepare('SELECT lineage_id FROM workspace LIMIT 1').get() as { lineage_id: unknown } | undefined;
    return typeof row?.lineage_id === 'string' && row.lineage_id !== '' ? row.lineage_id : null;
  } catch {
    return null;
  } finally {
    sqlite?.close();
  }
}

/**
 * Copies a backup into the local database directory of a workspace and checks it there.
 *
 * @param options the options of the backups
 * @param workspaceId the workspace
 * @param source where the backup lies
 * @param signal aborts the copy
 * @returns the staged copy
 * @throws InvalidOperationError with `BACKUP_UNREADABLE_MESSAGE` when the copy fails; nothing is left behind then
 * @throws BackupError `backup_failed` when the signal fired; the copy is removed once its check worker has exited
 */
async function stageRestore(
  options: DatabaseBackupsOptions,
  workspaceId: string,
  source: BackupSource,
  signal: AbortSignal,
): Promise<RevertibleStagedRestore> {
  const databaseFilePath = options.databaseFilePathOf(workspaceId);
  const stagedPath = join(dirname(databaseFilePath), restoreTemporaryName());
  try {
    await mkdir(dirname(databaseFilePath), { recursive: true });
    await copySource(options, databaseFilePath, source, stagedPath, signal);
  } catch (error) {
    await removeWithSideFiles(stagedPath);
    throw stageFailure(error, signal);
  }
  const facts = signal.aborted ? null : await options.check(stagedPath, signal);
  if (signal.aborted) {
    await removeCopyOnFailure(stagedPath);
    throw new BackupError('backup_failed', { cause: signal.reason });
  }
  return stagedRestore(databaseFilePath, stagedPath, facts, options.now ?? (() => new Date()));
}

/**
 * The error of a stage whose copy failed: an abort is `backup_failed`, anything else an unreadable backup.
 *
 * @param error the failure
 * @param signal the abort signal of the stage
 * @returns the error to throw
 */
function stageFailure(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return new BackupError('backup_failed', { cause: error });
  return new InvalidOperationError(BACKUP_UNREADABLE_MESSAGE, { cause: error });
}

/** A staged restore that can undo its install. */
export type RevertibleStagedRestore = StagedRestore & {
  /**
   * Undoes a resolved install: removes the installed database with its side files and puts back the set the install
   * moved aside. Does nothing before a resolved install and on every later call.
   *
   * @returns resolves once the original database is back, or no database is left when there was none
   * @throws BackupError `backup_failed` when a file could not be removed or renamed for another reason than being gone
   */
  revert(): Promise<void>;
};

/** What a staged restore knows about its install. */
interface InstallState {
  /** Whether an install resolved and was not reverted yet. */
  installed: boolean;
  /** The name of the set the install moved aside; null when it replaced nothing. */
  replacedSetName: string | null;
}

/**
 * The staged restore over a checked copy. Install refuses a copy whose check found no facts.
 *
 * @param databaseFilePath the live database file
 * @param stagedPath the checked copy
 * @param facts what the check found
 * @param now the clock
 * @returns the staged restore
 */
function stagedRestore(
  databaseFilePath: string,
  stagedPath: string,
  facts: SnapshotFacts | null,
  now: () => Date,
): RevertibleStagedRestore {
  const state: InstallState = { installed: false, replacedSetName: null };
  return {
    facts,
    install: () => installChecked(databaseFilePath, stagedPath, facts, now(), state),
    discard: () => removeAfterCheck(stagedPath),
    revert: () => revertOnce(databaseFilePath, state),
  };
}

/**
 * Installs a staged copy whose check found its facts.
 *
 * @param databaseFilePath the live database file
 * @param stagedPath the checked copy
 * @param facts what the check found
 * @param now the time of the replacement
 * @param state records the install for a later revert
 * @returns resolves once the copy is the live database
 * @throws BackupError `backup_failed` when the check found no facts or the swap failed
 */
async function installChecked(
  databaseFilePath: string,
  stagedPath: string,
  facts: SnapshotFacts | null,
  now: Date,
  state: InstallState,
): Promise<void> {
  if (facts === null) throw new BackupError('backup_failed');
  state.replacedSetName = await installDatabase(databaseFilePath, stagedPath, now);
  state.installed = true;
}

/**
 * Reverts a resolved install once; the state is cleared first, so a second or concurrent call does nothing.
 *
 * @param databaseFilePath the live database file
 * @param state the install state
 * @returns resolves once reverted, or at once when there is nothing to revert
 * @throws BackupError `backup_failed` when a file could not be removed or renamed for another reason than being gone
 */
async function revertOnce(databaseFilePath: string, state: InstallState): Promise<void> {
  if (!state.installed) return;
  state.installed = false;
  await revertInstall(databaseFilePath, state.replacedSetName);
}

/**
 * Copies the source to the staged path: a copy made before pending migrations from beside the database, any other
 * through the host.
 *
 * @param options the options of the backups
 * @param databaseFilePath the local database file
 * @param source where the backup lies
 * @param stagedPath the local file to write
 * @param signal aborts the copy
 * @returns resolves once the copy is complete
 * @throws Error when a pre-migration source names no pre-migration backup or lies elsewhere, or the copy fails
 */
async function copySource(
  options: DatabaseBackupsOptions,
  databaseFilePath: string,
  source: BackupSource,
  stagedPath: string,
  signal: AbortSignal,
): Promise<void> {
  if (source.origin === 'regular') return options.copyIn(source, stagedPath, signal);
  if (source.directory !== null || !isPreMigrationBackupName(basename(databaseFilePath), source.name)) {
    throw new Error('Not a backup made before an update');
  }
  await copyFile(join(dirname(databaseFilePath), source.name), stagedPath);
}
