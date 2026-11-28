import {
  BACKUP_DAMAGED_MESSAGE,
  BACKUP_FOREIGN_MESSAGE,
  BACKUP_NEWER_MESSAGE,
  WORKSPACE_FORMAT_VERSION,
  type WorkspaceManifest,
} from '@assetforge/contracts';
import { BackupError, UnsupportedFormatVersionError, ValidationFailedError, WorkspaceMismatchError } from './errors.js';
import { errorLogLine, writeLine } from './log-line.js';
import type { BackupSource, StagedRestore } from './ports/workspace-backups.js';
import type { WorkspaceHost } from './ports/workspace-host.js';

// The decisions of a restore: a backup is copied beside the local database and checked there; a damaged one, one of
// another workspace and one from a newer app are refused before anything replaces the database.

/**
 * Stages a backup and checks what it holds.
 *
 * @param host gives the backup port
 * @param manifest the manifest of the workspace being restored
 * @param source the backup
 * @param signal aborts the copy
 * @returns the staged copy, which belongs to the workspace and can be read by this app
 * @throws ValidationFailedError for a damaged copy, WorkspaceMismatchError for another workspace's,
 *   UnsupportedFormatVersionError for one from a newer app; the staged copy is discarded first
 */
export async function stageCheckedRestore(
  host: WorkspaceHost,
  manifest: WorkspaceManifest,
  source: BackupSource,
  signal: AbortSignal,
): Promise<StagedRestore> {
  const staged = await host.backups.stageRestore(manifest.id, source, signal);
  const refusal = refusalOf(staged, manifest);
  if (refusal !== null) {
    await staged.discard();
    throw refusal;
  }
  return staged;
}

/**
 * Replaces the local database of a closed workspace by a checked backup.
 *
 * @param host gives the backup port
 * @param manifest the manifest of the workspace
 * @param source the backup
 * @param signal aborts the copy; a stage that resolves after the abort is discarded and never installed
 * @returns the installed copy, whose `revert()` undoes the install
 * @throws what the check, the stage or the swap threw (BackupError `backup_failed` after an abort); the staged copy
 *   is discarded then
 */
export async function installBackup(
  host: WorkspaceHost,
  manifest: WorkspaceManifest,
  source: BackupSource,
  signal: AbortSignal,
): Promise<StagedRestore> {
  const staged = await stageCheckedRestore(host, manifest, source, signal);
  try {
    if (signal.aborted) throw new BackupError('backup_failed');
    await staged.install();
    return staged;
  } catch (error) {
    await staged.discard();
    throw error;
  }
}

/**
 * Undoes an install whose open failed; a failure is swallowed and logged once as a safe line.
 *
 * @param host gives the log
 * @param workspaceId the workspace
 * @param installed the installed copy
 * @returns resolves once the revert ended either way
 */
export async function revertQuietly(host: WorkspaceHost, workspaceId: string, installed: StagedRestore): Promise<void> {
  try {
    await installed.revert();
  } catch (error) {
    writeLine(host.log, errorLogLine('Restore could not be undone', { workspace: workspaceId }, error));
  }
}

/**
 * Why a staged copy may not replace the database.
 *
 * @param staged the staged copy
 * @param manifest the manifest of the workspace
 * @returns the error to refuse with; null when it may
 */
function refusalOf(staged: StagedRestore, manifest: WorkspaceManifest): Error | null {
  const facts = staged.facts;
  if (facts === null) return new ValidationFailedError(BACKUP_DAMAGED_MESSAGE);
  if (facts.workspaceId !== manifest.id) return new WorkspaceMismatchError(BACKUP_FOREIGN_MESSAGE);
  if (facts.formatVersion > WORKSPACE_FORMAT_VERSION || facts.newerThanApp) {
    return new UnsupportedFormatVersionError(BACKUP_NEWER_MESSAGE);
  }
  return null;
}
