// Worker thread entry of the backup check (`backup-check.ts`). It imports only better-sqlite3 and the migration
// state, so the bundle stays small; better-sqlite3 is external and loads its native module at run time.
import { parentPort, workerData } from 'node:worker_threads';
import type { SnapshotFacts } from '@assetforge/core';
import Database from 'better-sqlite3';
import type { BackupCheckRequest } from './backup-check.js';
import { readMigrationState } from './migration-state.js';

/** The workspace row as the check reads it; `lineage_id` is null when the column does not exist. */
interface WorkspaceRow {
  /** The workspace id. */
  id: unknown;
  /** The format version. */
  format_version: unknown;
  /** The lineage, or null. */
  lineage_id: unknown;
}

/**
 * Checks the copy and reads its facts. It opens the copy read-write, because folding the WAL in (journal mode
 * DELETE) writes; the copy is a temporary file of this app, never the live database.
 *
 * @param request the copy and the migrations
 * @returns the facts; null when the copy is not a readable workspace database or its `quick_check` is not ok
 */
function checkCopy(request: BackupCheckRequest): SnapshotFacts | null {
  const sqlite = new Database(request.path, { fileMustExist: true });
  try {
    sqlite.pragma('trusted_schema = OFF');
    sqlite.pragma('journal_mode = DELETE');
    if (!isQuickCheckOk(sqlite)) return null;
    const row = readWorkspaceRow(sqlite);
    if (row === null) return null;
    const state = readMigrationState(sqlite, request.migrationsFolder);
    return {
      workspaceId: row.id as string,
      lineageId: typeof row.lineage_id === 'string' ? row.lineage_id : null,
      formatVersion: row.format_version as number,
      appliedMigrations: state.appliedCount,
      newerThanApp: state.newerThanApp,
    };
  } finally {
    sqlite.close();
  }
}

/**
 * Whether `quick_check` answers exactly one row `ok`.
 *
 * @param sqlite the open copy
 * @returns true when it does
 */
function isQuickCheckOk(sqlite: Database.Database): boolean {
  const rows = sqlite.pragma('quick_check') as { quick_check: unknown }[];
  return rows.length === 1 && rows[0]!.quick_check === 'ok';
}

/**
 * The workspace row with a string id and an integer format version.
 *
 * @param sqlite the open copy
 * @returns the row; null when the table, the row or a required value is missing
 */
function readWorkspaceRow(sqlite: Database.Database): WorkspaceRow | null {
  const columns = (sqlite.pragma('table_info(workspace)') as { name: string }[]).map((column) => column.name);
  if (!columns.includes('id') || !columns.includes('format_version')) return null;
  const lineage = columns.includes('lineage_id') ? 'lineage_id' : 'NULL AS lineage_id';
  const row = sqlite.prepare(`SELECT id, format_version, ${lineage} FROM workspace LIMIT 1`).get() as
    WorkspaceRow | undefined;
  if (row === undefined || typeof row.id !== 'string' || !Number.isInteger(row.format_version)) return null;
  return row;
}

/**
 * Runs the check and answers it; any failure answers null.
 *
 * @param request the copy and the migrations
 * @returns the facts, or null
 */
function answer(request: BackupCheckRequest): SnapshotFacts | null {
  try {
    return checkCopy(request);
  } catch {
    return null;
  }
}

if (!parentPort) throw new Error('backup-check-worker must run in a worker thread');
parentPort.postMessage(answer(workerData as BackupCheckRequest));
