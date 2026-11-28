import { BACKUP_NOT_DELETABLE_MESSAGE, type BackupState } from '@assetforge/contracts';
import { regularBackups } from './backup-listing.js';
import { lineageShortId, parseBackupName } from './backup-names.js';
import type { BackupFolderStatus } from './backup-types.js';
import type { BackupTarget } from './backup-write.js';
import { InvalidOperationError } from './errors.js';
import type { BackupSource } from './ports/workspace-backups.js';
import type { WorkspaceHost } from './ports/workspace-host.js';
import { isSameRoot } from './workspace-manifest.js';

// The backup place of the open workspace as the settings show it, and the deletion of a backup there that belongs to
// another lineage (a backup of the live lineage is only ever pruned by the retention).

/**
 * The state of the backup place of the open workspace. A place that cannot be listed counts as unreachable with no
 * backups.
 *
 * @param host gives the backup port
 * @param workspace the open workspace
 * @param liveLineage the lineage of its database; null when it has none
 * @param state whether a backup runs and the last attempt
 * @returns the place, the counts of the live lineage and the backups of other lineages
 */
export async function backupFolderStatus(
  host: WorkspaceHost,
  workspace: BackupTarget,
  liveLineage: string | null,
  state: BackupState,
): Promise<BackupFolderStatus> {
  const location = await host.backups.locationOf(workspace);
  const backups = await regularBackups(host, location.directory, liveLineage);
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
 * @throws InvalidOperationError when it is not a regular backup of another lineage in the place
 */
export async function deleteOtherLineageBackup(
  host: WorkspaceHost,
  workspace: BackupTarget,
  liveLineage: string | null,
  source: BackupSource,
): Promise<void> {
  const parsed = parseBackupName(source.name);
  const location = await host.backups.locationOf(workspace);
  const inPlace = source.directory !== null && isSameRoot(source.directory, location.directory);
  const ownLineage = parsed !== null && liveLineage !== null && parsed.lineageShortId === lineageShortId(liveLineage);
  if (source.origin !== 'regular' || !inPlace || parsed === null || ownLineage) {
    throw new InvalidOperationError(BACKUP_NOT_DELETABLE_MESSAGE);
  }
  await host.backups.remove(location.directory, parsed.name);
}
