import { fileCount } from './counts';

/** The trash: its navigation entry, the Delete, Restore and permanent delete actions and their confirmation. */
export const TRASH_LABEL = 'Trash';
export const DELETE_LABEL = 'Delete';
export const DELETE_TITLE = 'Moves the file to the trash';
export const DELETE_SELECTION_TITLE = 'Moves the files to the trash';
export const RESTORE_LABEL = 'Restore';
export const RESTORE_TITLE = 'Puts the file back where it was';
export const RESTORE_SELECTION_TITLE = 'Puts the files back where they were';
export const PURGE_LABEL = 'Delete permanently';
export const PURGE_TITLE = 'Removes the file from disk; asks first';
export const PURGE_SELECTION_TITLE = 'Removes the files from disk; asks first';
export const EMPTY_TRASH_LABEL = 'Empty trash';
export const EMPTY_TRASH_TITLE = 'Removes every file in the trash from disk; asks first';

/** The origin of a trashed file that came from the inbox. */
export const INBOX_LABEL = 'Inbox';
/** The Trash screen. */
export const TRASH_EMPTY_TEXT = 'Trash is empty';
export const DELETED_LABEL = 'Deleted';
export const ORIGIN_LABEL = 'Origin';

/**
 * 'Delete 1 file permanently?' / 'Delete 12 files permanently?'.
 *
 * @param count the number of files to purge
 * @returns the title of the purge confirmation
 */
export function purgeConfirmTitle(count: number): string {
  return `Delete ${fileCount(count)} permanently?`;
}

/**
 * The accessible name of the trash navigation entry with its count: 'Trash, 3 files'.
 *
 * @param count the number of files in the trash
 * @returns the accessible name
 */
export function trashNavLabel(count: number): string {
  return `${TRASH_LABEL}, ${fileCount(count)}`;
}
