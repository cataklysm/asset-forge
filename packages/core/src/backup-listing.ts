import { join } from 'node:path';
import { BACKUP_FOLDER_NAME } from '@assetforge/contracts';
import { lineageShortId, parseBackupName } from './backup-names.js';
import type { ListedBackup } from './backup-types.js';
import type { BackupTarget } from './backup-write.js';
import { WorkspaceNotFoundError } from './errors.js';
import type { BackupFileInfo } from './ports/workspace-backups.js';
import type { WorkspaceDatabase } from './ports/workspace-database.js';
import type { WorkspaceHost } from './ports/workspace-host.js';
import { comparableRoot, readManifest } from './workspace-manifest.js';
import { requireReachable } from './workspace-open.js';

// The backups a workspace can be restored from: the copies made before pending migrations beside its local
// database, the regular backups in its place, and those in a folder the user picked (the folder itself, or the
// `assetforge-backups/<id>` directory a chosen place has inside it). A place that cannot be read gives nothing.

/** The backups of a workspace and whether its place could not be listed. */
export interface WorkspaceBackupList {
  /** Newest first. */
  backups: ListedBackup[];
  /** True when the configured or default place could not be listed. */
  unreachable: boolean;
}

/**
 * Lists the backups of a workspace.
 *
 * @param host gives the backup port
 * @param workspace the workspace's id, name and folder
 * @param extraDirectory a further directory the user picked; null for none
 * @param liveLineage the lineage of the workspace's live database; null when it is missing or has none
 * @returns the backups, newest first, and whether the place could not be listed
 */
export async function listWorkspaceBackups(
  host: WorkspaceHost,
  workspace: BackupTarget,
  extraDirectory: string | null,
  liveLineage: string | null,
): Promise<WorkspaceBackupList> {
  const local = await localBackups(host, workspace.id, liveLineage);
  const place = await placeBackups(host, workspace, liveLineage);
  const extra: ListedBackup[] = [];
  if (extraDirectory !== null) {
    for (const directory of [extraDirectory, join(extraDirectory, BACKUP_FOLDER_NAME, workspace.id)]) {
      extra.push(...((await regularBackups(host, directory, liveLineage)) ?? []));
    }
  }
  const backups = unique([...local, ...(place ?? []), ...extra]).sort(newestFirst);
  return { backups, unreachable: place === null };
}

/**
 * The workspace a listing is asked for: a registered one by id, or the one in a folder by its manifest.
 *
 * @param host gives the registry and the storage
 * @param workspace the id or the folder
 * @returns its id, name and folder
 * @throws WorkspaceNotFoundError for an unknown id; what reading the manifest threw for a folder
 */
export async function resolveBackupTarget(
  host: WorkspaceHost,
  workspace: { id: string } | { rootPath: string },
): Promise<BackupTarget> {
  if ('id' in workspace) {
    const entry = await host.registry.get(workspace.id);
    if (entry === null) throw new WorkspaceNotFoundError('No workspace found there');
    return { id: entry.id, name: entry.name, rootPath: entry.rootPath };
  }
  const storage = host.createStorage(workspace.rootPath);
  await requireReachable(storage);
  const manifest = await readManifest(storage);
  return { id: manifest.id, name: manifest.name, rootPath: workspace.rootPath };
}

/**
 * The lineage of a workspace's live database: of the open one when it is open, else read from the closed file.
 *
 * @param host gives the backup port
 * @param workspaceId the workspace
 * @param openDatabase the open database of this workspace; null when it is not open
 * @returns the lineage; null when the database is missing, has none or could not be read
 */
export async function liveLineageOf(
  host: WorkspaceHost,
  workspaceId: string,
  openDatabase: WorkspaceDatabase | null,
): Promise<string | null> {
  let lineageId: string | null | undefined;
  try {
    if (openDatabase !== null) lineageId = (await openDatabase.meta.get())?.lineageId;
    else if (await host.databaseExists(workspaceId)) lineageId = await host.backups.localLineage(workspaceId);
  } catch {
    return null; // An unknown lineage matches no backup, so nothing counts as the live one.
  }
  return lineageId === undefined || lineageId === null || lineageId === '' ? null : lineageId;
}

/**
 * The copies made before pending migrations; a failure gives none.
 *
 * @param host gives the backup port
 * @param workspaceId the workspace
 * @param liveLineage the live lineage; such a copy has it whenever the database has one
 * @returns the copies
 */
async function localBackups(
  host: WorkspaceHost,
  workspaceId: string,
  liveLineage: string | null,
): Promise<ListedBackup[]> {
  try {
    const files = await host.backups.listLocal(workspaceId);
    return files.map((file): ListedBackup => ({
      source: { origin: 'pre_migration', directory: null, name: file.name },
      createdAt: file.createdAt,
      sizeBytes: file.sizeBytes,
      appliedMigrations: file.appliedMigrations,
      origin: 'pre_migration',
      sameLineage: liveLineage !== null,
    }));
  } catch {
    return [];
  }
}

/**
 * The regular backups in the place of the workspace.
 *
 * @param host gives the backup port
 * @param workspace the workspace
 * @param liveLineage the live lineage
 * @returns the backups; null when the place could not be resolved or listed
 */
async function placeBackups(
  host: WorkspaceHost,
  workspace: BackupTarget,
  liveLineage: string | null,
): Promise<ListedBackup[] | null> {
  try {
    const location = await host.backups.locationOf(workspace);
    return await regularBackups(host, location.directory, liveLineage);
  } catch {
    return null;
  }
}

/**
 * The regular backups in one directory: the files whose name parses.
 *
 * @param host gives the backup port
 * @param directory the absolute directory
 * @param liveLineage the live lineage
 * @returns the backups; null when the directory could not be listed
 */
export async function regularBackups(
  host: WorkspaceHost,
  directory: string,
  liveLineage: string | null,
): Promise<ListedBackup[] | null> {
  let files: BackupFileInfo[];
  try {
    files = await host.backups.list(directory);
  } catch {
    return null;
  }
  const liveShortId = liveLineage === null ? null : lineageShortId(liveLineage);
  const backups: ListedBackup[] = [];
  for (const file of files) {
    const parsed = parseBackupName(file.name);
    if (parsed === null) continue;
    backups.push({
      source: { origin: 'regular', directory, name: parsed.name },
      createdAt: parsed.createdAt,
      sizeBytes: file.sizeBytes,
      appliedMigrations: parsed.appliedMigrations,
      origin: 'regular',
      sameLineage: parsed.lineageShortId === liveShortId,
    });
  }
  return backups;
}

/**
 * Drops repeated backups (the same directory, compared like workspace folders, and name, as when the picked folder
 * is the place itself).
 *
 * @param backups the backups
 * @returns the first of each
 */
function unique(backups: readonly ListedBackup[]): ListedBackup[] {
  const seen = new Set<string>();
  return backups.filter((backup) => {
    const directory = backup.source.directory === null ? '' : comparableRoot(backup.source.directory);
    const key = `${backup.source.origin}\n${directory}\n${backup.source.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Newest first: by creation time, then by applied migrations, each descending.
 *
 * @param first one backup
 * @param second another backup
 * @returns negative when `first` comes first
 */
function newestFirst(first: ListedBackup, second: ListedBackup): number {
  const byTime = Date.parse(second.createdAt) - Date.parse(first.createdAt);
  if (byTime !== 0) return byTime;
  return second.appliedMigrations - first.appliedMigrations;
}
