import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceManager, type ImageProbe, type LineLog, type VideoProbe, type WorkspaceHost } from '@assetforge/core';
import { WorkspaceSummarySchema } from '@assetforge/contracts';
import { openWorkspaceDatabase } from '@assetforge/persistence';
import { LocalFileSystemStorage, NodeSourceFiles, ZipArchiveReader } from '@assetforge/storage';
import { JsonWorkspaceRegistry } from './json-registry.js';

// The workspace side of the wiring: the real adapters the workspace manager runs on.

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
  return {
    registry: new JsonWorkspaceRegistry(join(userDataPath, 'settings.json')),
    sources: new NodeSourceFiles(),
    archives: new ZipArchiveReader(),
    imageProbe: options.imageProbe ?? { measure: async () => null },
    videoProbe: options.videoProbe ?? { measure: async () => null },
    createStorage: (rootPath) => new LocalFileSystemStorage(rootPath),
    openDatabase: async (workspaceId) =>
      openWorkspaceDatabase(join(databaseDirectory(userDataPath, workspaceId), 'assetforge.sqlite'), migrationsFolder),
    deleteDatabase: (workspaceId) => deleteDatabaseDirectory(userDataPath, workspaceId),
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
