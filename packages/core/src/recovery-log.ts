import { errorLogLine, logLine, writeLine, type LineLog, type LogFieldValue } from './log-line.js';

// The log lines of the startup recovery: one summary per workspace open with work to report, and one line per item
// that could not be repaired. A line names ids and counts only, never a path or an entry name read from disk.

/** The fixed event text of the summary line. */
export const RECOVERY_SUMMARY_EVENT = 'Recovery on workspace open';
/** The fixed event text of a line for an item that could not be repaired. */
export const RECOVERY_FAILURE_EVENT = 'Recovery could not repair an item';

/**
 * What could not be repaired: a pending import row, an orphaned staging entry, an open file move, a trash binary
 * or a purge tombstone, or the listing a whole step reads first.
 */
export type RecoveryItem =
  | 'import'
  | 'import list'
  | 'staging entry'
  | 'staging list'
  | 'file move'
  | 'move list'
  | 'trash binary'
  | 'tombstone'
  | 'trash list';

/**
 * Told about every item a recovery step leaves as it was; the step still never rejects.
 *
 * @param item what could not be repaired
 * @param fileId the file row it belongs to; null when it has none or its name comes from disk
 * @param error what went wrong
 */
export type RecoveryFailureReport = (item: RecoveryItem, fileId: string | null, error: unknown) => void;

/** The counts of one open's recovery, as the summary line shows them. */
export interface RecoveryCounts {
  importsFailed: number;
  importsDiscarded: number;
  stagingRemoved: number;
  pathsSkipped: number;
  movesCompleted: number;
  movesDiscarded: number;
  trashRemoved: number;
  trashSkipped: number;
  /** The items reported through `RecoveryFailureReport`. */
  unrepaired: number;
}

/**
 * Hands a failure to the report; a report that throws changes nothing about the recovery.
 *
 * @param report the step's report; nothing happens without one
 * @param item what could not be repaired
 * @param fileId the file row it belongs to; null for none
 * @param error what went wrong
 */
export function reportRecoveryFailure(
  report: RecoveryFailureReport | undefined,
  item: RecoveryItem,
  fileId: string | null,
  error: unknown,
): void {
  try {
    report?.(item, fileId, error);
  } catch {
    // The report is a trace; the recovery goes on without it.
  }
}

/**
 * A report that writes one line per item and counts the items for the summary.
 *
 * @param log the host's log; the lines are dropped without one, the count is kept
 * @param workspaceId the workspace being opened
 * @returns the report and a reader of how many items it took
 */
export function createRecoveryFailureLog(
  log: LineLog | undefined,
  workspaceId: string,
): { report: RecoveryFailureReport; count: () => number } {
  let count = 0;
  const report: RecoveryFailureReport = (item, fileId, error) => {
    count += 1;
    writeLine(log, errorLogLine(RECOVERY_FAILURE_EVENT, { workspace: workspaceId, item, file: fileId }, error));
  };
  return { report, count: () => count };
}

/**
 * Writes the summary line of one open, only when at least one count is not zero.
 *
 * @param log the host's log; nothing is written without one
 * @param workspaceId the workspace being opened
 * @param counts what the recovery did
 */
export function logRecoverySummary(log: LineLog | undefined, workspaceId: string, counts: RecoveryCounts): void {
  const values = Object.values(counts) as number[];
  if (values.every((value) => value === 0)) return;
  const fields: Record<string, LogFieldValue> = { workspace: workspaceId, ...counts };
  writeLine(log, logLine(RECOVERY_SUMMARY_EVENT, fields));
}
