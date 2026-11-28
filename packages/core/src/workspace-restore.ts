import {
  BACKUP_DAMAGED_MESSAGE,
  BACKUP_FOREIGN_MESSAGE,
  BACKUP_NEWER_MESSAGE,
  WORKSPACE_FORMAT_VERSION,
  type WorkspaceManifest,
} from '@assetforge/contracts';
import { UnsupportedFormatVersionError, ValidationFailedError, WorkspaceMismatchError } from './errors.js';
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
 * @returns resolves once the backup is the live database
 * @throws what the check or the swap threw; the staged copy is discarded then
 */
export async function installBackup(
  host: WorkspaceHost,
  manifest: WorkspaceManifest,
  source: BackupSource,
): Promise<void> {
  const staged = await stageCheckedRestore(host, manifest, source, new AbortController().signal);
  try {
    await staged.install();
  } catch (error) {
    await staged.discard();
    throw error;
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
