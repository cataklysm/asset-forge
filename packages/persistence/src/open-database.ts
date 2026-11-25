import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspaceDatabase } from '@assetforge/core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createAssetRepository } from './asset-repository.js';
import { createAssetTypeRepository } from './asset-type-repository.js';
import { createFileMoveRepository } from './file-move-repository.js';
import { createFileRepository } from './file-repository.js';
import { createMetaRepository } from './meta-repository.js';
import { createAssetRelationRepository } from './asset-relation-repository.js';
import { createProjectAssetRepository } from './project-asset-repository.js';
import { createProjectRepository } from './project-repository.js';
import { createStorageRepository } from './storage-repository.js';
import { createTagRepository } from './tag-repository.js';
import { createAssetWorkflowRepository } from './asset-workflow-repository.js';
import { createWorkflowTemplateRepository } from './workflow-template-repository.js';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

export async function openWorkspaceDatabase(
  dbFilePath: string,
  migrationsFolder: string,
): Promise<WorkspaceDatabase> {
  mkdirSync(dirname(dbFilePath), { recursive: true });
  const sqlite = new Database(dbFilePath);
  try {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder });
    return {
      meta: createMetaRepository(db),
      storages: createStorageRepository(db),
      files: createFileRepository(db),
      fileMoves: createFileMoveRepository(db),
      assetTypes: createAssetTypeRepository(db),
      projects: createProjectRepository(db),
      assets: createAssetRepository(db),
      projectAssets: createProjectAssetRepository(db),
      relations: createAssetRelationRepository(db),
      workflowTemplates: createWorkflowTemplateRepository(db),
      assetWorkflows: createAssetWorkflowRepository(db),
      tags: createTagRepository(db),
      async close() {
        if (sqlite.open) sqlite.close();
      },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
