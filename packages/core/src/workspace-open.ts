import type { WorkspaceManifest, WorkspaceSummary } from '@assetforge/contracts';
import { recoverFileMoves } from './asset-files.js';
import { ensureBuiltInAssetTypes } from './asset-types.js';
import { WorkspaceDuplicateError, WorkspaceMismatchError } from './errors.js';
import { sweepTrash } from './file-trash.js';
import type { Storage } from './ports/storage.js';
import type { WorkspaceDatabase } from './ports/workspace-database.js';
import type { WorkspaceHost } from './ports/workspace-host.js';
import { recoverIncompleteImports } from './recover-imports.js';
import { ensureBuiltInWorkflowTemplates } from './workflow-templates.js';
import { holdsWorkspace, isSameRoot } from './workspace-manifest.js';

export interface OpenWorkspace {
  summary: WorkspaceSummary;
  storage: Storage;
  storageId: string;
  database: WorkspaceDatabase;
}

export async function openWorkspaceDatabase(
  host: WorkspaceHost,
  storage: Storage,
  manifest: WorkspaceManifest,
  rootPath: string,
): Promise<OpenWorkspace> {
  const database = await host.openDatabase(manifest.id);
  try {
    const meta = await database.meta.get();
    if (meta === null) {
      await database.meta.init(manifest);
    } else if (meta.id !== manifest.id) {
      throw new WorkspaceMismatchError(
        `Database belongs to workspace ${meta.id}, but the manifest says ${manifest.id}`,
      );
    }
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
    await recoverImports(storage, database);
    await recoverFileMoves({ storage, files: database.files, fileMoves: database.fileMoves });
    try {
      await sweepTrash({ storage, files: database.files });
    } catch {
      // Best effort: leftover trash binaries are swept on the next open.
    }
    const summary: WorkspaceSummary = {
      id: manifest.id,
      name: manifest.name,
      rootPath,
      lastOpenedAt: host.now().toISOString(),
    };
    await host.registry.upsert(summary);
    return { summary, storage, storageId: primary.id, database };
  } catch (error) {
    try {
      await database.close();
    } catch {
      // The error that made the open fail is the one worth reporting.
    }
    throw error;
  }
}

/**
 * A workspace id is known under one root. Opening it under another root is a move when
 * the old root no longer holds this workspace, and a copy when it still does; a copy
 * would share the database of the original, so it is rejected before anything changes.
 */
export async function rejectCopy(host: WorkspaceHost, id: string, rootPath: string): Promise<void> {
  const known = await host.registry.get(id);
  if (known === null || isSameRoot(known.rootPath, rootPath)) return;
  if (await holdsWorkspace(host, known.rootPath, id)) {
    throw new WorkspaceDuplicateError('This workspace is already known');
  }
}

async function recoverImports(storage: Storage, database: WorkspaceDatabase): Promise<void> {
  await recoverIncompleteImports({ storage, files: database.files });
}
