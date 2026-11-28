import { errorLogLine, logLine, type LineLog } from '@assetforge/core';

// The lines the main process writes about its own failures and about the job recovery on open. Every line is built
// by `logLine` or `errorLogLine`, so it carries a fixed text, ids, counts and codes, never a path, a name, a URL or
// a message. Kept free of Electron imports.

/** The event of an IPC handler that threw something other than a domain error. */
export const IPC_FAILED_EVENT = 'IPC handler failed';
/** The event of an IPC answer that does not match the contract of its channel. */
export const IPC_CONTRACT_EVENT = 'IPC response violates the contract';
/** The event of the job recovery on a workspace open. */
export const JOB_RECOVERY_EVENT = 'Job recovery on workspace open';

/** What the job host did to the jobs of a workspace being opened. */
export interface JobRecoveryCounts {
  /** Rows found `running` and put back to `queued`. */
  released: number;
  /** Rows found `running` and put back to waiting with their attempt spent. */
  retried: number;
  /** Rows found `running` and ended as failed. */
  failed: number;
  /** Analysis jobs without a provider assigned to the first entry. */
  unroutedAssigned: number;
  /** Pending generations whose job had ended, closed. */
  generationsEnded: number;
}

/**
 * The main console as the default log: one line per call.
 *
 * @param line the line
 */
export const consoleLog: LineLog = (line: string): void => {
  console.error(line);
};

/**
 * The line of an IPC handler that failed unexpectedly.
 *
 * @param channel the channel; a name of the contract, or anything the renderer sent (written as `?` when unsafe)
 * @param error what the handler threw
 * @returns the line, e.g. `IPC handler failed: channel=files:list error=Error code=SQLITE_BUSY`
 */
export function ipcFailureLine(channel: string | undefined, error: unknown): string {
  return errorLogLine(IPC_FAILED_EVENT, { channel: channel ?? null }, error);
}

/**
 * The line of an IPC answer that the contract refused; the issues are counted, never quoted, because they carry the
 * values of the answer.
 *
 * @param channel the channel
 * @param issueCount how many issues the contract found
 * @returns the line, e.g. `IPC response violates the contract: channel=files:list issues=2`
 */
export function ipcContractLine(channel: string, issueCount: number): string {
  return logLine(IPC_CONTRACT_EVENT, { channel, issues: issueCount });
}

/**
 * The line of one scheduler message. The scheduler's texts are fixed apart from job ids, types and classes; a cause
 * that is a plain object of counts (the stop deadline's `{ abandoned }`) is written as fields, any other cause as its
 * safe description.
 *
 * @param message the scheduler's text
 * @param cause what came with it
 * @returns the line, e.g. `Job outcome could not be stored: error=Error code=SQLITE_BUSY`
 */
export function schedulerLogLine(message: string, cause: unknown): string {
  const counts = countsOf(cause);
  return counts === null ? errorLogLine(message, {}, cause) : logLine(message, counts);
}

/**
 * The fields of a plain object whose every value is a finite number.
 *
 * @param value the cause
 * @returns the fields; null for anything else, also an empty object
 */
function countsOf(value: unknown): Record<string, number> | null {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  const isCounts = entries.every(([key, count]) => /^[A-Za-z]{1,40}$/.test(key) && Number.isFinite(count));
  return isCounts ? (Object.fromEntries(entries) as Record<string, number>) : null;
}

/**
 * The line of the job recovery on a workspace open.
 *
 * @param workspaceId the workspace being opened
 * @param counts what was done
 * @returns the line; null when every count is zero
 */
export function jobRecoveryLine(workspaceId: string, counts: JobRecoveryCounts): string | null {
  const total = counts.released + counts.retried + counts.failed + counts.unroutedAssigned + counts.generationsEnded;
  if (total === 0) return null;
  return logLine(JOB_RECOVERY_EVENT, {
    workspace: workspaceId,
    released: counts.released,
    retried: counts.retried,
    failed: counts.failed,
    unroutedAssigned: counts.unroutedAssigned,
    generationsEnded: counts.generationsEnded,
  });
}
