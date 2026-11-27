import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspaceDatabase } from '@assetforge/core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createAssetRepository } from './asset-repository.js';
import { createAssetSourceRepository } from './asset-source-repository.js';
import { createAssetTypeRepository } from './asset-type-repository.js';
import { ensureDerivedData, type DerivedDataOptions } from './derived-data.js';
import { createAnalysisTargetReader } from './analysis-target-reader.js';
import { createFileAnalysisRepository } from './file-analysis-repository.js';
import { createFileMoveRepository } from './file-move-repository.js';
import { createFileRepository } from './file-repository.js';
import { createGenerationRepository } from './generation-repository.js';
import { createJobRepository } from './job-repository.js';
import { createMetaRepository } from './meta-repository.js';
import { createAssetRelationRepository } from './asset-relation-repository.js';
import { createProjectAssetRepository } from './project-asset-repository.js';
import { createProjectRepository } from './project-repository.js';
import { createPromptRepository } from './prompt-repository.js';
import { registerSqlFunctions } from './sql-functions.js';
import { createStorageRepository } from './storage-repository.js';
import { createTagRepository } from './tag-repository.js';
import { createAssetWorkflowRepository } from './asset-workflow-repository.js';
import { createWorkflowTemplateRepository } from './workflow-template-repository.js';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

export async function openWorkspaceDatabase(
  dbFilePath: string,
  migrationsFolder: string,
  options: { derivedData?: DerivedDataOptions } = {},
): Promise<WorkspaceDatabase> {
  mkdirSync(dirname(dbFilePath), { recursive: true });
  const sqlite = new Database(dbFilePath);
  try {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    registerSqlFunctions(sqlite);
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
      assetSources: createAssetSourceRepository(db),
      jobs: createJobRepository(db),
      analyses: createFileAnalysisRepository(db),
      analysisTargets: createAnalysisTargetReader(db),
      generations: createGenerationRepository(db),
      prompts: createPromptRepository(db),
      async ensureDerivedData() {
        await ensureDerivedData(db, options.derivedData);
      },
      async close() {
        if (sqlite.open) sqlite.close();
      },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
