import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackupError, type WorkspaceDatabase } from '@assetforge/core';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { BackupChecker } from './backup-check.js';
import { snapshotOpenDatabase, sweepLocalTemporary } from './database-snapshot.js';
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
  /** The backup check of a snapshot; without it every snapshot fails with `backup_failed`. */
  check?: BackupChecker;
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
 * @throws DatabaseUpdateFailedError when a migration fails; it was rolled back
 */
export async function openWorkspaceDatabase(
  databaseFilePath: string,
  migrationsFolder: string,
  options: OpenWorkspaceDatabaseOptions = {},
): Promise<WorkspaceDatabase> {
  const existed = existsSync(databaseFilePath);
  mkdirSync(dirname(databaseFilePath), { recursive: true });
  await sweepLocalTemporary(dirname(databaseFilePath));
  const sqlite = new Database(databaseFilePath);
  try {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    registerSqlFunctions(sqlite);
    const database = drizzle(sqlite);
    await migrateWithBackup(sqlite, database, { databaseFilePath, migrationsFolder, existed, backup: options.backup });
    return workspaceDatabase({ sqlite, database, databaseFilePath, options });
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

/** What `workspaceDatabase` wires the repositories over. */
interface OpenedDatabase {
  /** The connection. */
  sqlite: Database.Database;
  /** The Drizzle handle over it. */
  database: BetterSQLite3Database;
  /** The database file. */
  databaseFilePath: string;
  /** The options of the derived data step and the snapshot check, read when they run. */
  options: OpenWorkspaceDatabaseOptions;
}

/**
 * Every repository over the opened database, with the derived data step, the snapshot and close.
 *
 * @param opened the connection, its Drizzle handle, the file and the options
 * @returns the workspace database
 */
function workspaceDatabase(opened: OpenedDatabase): WorkspaceDatabase {
  const { sqlite, database, databaseFilePath, options } = opened;
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
    changeCount() {
      return (sqlite.prepare('select total_changes() as n').get() as { n: number }).n;
    },
    snapshot({ signal }) {
      if (options.check === undefined) return snapshotWithoutCheck();
      return snapshotOpenDatabase(sqlite, databaseFilePath, options.check, signal);
    },
    async close() {
      if (sqlite.open) sqlite.close();
    },
  };
}

/**
 * The snapshot of a database opened without a backup check: always fails.
 *
 * @returns never; always rejects with `backup_failed`
 */
async function snapshotWithoutCheck(): Promise<never> {
  throw new BackupError('backup_failed');
}
