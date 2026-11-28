import { BACKUP_MESSAGES, type BackupAttempt, type BackupFailureCode } from '@assetforge/contracts';
import { backupFileName } from './backup-names.js';
import { pruneSelection } from './backup-retention.js';
import { BackupError } from './errors.js';
import { errorLogLine, writeLine } from './log-line.js';
import type { BackupLocation, DatabaseSnapshot } from './ports/workspace-backups.js';
import type { WorkspaceHost } from './ports/workspace-host.js';

// The steps of one backup, the same for the open and for a closed database: the place, the snapshot, the copy to
// the place, the pruning of older copies of the lineage and the discard of the snapshot. And the record of the
// attempt that comes out of them.

/** The workspace a backup is made of. */
export interface BackupTarget {
  /** The workspace id. */
  id: string;
  /** The workspace name, written into the info file of a chosen place. */
  name: string;
  /** The workspace folder. */
  rootPath: string;
}

/**
 * Makes one backup: the snapshot is copied into the place of the workspace, then older copies of its lineage are
 * pruned; the snapshot is discarded in every case.
 *
 * @param host gives the backup port and the clock
 * @param target the workspace
 * @param takeSnapshot makes the snapshot (of the open or of the closed database)
 * @param signal aborts the snapshot and the copy
 * @param onSnapshotPhase is handed, once the snapshot starts, a promise that settles (never rejects) when the
 *   snapshot has settled and, when it resolved after the abort, was discarded
 * @returns the change count the snapshot was taken at
 * @throws BackupError or what the port threw
 */
export async function writeBackup(
  host: WorkspaceHost,
  target: BackupTarget,
  takeSnapshot: (signal: AbortSignal) => Promise<DatabaseSnapshot>,
  signal: AbortSignal,
  onSnapshotPhase: (settled: Promise<void>) => void = () => undefined,
): Promise<number> {
  throwIfAborted(signal);
  const location = await host.backups.locationOf(target);
  throwIfAborted(signal);
  const taking = takeSnapshot(signal).then((snapshot) => discardIfAborted(snapshot, signal));
  onSnapshotPhase(taking.then(ignore, ignore));
  const snapshot = await taking;
  try {
    if (snapshot.lineageId === null || snapshot.lineageId === '') throw new BackupError('backup_failed');
    throwIfAborted(signal);
    const name = backupFileName(snapshot.lineageId, host.now(), snapshot.appliedMigrations);
    await host.backups.write(snapshot, location, name, signal);
    await pruneQuietly(host, location, snapshot.lineageId, name);
    return snapshot.changeCount;
  } finally {
    await discardQuietly(snapshot);
  }
}

/**
 * The record of a successful attempt.
 *
 * @param host gives the clock
 * @returns the attempt
 */
export function succeededAttempt(host: WorkspaceHost): BackupAttempt {
  return { at: host.now().toISOString(), ok: true, code: null, message: null };
}

/**
 * The record of a failed attempt, with one safe log line.
 *
 * @param host gives the clock and the log
 * @param workspaceId the workspace
 * @param error what the attempt failed with
 * @returns the attempt with the code and its fixed message
 */
export function failedAttempt(host: WorkspaceHost, workspaceId: string, error: unknown): BackupAttempt {
  const code = failureCodeOf(error);
  writeLine(host.log, errorLogLine('Backup failed', { workspace: workspaceId, code }, error));
  return { at: host.now().toISOString(), ok: false, code, message: BACKUP_MESSAGES[code] };
}

/**
 * The failure code of an error: a `BackupError` keeps its code, anything else (an abort too) is `backup_failed`.
 *
 * @param error what was thrown
 * @returns the code
 */
export function failureCodeOf(error: unknown): BackupFailureCode {
  return error instanceof BackupError ? error.code : 'backup_failed';
}

/**
 * Deletes the copies of the lineage the retention rule lets go; a failing listing or delete is ignored, because the
 * backup itself is written.
 *
 * @param host gives the backup port and the clock
 * @param location the place
 * @param lineageId the lineage just backed up
 * @param justWritten the name just written
 * @returns resolves once the pruning ended either way
 */
async function pruneQuietly(
  host: WorkspaceHost,
  location: BackupLocation,
  lineageId: string,
  justWritten: string,
): Promise<void> {
  let names: string[];
  try {
    names = (await host.backups.list(location.directory)).map((file) => file.name);
  } catch {
    return; // The next successful backup prunes again.
  }
  for (const name of pruneSelection(names, lineageId, justWritten, host.now())) {
    try {
      await host.backups.remove(location.directory, name);
    } catch {
      // Best effort: a copy left over is pruned by a later backup.
    }
  }
}

/**
 * Discards a snapshot, ignoring a failure.
 *
 * @param snapshot the snapshot
 * @returns resolves once the discard ended either way
 */
async function discardQuietly(snapshot: DatabaseSnapshot): Promise<void> {
  try {
    await snapshot.discard();
  } catch {
    // The port promises never to reject; a leftover temporary file is swept on the next open.
  }
}

/**
 * The step after the snapshot: a snapshot that resolved after the abort is discarded and the backup fails.
 *
 * @param snapshot the snapshot just taken
 * @param signal the signal of the backup
 * @returns the snapshot while the backup was not aborted
 * @throws BackupError `backup_failed` once a late snapshot was discarded
 */
async function discardIfAborted(snapshot: DatabaseSnapshot, signal: AbortSignal): Promise<DatabaseSnapshot> {
  if (!signal.aborted) return snapshot;
  await discardQuietly(snapshot);
  throw new BackupError('backup_failed');
}

/** Ignores the outcome of a promise. */
function ignore(): void {}

/**
 * Stops a backup whose signal was aborted.
 *
 * @param signal the signal of the backup
 * @throws BackupError `backup_failed` when it was aborted
 */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new BackupError('backup_failed');
}
