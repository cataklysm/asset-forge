import { randomUUID } from 'node:crypto';
import { BACKUP_STALE_MESSAGE, type BackupEntry } from '@assetforge/contracts';
import { InvalidOperationError, type BackupSource, type ListedBackup } from '@assetforge/core';

// The opaque backup ids: every listing replaces the ids of its workspace and scope, so the renderer only ever names a
// backup of the latest listing and never sends a path.

/** Which listing an id belongs to: the restore listing of `workspace:backups` or the settings' `backup:status`. */
export type BackupIdScope = 'restore' | 'status';

/** Hands out the opaque ids of the backups the renderer sees and resolves them back to their source. */
export class BackupIdTable {
  /** Per scope and workspace, the sources of the latest listing by id. */
  private readonly listings = new Map<string, Map<string, BackupSource>>();

  /**
   * Replaces the ids of one workspace and scope by fresh ids for a new listing.
   *
   * @param scope the listing kind
   * @param workspaceId the workspace the backups belong to
   * @param backups the listed backups
   * @returns the entries as the renderer sees them, in the same order
   */
  issue(scope: BackupIdScope, workspaceId: string, backups: readonly ListedBackup[]): BackupEntry[] {
    const sources = new Map<string, BackupSource>();
    const entries = backups.map((backup) => {
      const backupId = randomUUID();
      sources.set(backupId, backup.source);
      return {
        backupId,
        createdAt: backup.createdAt,
        sizeBytes: backup.sizeBytes,
        appliedMigrations: backup.appliedMigrations,
        origin: backup.origin,
        sameLineage: backup.sameLineage,
      };
    });
    this.listings.set(keyOf(scope, workspaceId), sources);
    return entries;
  }

  /**
   * The source of an id of the latest listing of one workspace and scope.
   *
   * @param scope the listing kind
   * @param workspaceId the workspace the id must belong to
   * @param backupId the id
   * @returns the source
   * @throws InvalidOperationError `Load the backups again` for an id that is not of that listing
   */
  resolve(scope: BackupIdScope, workspaceId: string, backupId: string): BackupSource {
    const source = this.listings.get(keyOf(scope, workspaceId))?.get(backupId);
    if (source === undefined) throw new InvalidOperationError(BACKUP_STALE_MESSAGE);
    return source;
  }

  /**
   * Forgets the ids of one workspace, for example after its backups changed.
   *
   * @param workspaceId the workspace
   */
  forget(workspaceId: string): void {
    this.listings.delete(keyOf('restore', workspaceId));
    this.listings.delete(keyOf('status', workspaceId));
  }
}

/**
 * The map key of one listing.
 *
 * @param scope the listing kind
 * @param workspaceId the workspace
 * @returns the key
 */
function keyOf(scope: BackupIdScope, workspaceId: string): string {
  return `${scope}:${workspaceId}`;
}
