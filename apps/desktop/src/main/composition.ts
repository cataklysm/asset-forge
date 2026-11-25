import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceManager, type WorkspaceHost } from '@assetforge/core';
import { WorkspaceSummarySchema } from '@assetforge/contracts';
import { openWorkspaceDatabase } from '@assetforge/persistence';
import { LocalFileSystemStorage, NodeSourceFiles } from '@assetforge/storage';
import { JsonWorkspaceRegistry } from './json-registry.js';

export interface CompositionOptions {
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
}

const WorkspaceIdSchema = WorkspaceSummarySchema.shape.id;

/**
 * Wires the real adapters. Layout under userDataPath:
 * `settings.json`, `workspaces/<workspace-uuid>/assetforge.sqlite`.
 */
export function createWorkspaceHost(opts: CompositionOptions): WorkspaceHost {
  const { migrationsFolder } = opts;
  // The id comes from a manifest on disk and becomes a directory name.
  const databaseDir = (workspaceId: string) => {
    if (!WorkspaceIdSchema.safeParse(workspaceId).success) {
      throw new Error('Invalid workspace id: expected a UUID');
    }
    return join(opts.userDataPath, 'workspaces', workspaceId);
  };
  return {
    registry: new JsonWorkspaceRegistry(join(opts.userDataPath, 'settings.json')),
    sources: new NodeSourceFiles(),
    createStorage: (rootPath) => new LocalFileSystemStorage(rootPath),
    openDatabase: async (workspaceId) =>
      openWorkspaceDatabase(join(databaseDir(workspaceId), 'assetforge.sqlite'), migrationsFolder),
    deleteDatabase: async (workspaceId) => {
      await rm(databaseDir(workspaceId), { recursive: true, force: true });
    },
    moveToTrash:
      opts.moveToTrash ??
      (async () => {
        throw new Error('No trash implementation configured');
      }),
    newId: () => randomUUID(),
    now: () => new Date(),
  };
}

export function createWorkspaceManager(opts: CompositionOptions): WorkspaceManager {
  return new WorkspaceManager(createWorkspaceHost(opts));
}
