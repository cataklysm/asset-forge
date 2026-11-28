import type { BackupAttempt } from '@assetforge/contracts';
import type { BackupLocation, BackupSource } from './ports/workspace-backups.js';

// The backup records the workspace manager answers; the desktop host turns them into the IPC shapes, replacing every
// directory by an opaque id.

/** One backup a workspace can be restored from. */
export interface ListedBackup {
  /** Where it lies; never leaves the main process. */
  source: BackupSource;
  /** When it was made, as an ISO timestamp (UTC). */
  createdAt: string;
  /** The file size. */
  sizeBytes: number;
  /** The number of migrations applied to the copied database. */
  appliedMigrations: number;
  /** A copy made before pending migrations, or a regular backup. */
  origin: 'pre_migration' | 'regular';
  /** Whether it has the lineage of the workspace's live database. */
  sameLineage: boolean;
}

/** The state of the backup place of the open workspace. */
export interface BackupFolderStatus {
  /** Where the regular backups go. */
  location: BackupLocation;
  /** Whether the place could be listed. */
  reachable: boolean;
  /** Whether a backup is being made. */
  running: boolean;
  /** The last attempt in this session; null before the first. */
  last: BackupAttempt | null;
  /** The number of backups of this workspace's lineage in the place. */
  count: number;
  /** Their total size. */
  totalBytes: number;
  /** The backups in the place that belong to another lineage. */
  otherLineages: ListedBackup[];
}
