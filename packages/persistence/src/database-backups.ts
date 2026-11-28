import { copyFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { BACKUP_UNREADABLE_MESSAGE } from '@assetforge/contracts';
import { InvalidOperationError, type BackupSource, type StagedRestore, type WorkspaceBackups } from '@assetforge/core';
import Database from 'better-sqlite3';
import type { BackupChecker } from './backup-check.js';
import { isPreMigrationBackupName, listPreMigrationBackups } from './database-backup.js';
import { removeWithSideFiles, restoreTemporaryName, snapshotClosedDatabase } from './database-snapshot.js';
import { installDatabase } from './database-swap.js';

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
export type DatabaseBackups = Pick<WorkspaceBackups, 'snapshotClosed' | 'localLineage' | 'listLocal' | 'stageRestore'>;

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
 * @throws InvalidOperationError with `BACKUP_UNREADABLE_MESSAGE` when the copy fails or the signal fired; nothing is
 * left behind then
 */
async function stageRestore(
  options: DatabaseBackupsOptions,
  workspaceId: string,
  source: BackupSource,
  signal: AbortSignal,
): Promise<StagedRestore> {
  const databaseFilePath = options.databaseFilePathOf(workspaceId);
  const stagedPath = join(dirname(databaseFilePath), restoreTemporaryName());
  try {
    await mkdir(dirname(databaseFilePath), { recursive: true });
    await copySource(options, databaseFilePath, source, stagedPath, signal);
    signal.throwIfAborted();
  } catch (error) {
    await removeWithSideFiles(stagedPath);
    throw new InvalidOperationError(BACKUP_UNREADABLE_MESSAGE, { cause: error });
  }
  const facts = await options.check(stagedPath, signal);
  if (signal.aborted) {
    await removeWithSideFiles(stagedPath);
    throw new InvalidOperationError(BACKUP_UNREADABLE_MESSAGE, { cause: signal.reason });
  }
  const now = options.now ?? (() => new Date());
  return {
    facts,
    install: () => installDatabase(databaseFilePath, stagedPath, now()),
    discard: () => removeWithSideFiles(stagedPath),
  };
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
