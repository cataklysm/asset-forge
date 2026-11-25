import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WorkspaceManager, type WorkspaceHost } from '@assetforge/core';
import { WorkspaceSummarySchema } from '@assetforge/contracts';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '@assetforge/persistence';
import { LocalFileSystemStorage, NodeSourceFiles } from '@assetforge/storage';
import { JsonWorkspaceRegistry } from './json-registry.js';

export interface CompositionOptions {
  userDataPath: string;
  migrationsFolder?: string;
}

const WorkspaceIdSchema = WorkspaceSummarySchema.shape.id;

/**
 * Wires the real adapters. Layout under userDataPath:
 * `settings.json`, `workspaces/<workspace-uuid>/assetforge.sqlite`.
 */
export function createWorkspaceHost(opts: CompositionOptions): WorkspaceHost {
  const migrationsFolder = opts.migrationsFolder ?? MIGRATIONS_FOLDER;
  return {
    registry: new JsonWorkspaceRegistry(join(opts.userDataPath, 'settings.json')),
    sources: new NodeSourceFiles(),
    createStorage: (rootPath) => new LocalFileSystemStorage(rootPath),
    openDatabase: async (workspaceId) => {
      // The id comes from a manifest on disk and becomes a directory name.
      if (!WorkspaceIdSchema.safeParse(workspaceId).success) {
        throw new Error('Invalid workspace id: expected a UUID');
      }
      return openWorkspaceDatabase(
        join(opts.userDataPath, 'workspaces', workspaceId, 'assetforge.sqlite'),
        migrationsFolder,
      );
    },
    newId: () => randomUUID(),
    now: () => new Date(),
  };
}

export function createWorkspaceManager(opts: CompositionOptions): WorkspaceManager {
  return new WorkspaceManager(createWorkspaceHost(opts));
}
