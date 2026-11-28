// The workspace backup: the restore dialog, the Backup section of the settings and the banner line.
// `Restore`, `Delete` and `Reset` are shared with other subjects (`RESTORE_LABEL`, `DELETE_LABEL`, `RESET_LABEL`).

/** The menu item of a workspace row that opens the restore dialog. */
export const RESTORE_BACKUP_LABEL = 'Restore backup…';
/** The tooltip of the menu item. */
export const RESTORE_BACKUP_TITLE = 'Replace the database of this workspace with a backup; asks first';

/** The title of the restore dialog. */
export const RESTORE_DIALOG_TITLE = 'Restore backup';
/** The accessible name of the list of backups. */
export const BACKUP_LIST_LABEL = 'Backups';
/** The line of an empty list of backups. */
export const NO_BACKUPS_LABEL = 'No backups';
/** The tooltip of Restore in the dialog. */
export const RESTORE_BACKUP_BUTTON_TITLE = 'Restore the selected backup and open the workspace';
/** The dialog button that lists the backups of a folder the user picks. */
export const CHOOSE_FOLDER_LABEL = 'Choose folder…';
/** The tooltip of Choose folder. */
export const CHOOSE_FOLDER_TITLE = 'List the backups in another folder, for example on another drive';
/** The dialog button that opens the workspace with a new, empty database. */
export const START_EMPTY_LABEL = 'Start empty';
/** The tooltip of Start empty. */
export const START_EMPTY_TITLE =
  'Open the workspace with a new, empty catalog; the files in the folder stay; asks first';

/** The confirmation before a backup replaces an existing database. */
export const RESTORE_CONFIRM_TITLE = 'Restore this backup?';
/** The confirmation before a workspace starts with an empty database. */
export const START_EMPTY_CONFIRM_TITLE = 'Start with an empty catalog?';
/** The confirmation before a backup of another lineage is deleted. */
export const DELETE_BACKUP_CONFIRM_TITLE = 'Delete this backup?';

/** The tooltip and accessible text of the marker of a copy made before a database update. */
export const PRE_MIGRATION_TITLE = 'Copy made on this machine before the database was updated';
/** The tooltip and accessible text of the marker of a copy of another database lineage. */
export const OTHER_LINEAGE_TITLE = 'Copy of another database than the one this workspace uses on this machine';
/** The tooltip of the migration count of a backup. */
export const MIGRATIONS_TITLE = 'Number of database updates the copy has';

/**
 * The migration count of a backup: 'm21'.
 *
 * @param count the applied migrations
 * @returns the short text
 */
export const migrationsText = (count: number) => `m${count}`;

/** The heading of the Backup section of the settings. */
export const BACKUP_SECTION_TITLE = 'Backup';
/** The caption of the place the backups go to. */
export const BACKUP_LOCATION_LABEL = 'Location';
/** The place when it is the default one inside the workspace folder. */
export const WORKSPACE_FOLDER_LABEL = 'Workspace folder';
/** The tooltip of the default place. */
export const WORKSPACE_FOLDER_TITLE = 'The backups are kept in the workspace folder';
/** The button that picks another place. */
export const BACKUP_CHANGE_LOCATION_LABEL = 'Change…';
/** The tooltip of Change. */
export const BACKUP_CHANGE_LOCATION_TITLE = 'Keep the backups in another folder, for example on another drive';
/** The tooltip of Reset. */
export const BACKUP_RESET_LOCATION_TITLE = 'Keep the backups in the workspace folder again';
/** The button that backs the open workspace up at once. */
export const BACK_UP_NOW_LABEL = 'Back up now';
/** The tooltip of Back up now. */
export const BACK_UP_NOW_TITLE = 'Write a backup of the database now';
/** The caption of the last backup attempt. */
export const LAST_BACKUP_LABEL = 'Last backup';
/** The last attempt when there was none. */
export const NO_BACKUP_YET_LABEL = 'None';
/** The result of a last attempt that succeeded. */
export const BACKUP_SUCCEEDED_LABEL = 'Succeeded';
/** The caption of the number and size of the copies. */
export const BACKUP_COPIES_LABEL = 'Copies';
/** The tooltip of the number and size of the copies. */
export const BACKUP_COPIES_TITLE = 'Copies of this workspace in the backup folder; older ones are thinned out';
/** The heading of the copies of other lineages. */
export const OTHER_LINEAGES_TITLE = 'Other copies';
/** The tooltip of the heading of the copies of other lineages. */
export const OTHER_LINEAGES_HEADING_TITLE = 'Copies of other databases in this folder; only you delete them';
/** The tooltip of Delete on a copy of another lineage. */
export const DELETE_BACKUP_TITLE = 'Delete this copy; asks first';
/** The alert when the backup section could not be loaded. */
export const BACKUP_LOAD_FAILED = 'The backup settings could not be loaded';

/**
 * The number and total size of the copies: '3 copies, 12.0 MiB'.
 *
 * @param count the number of copies
 * @param size the total size, formatted
 * @returns the text
 */
export const backupCopiesText = (count: number, size: string) => `${count} ${count === 1 ? 'copy' : 'copies'}, ${size}`;

/**
 * The accessible name of Delete on one copy: 'Delete backup of 28/11/2026, 09:05:03'.
 *
 * @param when the time of the copy, formatted
 * @returns the name
 */
export const deleteBackupLabel = (when: string) => `Delete backup of ${when}`;

/**
 * The banner line after a failed backup: 'The last backup failed: <reason>'.
 *
 * @param reason the fixed message of the failure
 * @returns the line
 */
export const backupFailedLine = (reason: string) => `The last backup failed: ${reason}`;
