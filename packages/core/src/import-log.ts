import { isUnexpectedError } from './error-description.js';
import { InvalidOperationError } from './errors.js';
import { errorLogLine, writeLine, type LineLog } from './log-line.js';

// The log line of an import that failed for a reason the code did not expect. The user sees the generic
// `Import failed` (with a system code at most) in `file.error`; the line keeps the trace without a path or name.

/** The fixed event text of the line. */
export const IMPORT_FAILED_EVENT = 'Import failed unexpectedly';

/**
 * What was being imported: a file on disk, a ZIP archive, one entry of it, a download's body, or the placement of
 * an imported file in its target asset.
 */
export type ImportOperation = 'import' | 'archive' | 'archive entry' | 'download' | 'placement';

/** The ids that say which import failed; a missing one is left out of the line. */
export interface ImportFailureIds {
  /** The file row; absent before the row exists. */
  file?: string;
  /** The position of an archive entry in the directory. */
  entry?: number;
}

/**
 * Writes one line for an import that failed unexpectedly; a domain, job, remote or abort error writes nothing, since
 * its code already tells the user why.
 *
 * @param log the host's log; nothing is written without one
 * @param operation what was being imported
 * @param ids the file row and the archive entry, where known
 * @param error what ended the import
 */
export function logImportFailure(
  log: LineLog | undefined,
  operation: ImportOperation,
  ids: ImportFailureIds,
  error: unknown,
): void {
  if (log === undefined || !isUnexpectedFailure(error)) return;
  const fields = { operation, file: ids.file ?? null, entry: ids.entry ?? null };
  writeLine(log, errorLogLine(IMPORT_FAILED_EVENT, fields, error));
}

/** The fixed event text of a download that ends as `internal_error`. */
export const DOWNLOAD_FAILED_EVENT = 'Download failed unexpectedly';

/**
 * Writes one line for a download job that failed with an error that is not a `JobError` and therefore ends as
 * `internal_error`; the job id is the only id, since the URL and its host never enter a line.
 *
 * @param log the host's log; nothing is written without one
 * @param jobId the download job
 * @param error what ended the download
 */
export function logDownloadFailure(log: LineLog | undefined, jobId: string, error: unknown): void {
  if (log === undefined) return;
  writeLine(log, errorLogLine(DOWNLOAD_FAILED_EVENT, { operation: 'download', job: jobId }, error));
}

/**
 * Whether an import failure is worth a line: an unexpected error, or an `InvalidOperationError` that wraps one (the
 * journaled move turns a failed binary move into `This file could not be moved` with the raw error as its cause).
 *
 * @param error what ended the import
 * @returns whether the failure is logged
 */
function isUnexpectedFailure(error: unknown): boolean {
  if (isUnexpectedError(error)) return true;
  return error instanceof InvalidOperationError && error.cause !== undefined && isUnexpectedError(error.cause);
}
