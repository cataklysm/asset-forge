import { BACKUP_NOT_DELETABLE_MESSAGE, type BackupState } from '@assetforge/contracts';
import { regularBackups } from './backup-listing.js';
import { lineageShortId, parseBackupName } from './backup-names.js';
import type { BackupFolderStatus } from './backup-types.js';
import type { BackupTarget } from './backup-write.js';
import { BackupError, InvalidOperationError } from './errors.js';
import type { BackupLocation, BackupSource } from './ports/workspace-backups.js';
import type { WorkspaceHost } from './ports/workspace-host.js';
import { isSameRoot } from './workspace-manifest.js';

// The backup place of the open workspace as the settings show it, and the deletion of a backup there that belongs to
// another lineage (a backup of the live lineage is only ever pruned by the retention).

/**
 * The state of the backup place of the open workspace. A place that cannot be resolved or listed counts as
 * unreachable with no backups.
 *
 * @param host gives the backup port
 * @param workspace the open workspace
 * @param liveLineage the lineage of its database; null when it has none
 * @param state whether a backup runs and the last attempt
 * @returns the place (null when it could not be resolved), the counts of the live lineage and the backups of other
 *   lineages
 */
export async function backupFolderStatus(
  host: WorkspaceHost,
  workspace: BackupTarget,
  liveLineage: string | null,
  state: BackupState,
): Promise<BackupFolderStatus> {
  const location = await locationOrNull(host, workspace);
  const backups = location === null ? null : await regularBackups(host, location.directory, liveLineage);
  const own = (backups ?? []).filter((backup) => backup.sameLineage);
  return {
    location,
    reachable: backups !== null,
    running: state.running,
    last: state.last,
    count: own.length,
    totalBytes: own.reduce((total, backup) => total + backup.sizeBytes, 0),
    otherLineages: (backups ?? []).filter((backup) => !backup.sameLineage),
  };
}

/**
 * Deletes a regular backup of another lineage from the place of the open workspace.
 *
 * @param host gives the backup port
 * @param workspace the open workspace
 * @param liveLineage the lineage of its database; null when it has none
 * @param source the backup
 * @returns resolves once it is gone
 * @throws InvalidOperationError when it is not a regular backup of another lineage in the place, or the live lineage
 *   is unknown; BackupError `backup_location_unreachable` when the place cannot be resolved
 */
export async function deleteOtherLineageBackup(
  host: WorkspaceHost,
  workspace: BackupTarget,
  liveLineage: string | null,
  source: BackupSource,
): Promise<void> {
  const parsed = parseBackupName(source.name);
  if (liveLineage === null || liveLineage === '' || parsed === null || source.origin !== 'regular') {
    throw new InvalidOperationError(BACKUP_NOT_DELETABLE_MESSAGE);
  }
  const location = await locationOrNull(host, workspace);
  if (location === null) throw new BackupError('backup_location_unreachable');
  const inPlace = source.directory !== null && isSameRoot(source.directory, location.directory);
  if (!inPlace || parsed.lineageShortId === lineageShortId(liveLineage)) {
    throw new InvalidOperationError(BACKUP_NOT_DELETABLE_MESSAGE);
  }
  await host.backups.remove(location.directory, parsed.name);
}

/**
 * The backup place of a workspace.
 *
 * @param host gives the backup port
 * @param workspace the workspace
 * @returns the place; null when it could not be resolved
 */
async function locationOrNull(host: WorkspaceHost, workspace: BackupTarget): Promise<BackupLocation | null> {
  try {
    return await host.backups.locationOf(workspace);
  } catch {
    return null;
  }
}
