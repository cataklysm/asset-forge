import { randomUUID } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  WorkspaceManager,
  type ImageProbe,
  type LineLog,
  type VideoProbe,
  type WorkspaceBackups,
  type WorkspaceHost,
} from '@assetforge/core';
import { WorkspaceSummarySchema } from '@assetforge/contracts';
import {
  createBackupChecker,
  createDatabaseBackups,
  openWorkspaceDatabase,
  sweepLocalTemporary,
  type BackupChecker,
} from '@assetforge/persistence';
import { LocalFileSystemStorage, NodeSourceFiles, ZipArchiveReader } from '@assetforge/storage';
import { createBackupTarget } from './backup-target.js';
import { JsonWorkspaceRegistry } from './json-registry.js';

// The workspace side of the wiring: the real adapters the workspace manager runs on.

/** The file name of a workspace's local database. */
const DATABASE_FILE_NAME = 'assetforge.sqlite';

/** What the host passes to the workspace wiring. */
export interface CompositionOptions {
  /** The app's `userData` directory. */
  userDataPath: string;
  /**
   * Required: the persistence package's `MIGRATIONS_FOLDER` is derived from its own
   * module URL, which points to the wrong place once the main process is bundled.
   * The host passes the bundled copy; tests pass `MIGRATIONS_FOLDER` explicitly.
   */
  migrationsFolder: string;
  /**
   * The built backup check worker (`backup-check-worker.js` beside the main bundle). Without it every check answers
   * nothing, so every backup fails as `backup_failed` and no backup can be restored.
   */
  backupWorkerUrl?: URL;
  /** The registry of workspaces; one at `<userData>/settings.json` by default. The host shares it with the handlers. */
  registry?: JsonWorkspaceRegistry;
  /**
   * Moves a folder to the operating system's trash (Electron's `shell.trashItem` in the
   * app). Without it, removing a workspace together with its folder fails instead of
   * falling back to a permanent delete.
   */
  moveToTrash?: (absolutePath: string) => Promise<void>;
  /** Reads image dimensions (the media worker pool in the app). Defaults to a probe that never measures. */
  imageProbe?: ImageProbe;
  /** Reads video size and duration (the frame tool in the app). Defaults to a probe that never measures. */
  videoProbe?: VideoProbe;
  /** One main-console line per unexpected import failure and per recovery on open; nothing is logged without it. */
  log?: LineLog;
}

const WorkspaceIdSchema = WorkspaceSummarySchema.shape.id;

/**
 * Wires the real adapters. Layout under userDataPath:
 * `settings.json`, `workspaces/<workspace-uuid>/assetforge.sqlite`.
 *
 * @param options the paths and the host's probes and trash
 * @returns the host the workspace manager runs on
 */
export function createWorkspaceHost(options: CompositionOptions): WorkspaceHost {
  const { migrationsFolder, userDataPath } = options;
  const registry = options.registry ?? new JsonWorkspaceRegistry(join(userDataPath, 'settings.json'));
  const check = backupCheckerOf(options);
  return {
    registry,
    sources: new NodeSourceFiles(),
    archives: new ZipArchiveReader(),
    imageProbe: options.imageProbe ?? { measure: async () => null },
    videoProbe: options.videoProbe ?? { measure: async () => null },
    createStorage: (rootPath) => new LocalFileSystemStorage(rootPath),
    openDatabase: async (workspaceId) =>
      openWorkspaceDatabase(databaseFilePath(userDataPath, workspaceId), migrationsFolder, { check }),
    deleteDatabase: (workspaceId) => deleteDatabaseDirectory(userDataPath, workspaceId),
    databaseExists: async (workspaceId) => isFile(databaseFilePath(userDataPath, workspaceId)),
    backups: workspaceBackups(userDataPath, registry, check),
    moveToTrash: options.moveToTrash ?? noTrash,
    newId: () => randomUUID(),
    now: () => new Date(),
    ...(options.log === undefined ? {} : { log: options.log }),
  };
}

/**
 * The workspace manager on the real adapters.
 *
 * @param options the paths and the host's probes and trash
 * @returns the manager
 */
export function createWorkspaceManager(options: CompositionOptions): WorkspaceManager {
  return new WorkspaceManager(createWorkspaceHost(options));
}

/**
 * Removes the leftover snapshot and restore files in every local database directory, best effort; run at app start.
 *
 * @param userDataPath the app's `userData` directory
 * @returns resolves once every directory was tried; never rejects
 */
export async function sweepAllLocalTemporary(userDataPath: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(join(userDataPath, 'workspaces'));
  } catch {
    return;
  }
  for (const name of names) {
    if (WorkspaceIdSchema.safeParse(name).success) await sweepLocalTemporary(join(userDataPath, 'workspaces', name));
  }
}

/**
 * The backup check: the worker when the host built one, else a check that never finds anything.
 *
 * @param options the composition options
 * @returns the check
 */
function backupCheckerOf(options: CompositionOptions): BackupChecker {
  if (options.backupWorkerUrl === undefined) return async () => null;
  return createBackupChecker({ workerUrl: options.backupWorkerUrl, migrationsFolder: options.migrationsFolder });
}

/**
 * The backup port: the database side from persistence and the file side of this host.
 *
 * @param userDataPath the app's `userData` directory
 * @param registry gives the chosen backup folder of a workspace
 * @param check the backup check
 * @returns the backup port
 */
function workspaceBackups(userDataPath: string, registry: JsonWorkspaceRegistry, check: BackupChecker): WorkspaceBackups {
  const target = createBackupTarget({ registry });
  const database = createDatabaseBackups({
    databaseFilePathOf: (workspaceId) => databaseFilePath(userDataPath, workspaceId),
    check,
    copyIn: target.copyIn,
  });
  return { ...target, ...database };
}

/**
 * The directory of a workspace's database. The id comes from a manifest on disk and becomes a directory name.
 *
 * @param userDataPath the app's `userData` directory
 * @param workspaceId the workspace's id
 * @returns the directory
 * @throws Error when the id is not a UUID
 */
function databaseDirectory(userDataPath: string, workspaceId: string): string {
  if (!WorkspaceIdSchema.safeParse(workspaceId).success) {
    throw new Error('Invalid workspace id: expected a UUID');
  }
  return join(userDataPath, 'workspaces', workspaceId);
}

/**
 * The local database file of a workspace.
 *
 * @param userDataPath the app's `userData` directory
 * @param workspaceId the workspace's id
 * @returns the file
 * @throws Error when the id is not a UUID
 */
function databaseFilePath(userDataPath: string, workspaceId: string): string {
  return join(databaseDirectory(userDataPath, workspaceId), DATABASE_FILE_NAME);
}

/**
 * Whether a path is a regular file.
 *
 * @param path the path
 * @returns true for a regular file; false when it is missing or anything else
 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Deletes the database directory of a workspace.
 *
 * @param userDataPath the app's `userData` directory
 * @param workspaceId the workspace's id
 */
async function deleteDatabaseDirectory(userDataPath: string, workspaceId: string): Promise<void> {
  await rm(databaseDirectory(userDataPath, workspaceId), { recursive: true, force: true });
}

/** The trash without a host implementation: always refuses. */
async function noTrash(): Promise<void> {
  throw new Error('No trash implementation configured');
}
