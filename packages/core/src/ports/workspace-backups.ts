// What the workspace backup needs from outside core: snapshots of a database, the place the copies go to, and the
// local database directory a restore installs into. Implemented by persistence (the database side) and the host
// (the place).

/** What the check of a database copy found out about it. */
export interface SnapshotFacts {
  /** The id in the copy's workspace row. */
  workspaceId: string;
  /** The lineage in the copy's workspace row; null for a database from before the lineage existed. */
  lineageId: string | null;
  /** The format version in the copy's workspace row. */
  formatVersion: number;
  /** The number of migrations applied to the copy. */
  appliedMigrations: number;
  /** Whether the copy was migrated further than this app's migrations go. */
  newerThanApp: boolean;
}

/** A checked copy of a workspace database in a local temporary file; `lineageId` is never null on a snapshot. */
export interface DatabaseSnapshot extends SnapshotFacts {
  /** The absolute path of the temporary file; never leaves the main process. */
  path: string;
  /** The size of the file. */
  sizeBytes: number;
  /** The change count of the connection when the snapshot started; 0 for a snapshot of a closed database. */
  changeCount: number;
  /**
   * Removes the temporary file and its side files; never rejects.
   *
   * @returns resolves once they are gone
   */
  discard(): Promise<void>;
}

/** Where the regular backups of one workspace go. */
export interface BackupLocation {
  /** The default place in the workspace folder, or a place the user chose. */
  kind: 'workspace' | 'chosen';
  /** The absolute directory the copies are written to. */
  directory: string;
  /** The directory the user chose (the parent of `assetforge-backups`); null for the default place. */
  chosenPath: string | null;
}

/** One file in a backup directory, as listed. */
export interface BackupFileInfo {
  /** The file name. */
  name: string;
  /** The file size. */
  sizeBytes: number;
  /** When the file was last modified, as an ISO timestamp. */
  modifiedAt: string;
}

/** One copy made before pending migrations, beside the live database. */
export interface LocalBackupFile {
  /** The file name. */
  name: string;
  /** The file size. */
  sizeBytes: number;
  /** The stamp of its name as an ISO timestamp (UTC). */
  createdAt: string;
  /** The number of migrations applied when it was made. */
  appliedMigrations: number;
}

/** Where a backup to restore lies. */
export interface BackupSource {
  /** A copy made before pending migrations, or a regular backup. */
  origin: 'pre_migration' | 'regular';
  /** The absolute directory; null means the local database directory of the workspace. */
  directory: string | null;
  /** The file name. */
  name: string;
}

/** A backup copied into the local database directory and checked there, ready to replace the database. */
export interface StagedRestore {
  /** What the check found; null when the copy is not a readable database or its `quick_check` was not ok. */
  facts: SnapshotFacts | null;
  /**
   * Moves the current database with its side files aside and puts the copy in its place; no connection may be open.
   *
   * @returns resolves once the copy is the live database
   * @throws BackupError when the swap failed; the original database is then in place again
   */
  install(): Promise<void>;
  /**
   * Removes the copy; never rejects.
   *
   * @returns resolves once it is gone
   */
  discard(): Promise<void>;
}

/** The backup operations the workspace manager runs on. */
export interface WorkspaceBackups {
  /**
   * Copies the closed database of a workspace into a local temporary file, without opening or migrating it, and
   * checks the copy.
   *
   * @param workspaceId the workspace
   * @param signal aborts the copy; the temporary file is removed then
   * @returns the checked snapshot
   * @throws BackupError when the database is missing or the copy fails its check
   */
  snapshotClosed(workspaceId: string, signal: AbortSignal): Promise<DatabaseSnapshot>;
  /**
   * The lineage of the workspace's local database, read without migrating it.
   *
   * @param workspaceId the workspace
   * @returns the lineage id; null when the database is missing, unreadable or has none
   */
  localLineage(workspaceId: string): Promise<string | null>;
  /**
   * The copies made before pending migrations, beside the workspace's local database.
   *
   * @param workspaceId the workspace
   * @returns the copies; none when the directory is missing
   */
  listLocal(workspaceId: string): Promise<LocalBackupFile[]>;
  /**
   * Copies a backup into the workspace's local database directory and checks it there.
   *
   * @param workspaceId the workspace
   * @param source where the backup lies
   * @param signal aborts the copy
   * @returns the staged copy
   * @throws InvalidOperationError with `BACKUP_UNREADABLE_MESSAGE` when the copy fails
   */
  stageRestore(workspaceId: string, source: BackupSource, signal: AbortSignal): Promise<StagedRestore>;
  /**
   * The place the regular backups of a workspace go to.
   *
   * @param workspace the workspace's id, name and folder
   * @returns the place
   */
  locationOf(workspace: { id: string; name: string; rootPath: string }): Promise<BackupLocation>;
  /**
   * Copies a snapshot into its place as a `.tmp` file and renames it once complete.
   *
   * @param snapshot the checked snapshot
   * @param location the place
   * @param fileName the name of the backup (`backupFileName`)
   * @param signal aborts the copy; the `.tmp` file is removed then
   * @returns resolves once the backup is in place
   * @throws BackupError with the reason of the failure
   */
  write(snapshot: DatabaseSnapshot, location: BackupLocation, fileName: string, signal: AbortSignal): Promise<void>;
  /**
   * The regular files in a backup directory.
   *
   * @param directory the absolute directory
   * @returns the files, in no particular order
   * @throws BackupError `backup_location_unreachable` when the directory cannot be listed
   */
  list(directory: string): Promise<BackupFileInfo[]>;
  /**
   * Deletes one regular backup.
   *
   * @param directory the absolute directory
   * @param name a name matching `BACKUP_NAME_PATTERN`; any other name is refused
   * @returns resolves once it is gone
   * @throws BackupError for a refused name or a failed delete
   */
  remove(directory: string, name: string): Promise<void>;
}

/** The timers of the hourly backup; tests pass fakes. */
export interface BackupTimers {
  /**
   * Starts a timer.
   *
   * @param callback what runs when it fires
   * @param ms the delay
   * @returns a handle for `clear`
   */
  set(callback: () => void, ms: number): unknown;
  /**
   * Stops a timer; no-op for one that fired or was cleared.
   *
   * @param handle what `set` answered
   */
  clear(handle: unknown): void;
}
