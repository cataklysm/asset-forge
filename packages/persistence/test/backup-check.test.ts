import { copyFile, mkdtemp, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createBackupChecker } from '../src/backup-check.js';
import { MIGRATIONS_FOLDER } from '../src/index.js';
import {
  createWorkspaceDatabase,
  realChecker,
  shippedMigrationCount,
  WORKER_URL,
  WORKSPACE_ID,
} from './backup-fixtures.js';
import { migrationsUpTo } from './migrations-folder.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-backup-check-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A database migrated with a folder, with a workspace row written by hand.
 *
 * @param folder the migrations
 * @returns the path
 */
function databaseMigratedWith(folder: string): string {
  const path = join(dir, 'copy.sqlite');
  const sqlite = new Database(path);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
    sqlite
      .prepare(
        "INSERT INTO workspace (id, format_version, name, created_at) VALUES (?, 1, 'Old', '2026-01-01T00:00:00Z')",
      )
      .run(WORKSPACE_ID);
  } finally {
    sqlite.close();
  }
  return path;
}

test('a good copy answers its id, lineage, format version and applied count', async () => {
  const { path, lineageId } = await createWorkspaceDatabase(dir);
  expect(await realChecker()(path)).toEqual({
    workspaceId: WORKSPACE_ID,
    lineageId,
    formatVersion: 1,
    appliedMigrations: await shippedMigrationCount(),
    newerThanApp: false,
  });
});

test('a truncated file answers null', async () => {
  const { path } = await createWorkspaceDatabase(dir);
  const copy = join(dir, 'truncated.sqlite');
  await copyFile(path, copy);
  await truncate(copy, Math.floor((await stat(copy)).size / 2));
  expect(await realChecker()(copy)).toBeNull();
});

test('a non-SQLite file answers null', async () => {
  const path = join(dir, 'text.sqlite');
  await writeFile(path, 'this is not a database, only some text that is long enough to have a header '.repeat(20));
  expect(await realChecker()(path)).toBeNull();
});

test('a missing file answers null and creates nothing', async () => {
  expect(await realChecker()(join(dir, 'missing.sqlite'))).toBeNull();
  expect(await readdir(dir)).toEqual([]);
});

test('a database without lineage_id answers lineageId null', async () => {
  const path = databaseMigratedWith(await migrationsUpTo(join(dir, 'before-lineage'), 21));
  expect(await realChecker()(path)).toMatchObject({
    workspaceId: WORKSPACE_ID,
    lineageId: null,
    appliedMigrations: 21,
  });
});

test('a newer journal state answers newerThanApp', async () => {
  const longer = await migrationsUpTo(join(dir, 'longer'), 100, [
    { tag: '9999_future', sql: 'CREATE TABLE future (id integer);' },
  ]);
  const path = databaseMigratedWith(longer);
  expect(await realChecker()(path)).toMatchObject({ newerThanApp: true });
});

test('a copy in WAL mode is folded into one file', async () => {
  const { path } = await createWorkspaceDatabase(dir);
  expect(await realChecker()(path)).not.toBeNull();
  expect((await readdir(dir)).sort()).toEqual(['assetforge.sqlite']);
  const sqlite = new Database(path, { readonly: true });
  try {
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('delete');
  } finally {
    sqlite.close();
  }
});

test('a timeout answers null', async () => {
  const { path } = await createWorkspaceDatabase(dir);
  const checker = createBackupChecker({ workerUrl: WORKER_URL, migrationsFolder: MIGRATIONS_FOLDER, timeoutMs: 0 });
  expect(await checker(path)).toBeNull();
});

test('an aborted signal answers null', async () => {
  const { path } = await createWorkspaceDatabase(dir);
  const controller = new AbortController();
  const answer = realChecker()(path, controller.signal);
  controller.abort();
  expect(await answer).toBeNull();
});
