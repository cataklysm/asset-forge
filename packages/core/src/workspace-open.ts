import type { WorkspaceManifest, WorkspaceSummary } from '@assetforge/contracts';
import { recoverFileMoves } from './file-move-recovery.js';
import { ensureBuiltInAssetTypes } from './asset-types.js';
import { StorageUnreachableError, WorkspaceDuplicateError, WorkspaceMismatchError } from './errors.js';
import { sweepTrash } from './trash-sweep.js';
import type { Storage } from './ports/storage.js';
import type { WorkspaceDatabase } from './ports/workspace-database.js';
import type { WorkspaceHost } from './ports/workspace-host.js';
import { recoverIncompleteImports } from './recover-imports.js';
import {
  createRecoveryFailureLog,
  logRecoverySummary,
  reportRecoveryFailure,
  type RecoveryFailureReport,
} from './recovery-log.js';
import { ensureBuiltInWorkflowTemplates } from './workflow-templates.js';
import { holdsWorkspace, isSameRoot } from './workspace-manifest.js';

/** The workspace the manager has open. */
export interface OpenWorkspace {
  /** Its registry entry as written by the open. */
  summary: WorkspaceSummary;
  /** The storage of its folder. */
  storage: Storage;
  /** ID of its primary storage row. */
  storageId: string;
  /** Its open local database. */
  database: WorkspaceDatabase;
}

/**
 * Refuses a storage that cannot be reached.
 *
 * @param storage the storage of a workspace folder
 * @returns resolves when it is reachable
 * @throws `StorageUnreachableError` otherwise
 */
export async function requireReachable(storage: Storage): Promise<void> {
  if (!(await storage.isReachable())) {
    throw new StorageUnreachableError('Storage is not reachable');
  }
}

/**
 * A workspace id is known under one root. Opening it under another root is a move when
 * the old root no longer holds this workspace, and a copy when it still does; a copy
 * would share the database of the original, so it is rejected before anything changes.
 *
 * @param host gives the registry and the storage of the known root
 * @param id the workspace id from the manifest
 * @param rootPath the root it is being opened under
 * @returns resolves when the open may go on
 * @throws `WorkspaceDuplicateError` for a copy
 */
export async function rejectCopy(host: WorkspaceHost, id: string, rootPath: string): Promise<void> {
  const known = await host.registry.get(id);
  if (known === null || isSameRoot(known.rootPath, rootPath)) return;
  if (await holdsWorkspace(host, known.rootPath, id)) {
    throw new WorkspaceDuplicateError('This workspace is already known');
  }
}

/**
 * Opens the workspace's database and brings it and the folder up to date. A failure closes the database again
 * and rethrows the error of the failed step.
 *
 * @param host the host services
 * @param storage the storage of the workspace folder
 * @param manifest the checked manifest
 * @param rootPath the folder
 * @returns the open workspace, already written to the registry
 */
export async function openWorkspaceDatabase(
  host: WorkspaceHost,
  storage: Storage,
  manifest: WorkspaceManifest,
  rootPath: string,
): Promise<OpenWorkspace> {
  const database = await host.openDatabase(manifest.id);
  try {
    return await prepareWorkspace(host, storage, database, manifest, rootPath);
  } catch (error) {
    await closeQuietly(database);
    throw error;
  }
}

/**
 * The steps of an open after the database is open: its owner, the primary storage row, the built-in data, the
 * derived data, the folder layout, the recovery of interrupted imports and moves, the trash sweep and the
 * registry entry.
 *
 * @param host the host services
 * @param storage the storage of the workspace folder
 * @param database the open database
 * @param manifest the checked manifest
 * @param rootPath the folder
 * @returns the open workspace
 */
async function prepareWorkspace(
  host: WorkspaceHost,
  storage: Storage,
  database: WorkspaceDatabase,
  manifest: WorkspaceManifest,
  rootPath: string,
): Promise<OpenWorkspace> {
  await claimDatabase(database, manifest);
  const primary = await database.storages.ensurePrimary({
    id: host.newId(),
    createdAt: host.now().toISOString(),
  });
  await ensureBuiltInAssetTypes({ database, newId: () => host.newId() });
  await ensureBuiltInWorkflowTemplates({
    database,
    newId: () => host.newId(),
    now: () => host.now(),
  });
  await database.ensureDerivedData();
  await storage.ensureLayout();
  await recoverInterruptedWork(host, storage, database, manifest.id);
  const summary: WorkspaceSummary = {
    id: manifest.id,
    name: manifest.name,
    rootPath,
    lastOpenedAt: host.now().toISOString(),
  };
  await host.registry.upsert(summary);
  return { summary, storage, storageId: primary.id, database };
}

/**
 * Binds a new database to the manifest's workspace, or checks that an existing one belongs to it.
 *
 * @param database the open database
 * @param manifest the checked manifest
 * @returns resolves when the database belongs to the workspace
 * @throws `WorkspaceMismatchError` for a database of another workspace
 */
async function claimDatabase(database: WorkspaceDatabase, manifest: WorkspaceManifest): Promise<void> {
  const meta = await database.meta.get();
  if (meta === null) {
    await database.meta.init(manifest);
    return;
  }
  if (meta.id !== manifest.id) {
    throw new WorkspaceMismatchError(`Database belongs to workspace ${meta.id}, but the manifest says ${manifest.id}`);
  }
}

/**
 * The recovery of interrupted imports and moves and the trash sweep, followed by one summary line when any of them
 * did something; each item left as it was gets its own line.
 *
 * @param host gives the log
 * @param storage the storage of the workspace folder
 * @param database the open database
 * @param workspaceId the workspace being opened
 * @returns resolves once the steps ended
 */
async function recoverInterruptedWork(
  host: WorkspaceHost,
  storage: Storage,
  database: WorkspaceDatabase,
  workspaceId: string,
): Promise<void> {
  const failures = createRecoveryFailureLog(host.log, workspaceId);
  const onFailure = failures.report;
  const imports = await recoverIncompleteImports({ storage, files: database.files, onFailure });
  const moves = await recoverFileMoves({ storage, files: database.files, fileMoves: database.fileMoves, onFailure });
  const trash = await sweepTrashQuietly(storage, database, onFailure);
  logRecoverySummary(host.log, workspaceId, {
    importsFailed: imports.failedIds.length,
    importsDiscarded: imports.discardedIds.length,
    stagingRemoved: imports.removedStagingFiles.length,
    pathsSkipped: imports.skippedPaths.length,
    movesCompleted: moves.completed.length,
    movesDiscarded: moves.discarded.length,
    trashRemoved: trash.removed.length,
    trashSkipped: trash.skipped.length,
    unrepaired: failures.count(),
  });
}

/**
 * Removes the trash binaries that are left over; a failure is reported and otherwise ignored.
 *
 * @param storage the storage of the workspace folder
 * @param database the open database
 * @param onFailure told about what could not be removed
 * @returns the paths removed and skipped; both empty after a failure of the sweep itself
 */
async function sweepTrashQuietly(
  storage: Storage,
  database: WorkspaceDatabase,
  onFailure: RecoveryFailureReport,
): Promise<{ removed: string[]; skipped: string[] }> {
  try {
    return await sweepTrash({ storage, files: database.files, onFailure });
  } catch (error) {
    // Best effort: leftover trash binaries are swept on the next open.
    reportRecoveryFailure(onFailure, 'trash list', null, error);
    return { removed: [], skipped: [] };
  }
}

/**
 * Closes the database of a failed open, ignoring a failure of the close.
 *
 * @param database the database to close
 * @returns resolves once the close ended either way
 */
async function closeQuietly(database: WorkspaceDatabase): Promise<void> {
  try {
    await database.close();
  } catch {
    // The error that made the open fail is the one worth reporting.
  }
}
