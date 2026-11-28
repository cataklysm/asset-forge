/** The status text of a succeeded download whose content was already in the workspace. */
export const ALREADY_PRESENT_LABEL = 'Already present';

/** The choice before importing picked ZIP archives (ZipChoiceDialog). */
export const ZIP_ARCHIVE_TITLE = 'ZIP archive';
export const UNPACK_LABEL = 'Unpack';
export const UNPACK_TITLE = 'Imports each file inside the archive';
export const IMPORT_AS_FILE_LABEL = 'Import as file';
export const IMPORT_AS_FILE_TITLE = 'Imports the archive itself as one file';
export const ZIP_CANCEL_TITLE = 'Imports nothing';

/**
 * '2 archives'; the dialog names a single archive by its file name instead.
 *
 * @param count the number of picked archives
 * @returns the count text
 */
export function archiveCountLabel(count: number): string {
  return `${count} archives`;
}

/** The progress of a running file import (ImportProgressView). */
export const IMPORT_PROGRESS_LABEL = 'Import progress';
/** Shown while the import call runs and no progress is known yet. */
export const IMPORTING_TEXT = 'Importing…';
export const IMPORT_CANCEL_LABEL = 'Cancel';
export const IMPORT_CANCEL_TITLE = 'Stops after the current file';

/**
 * '3 of 10'.
 *
 * @param done the number of finished items
 * @param total the number of items in the import
 * @returns the progress text
 */
export function importCountText(done: number, total: number): string {
  return `${done} of ${total}`;
}

/** The import from a list of addresses (UrlImportDialog) and its entry buttons. */
export const URL_IMPORT_LABEL = 'Import from URLs';
export const URLS_LABEL = 'URLs';
export const URLS_TITLE = 'One address per line';
export const SKIP_DUPLICATES_LABEL = 'Skip duplicates';
export const SKIP_DUPLICATES_TITLE = 'Identical content is not stored again';
export const IMPORT_LABEL = 'Import';

/**
 * 'At most 5000 addresses at once'.
 *
 * @param max the most lines one URL import takes
 * @returns the tooltip of a refused list
 */
export function tooManyUrlsTitle(max: number): string {
  return `At most ${max} addresses at once`;
}

/** The count lines of a started URL import, in their order: 'Queued 3'. */
export const URL_IMPORT_COUNT_LABELS = {
  queued: 'Queued',
  alreadyImported: 'Already imported',
  alreadyQueued: 'Already queued',
  invalid: 'Not usable',
} as const;

/** The status texts of a succeeded download that the site profile's kinds or minimum size left out. */
export const FILTERED_KIND_LABEL = 'Filtered: kind';
export const FILTERED_SIZE_LABEL = 'Filtered: below minimum size';
/** A download of an older version that was left out for either reason. */
export const FILTERED_LABEL = 'Filtered';
