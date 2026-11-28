import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { backupDatabase, findBackup, pruneBackups, removeBackupLeftovers } from './database-backup.js';
import { readMigrationState } from './migration-state.js';

/** The options of the backup before pending migrations. */
export interface BackupOptions {
  /** The clock that stamps the backup name; the current time by default. */
  now?: () => Date;
}

/** What `migrateWithBackup` needs besides the connection. */
export interface MigrationPlan {
  /** The database file. */
  databaseFilePath: string;
  /** The migrations to apply. */
  migrationsFolder: string;
  /** Whether the database file existed before this open. */
  existed: boolean;
  /** The options of the backup. */
  backup: BackupOptions | undefined;
}

/**
 * Applies the pending migrations. An existing database with at least one pending migration is first copied
 * beside itself (naming and retention in `database-backup.ts`); a new or up-to-date one is not, and the derived
 * data step never asks for one. A failed backup refuses the migration, so the database stays as it was. A failed
 * migration is rolled back by Drizzle and thrown unchanged; its backup stays and nothing is restored. Old backups
 * are pruned only after a successful migration, and the backup of this migration is never pruned. A finished backup of
 * the same schema state is reused instead of copied again. Leftovers of an interrupted backup are removed first, every time.
 *
 * @param sqlite the open connection
 * @param database the Drizzle handle over it
 * @param plan the file, the migrations, whether the file existed and the backup options
 * @returns resolves once the database is migrated
 * @throws InvalidOperationError when the backup cannot be made
 */
export async function migrateWithBackup(
  sqlite: Database.Database,
  database: BetterSQLite3Database,
  plan: MigrationPlan,
): Promise<void> {
  await removeBackupLeftovers(plan.databaseFilePath);
  const state = plan.existed ? readMigrationState(sqlite, plan.migrationsFolder) : undefined;
  const needsBackup = state !== undefined && state.pendingCount > 0;
  const backupPath = needsBackup ? await backupOrReuse(sqlite, plan, state.appliedCount) : null;
  migrate(database, { migrationsFolder: plan.migrationsFolder });
  if (backupPath !== null) await pruneBackups(plan.databaseFilePath, backupPath);
}

/**
 * The backup that protects this migration: an existing finished one of the same applied count, else a new copy.
 *
 * @param sqlite the open connection
 * @param plan the file and the backup options
 * @param appliedCount the number of migrations applied before the update
 * @returns the path of the backup
 * @throws InvalidOperationError when the backup cannot be made
 */
async function backupOrReuse(sqlite: Database.Database, plan: MigrationPlan, appliedCount: number): Promise<string> {
  const existing = await findBackup(plan.databaseFilePath, appliedCount);
  if (existing !== null) return existing;
  const now = plan.backup?.now ?? (() => new Date());
  return backupDatabase(sqlite, plan.databaseFilePath, appliedCount, now());
}
