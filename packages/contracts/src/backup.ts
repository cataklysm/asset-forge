import { z } from 'zod';
import { CountSchema, IdSchema } from './ipc-shared';

// The workspace backup: the limits and places, the fixed messages, and the shapes the backup channels answer.

/** Within one lineage, the newest this many backups are always kept. */
export const BACKUP_KEEP_NEWEST = 5;
/** Within one lineage, the newest backup of each of the last this many UTC days is kept as well. */
export const BACKUP_KEEP_DAYS = 7;
/** While a workspace is open, a changed database is backed up at most this often. */
export const BACKUP_INTERVAL_MS = 3_600_000;
/** The longest a closing backup (close, switch, quit, the final backup before a remove) may take. */
export const BACKUP_QUIT_DEADLINE_MS = 30_000;
/** How many databases replaced by a restore are kept beside the live one. */
export const REPLACED_KEEP_COUNT = 2;
/** The folder a chosen backup place gets, holding one folder per workspace id. */
export const BACKUP_FOLDER_NAME = 'assetforge-backups';
/** The file beside the copies in a chosen place that names the workspace (`{ v: 1, id, name }`). */
export const BACKUP_INFO_FILE = 'backup-info.json';

/** The reasons a backup fails with. */
export const BACKUP_FAILURE_CODES = ['backup_location_unreachable', 'backup_no_space', 'backup_failed'] as const;
/** The reason a backup failed with. */
export type BackupFailureCode = (typeof BACKUP_FAILURE_CODES)[number];
/** The fixed message of each backup failure; never a path, a file name or a cause. */
export const BACKUP_MESSAGES: Record<BackupFailureCode, string> = {
  backup_location_unreachable: 'The backup folder cannot be reached',
  backup_no_space: 'There is not enough free space for the backup',
  backup_failed: 'The backup could not be written',
};
/** `invalid_operation`: a backup id that is not bound to the latest listing of its workspace. */
export const BACKUP_STALE_MESSAGE = 'Load the backups again';
/** `invalid_operation`: a migration failed and was rolled back. */
export const DATABASE_UPDATE_FAILED_MESSAGE = 'The database update failed. Nothing was changed';
/** `workspace_database_missing`: a workspace folder whose database is not on this machine. */
export const DATABASE_MISSING_MESSAGE = 'This workspace has no database on this machine';
/** `validation_failed`: a backup that is not a readable database or fails its integrity check. */
export const BACKUP_DAMAGED_MESSAGE = 'This backup is damaged';
/** `workspace_mismatch`: a backup of another workspace than the folder's manifest. */
export const BACKUP_FOREIGN_MESSAGE = 'This backup belongs to another workspace';
/** `unsupported_format_version`: a backup written by a newer app. */
export const BACKUP_NEWER_MESSAGE = 'This backup is from a newer version of AssetForge';
/** `invalid_operation`: a backup that could not be copied to the local disk. */
export const BACKUP_UNREADABLE_MESSAGE = 'The backup could not be read';
/** `invalid_operation`: a restore of the workspace that is open. */
export const RESTORE_OPEN_MESSAGE = 'Close this workspace before restoring it';
/** `invalid_operation`: a backup the settings may not delete (same lineage, pre-migration or another place). */
export const BACKUP_NOT_DELETABLE_MESSAGE = 'This backup cannot be deleted';
/** `validation_failed`: a chosen backup folder inside a workspace root. */
export const LOCATION_IN_WORKSPACE_MESSAGE = 'This folder lies inside a workspace';
/** `validation_failed`: a chosen backup folder inside the app data. */
export const LOCATION_IN_APP_DATA_MESSAGE = 'This folder lies inside the app data';
/** `validation_failed`: a chosen backup folder that is missing or cannot be written. */
export const LOCATION_NOT_WRITABLE_MESSAGE = 'This folder cannot be written';

/** Where a backup comes from: the copy made before pending migrations, or a regular backup. */
export const BackupOriginSchema = z.enum(['pre_migration', 'regular']);
/** Where a backup comes from. */
export type BackupOrigin = z.infer<typeof BackupOriginSchema>;

/** One backup as the renderer sees it; `backupId` is an opaque id bound to the listing in the main process. */
export const BackupEntrySchema = z.object({
  backupId: IdSchema,
  createdAt: z.iso.datetime(),
  sizeBytes: CountSchema,
  appliedMigrations: CountSchema,
  origin: BackupOriginSchema,
  /** Whether the backup belongs to the same lineage as the workspace's database on this machine. */
  sameLineage: z.boolean(),
});
/** One backup as the renderer sees it. */
export type BackupEntry = z.infer<typeof BackupEntrySchema>;

/** The result of one backup attempt; on a failure the code and its fixed message. */
export const BackupAttemptSchema = z.object({
  at: z.iso.datetime(),
  ok: z.boolean(),
  code: z.enum(BACKUP_FAILURE_CODES).nullable(),
  message: z.string().nullable(),
});
/** The result of one backup attempt. */
export type BackupAttempt = z.infer<typeof BackupAttemptSchema>;

/** What the shell polls: the open workspace, whether a backup runs and the last attempt. */
export const BackupStateSchema = z.object({
  workspaceId: IdSchema.nullable(),
  running: z.boolean(),
  last: BackupAttemptSchema.nullable(),
});
/** What the shell polls. */
export type BackupState = z.infer<typeof BackupStateSchema>;

/** The backup section of the settings for the open workspace. */
export const BackupStatusSchema = z.object({
  /** The place; `path` is for display only: the chosen directory, or null for the default place. */
  location: z.object({ kind: z.enum(['workspace', 'chosen']), path: z.string().nullable() }),
  reachable: z.boolean(),
  running: z.boolean(),
  last: BackupAttemptSchema.nullable(),
  /** The copies of the workspace's own lineage in the place. */
  count: CountSchema,
  totalBytes: CountSchema,
  /** The copies of other lineages in the place, which only the user deletes. */
  otherLineages: z.array(BackupEntrySchema),
});
/** The backup section of the settings. */
export type BackupStatus = z.infer<typeof BackupStatusSchema>;

/** The answer of `workspace:backups`: newest first, and whether the configured or default place could not be listed. */
export const BackupListingSchema = z.object({
  backups: z.array(BackupEntrySchema),
  unreachable: z.boolean(),
});
/** The answer of `workspace:backups`. */
export type BackupListing = z.infer<typeof BackupListingSchema>;
