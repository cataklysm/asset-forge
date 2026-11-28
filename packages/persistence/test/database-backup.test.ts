import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { AssetForgeError } from '@assetforge/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

type JournalEntry = { idx: number; when: number; tag: string; version: string; breakpoints: boolean };

let dir: string;
let dbPath: string;

/**
 * A migrations folder with the shipped migrations before `count`, plus optional extra entries.
 *
 * @param count the number of shipped migrations to keep
 * @param extra extra migrations as tag and SQL, appended after the kept ones
 * @returns the folder
 */
async function migrationsUpTo(count: number, extra: { tag: string; sql: string }[] = []): Promise<string> {
  const folder = join(dir, `migrations-${count}-${extra.length}`);
  await mkdir(join(folder, 'meta'), { recursive: true });
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx < count);
  for (const entry of journal.entries) {
    await copyFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  let when = journal.entries.at(-1)!.when;
  for (const migration of extra) {
    when += 1000;
    journal.entries.push({ idx: journal.entries.length, when, tag: migration.tag, version: '6', breakpoints: true });
    await writeFile(join(folder, `${migration.tag}.sql`), migration.sql);
  }
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  return folder;
}

/**
 * Applies the first `count` shipped migrations directly, without the workspace open, and stores a marker row.
 *
 * @param count the number of migrations to apply
 */
async function createDatabaseWith(count: number): Promise<void> {
  const folder = await migrationsUpTo(count);
  const sqlite = new Database(dbPath);
  try {
    sqlite.pragma('journal_mode = WAL');
    migrate(drizzle(sqlite), { migrationsFolder: folder });
    sqlite
      .prepare(
        "INSERT INTO workspace (id, format_version, name, created_at) VALUES ('00000000-0000-4000-8000-000000000001', 1, 'old', '2026-11-28T10:00:00.000Z')",
      )
      .run();
  } finally {
    sqlite.close();
  }
}

/**
 * A clock that answers the given UTC times one after the other.
 *
 * @param times the ISO times
 * @returns the clock
 */
function clock(...times: string[]): () => Date {
  const queue = [...times];
  return () => new Date(queue.shift() ?? times.at(-1)!);
}

/** The backup files beside the database, sorted. */
async function backups(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.startsWith('assetforge.sqlite.backup-')).sort();
}

/**
 * The number of applied migrations of a database file.
 *
 * @param path the file
 * @returns the row count of the migrations table
 */
function appliedCount(path: string): number {
  const sqlite = new Database(path, { readonly: true });
  try {
    return (sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }).n;
  } finally {
    sqlite.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-backup-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('backup before migrations', () => {
  test('a new database gets no backup', async () => {
    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    await db.close();
    expect(await backups()).toEqual([]);
  });

  test('an up-to-date database gets no backup', async () => {
    const first = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    await first.close();
    const second = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    await second.close();
    expect(await backups()).toEqual([]);
  });

  test('a pending migration makes a backup at the old schema state with the old data', async () => {
    await createDatabaseWith(18);
    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER, {
      backup: { now: clock('2026-11-28T09:08:07.000Z') },
    });
    await db.close();

    expect(await backups()).toEqual(['assetforge.sqlite.backup-18-20261128090807']);
    const backupPath = join(dir, 'assetforge.sqlite.backup-18-20261128090807');
    expect(appliedCount(backupPath)).toBe(18);
    const shipped = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
      entries: unknown[];
    };
    expect(appliedCount(dbPath)).toBe(shipped.entries.length);
    const sqlite = new Database(backupPath, { readonly: true });
    try {
      expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(sqlite.prepare('SELECT name FROM workspace').all()).toEqual([{ name: 'old' }]);
    } finally {
      sqlite.close();
    }
  });

  test('keeps the newest three backups after a successful migration', async () => {
    await createDatabaseWith(15);
    const times = ['2026-11-28T10:00:01Z', '2026-11-28T10:00:02Z', '2026-11-28T10:00:03Z', '2026-11-28T10:00:04Z'];
    for (const [index, count] of [16, 17, 18].entries()) {
      const db = await openWorkspaceDatabase(dbPath, await migrationsUpTo(count), {
        backup: { now: clock(times[index]!) },
      });
      await db.close();
    }
    expect(await backups()).toHaveLength(3);
    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER, { backup: { now: clock(times[3]!) } });
    await db.close();
    expect(await backups()).toEqual([
      'assetforge.sqlite.backup-16-20261128100002',
      'assetforge.sqlite.backup-17-20261128100003',
      'assetforge.sqlite.backup-18-20261128100004',
    ]);
  });

  test('removes the leftovers of an interrupted backup on the next open', async () => {
    const first = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    await first.close();
    await writeFile(join(dir, 'assetforge.sqlite.backup-18-20261128100000.tmp'), 'half');
    await writeFile(join(dir, 'assetforge.sqlite.backup-18-20261128100000.tmp-journal'), 'half');
    await writeFile(join(dir, 'other.sqlite.backup-18-20261128100000.tmp'), 'not ours');
    const second = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    await second.close();
    expect(await backups()).toEqual([]);
    expect(existsSync(join(dir, 'other.sqlite.backup-18-20261128100000.tmp'))).toBe(true);
  });

  test('a backup that fails refuses the open with a fixed message and leaves the database unmigrated', async () => {
    await createDatabaseWith(18);
    const blocker = join(dir, 'assetforge.sqlite.backup-18-20261128100000');
    await mkdir(join(blocker, 'inside'), { recursive: true });

    const open = openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER, { backup: { now: clock('2026-11-28T10:00:00Z') } });
    await expect(open).rejects.toBeInstanceOf(AssetForgeError);
    await expect(open).rejects.toMatchObject({
      code: 'invalid_operation',
      message: 'The database could not be backed up before the update',
    });

    expect(appliedCount(dbPath)).toBe(18);
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('a migration that fails keeps the backup and the old schema', async () => {
    await createDatabaseWith(19);
    const folder = await migrationsUpTo(19, [{ tag: '0019_broken', sql: 'CREATE TABLE broken (;' }]);

    await expect(
      openWorkspaceDatabase(dbPath, folder, { backup: { now: clock('2026-11-28T10:00:00Z') } }),
    ).rejects.toThrow();

    expect(await backups()).toEqual(['assetforge.sqlite.backup-19-20261128100000']);
    expect(appliedCount(join(dir, 'assetforge.sqlite.backup-19-20261128100000'))).toBe(19);
    expect(appliedCount(dbPath)).toBe(19);
  });

  test('a migration that keeps failing reuses its backup instead of piling up copies', async () => {
    await createDatabaseWith(19);
    const folder = await migrationsUpTo(19, [{ tag: '0019_broken', sql: 'CREATE TABLE broken (;' }]);

    for (const time of ['2026-11-28T10:00:00Z', '2026-11-28T10:05:00Z', '2026-11-28T10:10:00Z']) {
      await expect(openWorkspaceDatabase(dbPath, folder, { backup: { now: clock(time) } })).rejects.toThrow();
    }

    expect(await backups()).toEqual(['assetforge.sqlite.backup-19-20261128100000']);
  });

  test('retention never deletes the backup of this migration, even with a clock set back', async () => {
    await createDatabaseWith(18);
    for (const stamp of ['20990101000001', '20990101000002', '20990101000003']) {
      await writeFile(join(dir, `assetforge.sqlite.backup-17-${stamp}`), 'older');
    }

    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER, {
      backup: { now: clock('2026-11-28T10:00:00Z') },
    });
    await db.close();

    expect(await backups()).toEqual([
      'assetforge.sqlite.backup-17-20990101000002',
      'assetforge.sqlite.backup-17-20990101000003',
      'assetforge.sqlite.backup-18-20261128100000',
    ]);
  });
});
