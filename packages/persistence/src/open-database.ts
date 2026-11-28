import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspaceDatabase } from '@assetforge/core';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrateWithBackup, type BackupOptions } from './migrate-with-backup.js';
import { createAssetRepository } from './asset-repository.js';
import { createAssetSourceRepository } from './asset-source-repository.js';
import { createAssetTypeRepository } from './asset-type-repository.js';
import { ensureDerivedData, type DerivedDataOptions } from './derived-data.js';
import { createAnalysisTargetReader } from './analysis-target-reader.js';
import { createFileAnalysisRepository } from './file-analysis-repository.js';
import { createFileMoveRepository } from './file-move-repository.js';
import { createFileOriginRepository } from './file-origin-repository.js';
import { createFileRepository } from './file-repository.js';
import { createGenerationRepository } from './generation-repository.js';
import { createJobRepository } from './job-repository.js';
import { createSiteCrawlRepository } from './site-crawl-repository.js';
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

/** The migrations shipped with this package. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/** The options of `openWorkspaceDatabase`. */
export interface OpenWorkspaceDatabaseOptions {
  /** The options of the derived data step. */
  derivedData?: DerivedDataOptions;
  /** The options of the backup before pending migrations. */
  backup?: BackupOptions;
}

/**
 * Opens (and creates) the workspace database: WAL, foreign keys, the SQL functions, a backup when an existing
 * database has pending migrations, and the migrations; then wires every repository. A failure closes the
 * connection again.
 *
 * @param databaseFilePath the database file; its directory is created
 * @param migrationsFolder the migrations to apply
 * @param options the options of the derived data step and of the backup
 * @returns the workspace database
 * @throws InvalidOperationError when the backup before pending migrations cannot be made; nothing is migrated then
 */
export async function openWorkspaceDatabase(
  databaseFilePath: string,
  migrationsFolder: string,
  options: OpenWorkspaceDatabaseOptions = {},
): Promise<WorkspaceDatabase> {
  const existed = existsSync(databaseFilePath);
  mkdirSync(dirname(databaseFilePath), { recursive: true });
  const sqlite = new Database(databaseFilePath);
  try {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    registerSqlFunctions(sqlite);
    const database = drizzle(sqlite);
    await migrateWithBackup(sqlite, database, { databaseFilePath, migrationsFolder, existed, backup: options.backup });
    return workspaceDatabase(sqlite, database, options);
  } catch (error) {
    closeQuietly(sqlite);
    throw error;
  }
}

/**
 * Closes a connection whose open failed. A failing close is swallowed, so the caller sees why the open failed.
 *
 * @param sqlite the connection
 * @returns nothing
 */
function closeQuietly(sqlite: Database.Database): void {
  try {
    sqlite.close();
  } catch {
    // The open error is the one that matters; a close that fails as well adds nothing the caller can act on.
  }
}

/**
 * Every repository over the opened database, with the derived data step and close.
 *
 * @param sqlite the connection
 * @param database the Drizzle handle over it
 * @param options the options of the derived data step, read when the step runs
 * @returns the workspace database
 */
function workspaceDatabase(
  sqlite: Database.Database,
  database: BetterSQLite3Database,
  options: OpenWorkspaceDatabaseOptions,
): WorkspaceDatabase {
  return {
    meta: createMetaRepository(database),
    storages: createStorageRepository(database),
    files: createFileRepository(database),
    fileMoves: createFileMoveRepository(database),
    assetTypes: createAssetTypeRepository(database),
    projects: createProjectRepository(database),
    assets: createAssetRepository(database),
    projectAssets: createProjectAssetRepository(database),
    relations: createAssetRelationRepository(database),
    workflowTemplates: createWorkflowTemplateRepository(database),
    assetWorkflows: createAssetWorkflowRepository(database),
    tags: createTagRepository(database),
    assetSources: createAssetSourceRepository(database),
    fileOrigins: createFileOriginRepository(database),
    jobs: createJobRepository(database),
    siteCrawls: createSiteCrawlRepository(database),
    analyses: createFileAnalysisRepository(database),
    analysisTargets: createAnalysisTargetReader(database),
    generations: createGenerationRepository(database),
    prompts: createPromptRepository(database),
    async ensureDerivedData() {
      await ensureDerivedData(database, options.derivedData);
    },
    async close() {
      if (sqlite.open) sqlite.close();
    },
  };
}
