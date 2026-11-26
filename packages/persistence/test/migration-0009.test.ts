import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const UP_TO_0008 = [
  '0000_brainy_tag',
  '0001_regular_gideon',
  '0002_outgoing_franklin_richards',
  '0003_messy_korath',
  '0004_dear_zaladane',
  '0005_lush_mother_askani',
  '0006_cuddly_micromacro',
  '0007_daffy_doctor_faustus',
  '0008_neat_firestar',
];
const TS = '2026-01-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHA = 'a'.repeat(64);

let dir: string;
let dbPath: string;

/** Applies only the migrations up to 0008, the way the first file trash build left the database. */
async function createDatabaseUpTo0008(): Promise<void> {
  const folder = join(dir, 'upto0008-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  for (const tag of UP_TO_0008) {
    await copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => UP_TO_0008.includes(e.tag));
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}

const ROW_COUNTS = ['asset', 'file', 'file_move', 'file_tag', 'job'] as const;

function seed(): void {
  const s = new Database(dbPath);
  try {
    s.prepare('INSERT INTO workspace (id, format_version, name, created_at) VALUES (?, 1, ?, ?)').run(uuid(1), 'ws', TS);
    s.prepare("INSERT INTO storage (id, kind, created_at) VALUES (?, 'workspace_root', ?)").run(uuid(2), TS);
    s.prepare("INSERT INTO asset_type (id, key, name, sort_order, built_in) VALUES (?, 'prop', 'Prop', 0, 1)").run(uuid(3));
    s.prepare(
      `INSERT INTO asset (id, name, type_id, description, status, created_at, updated_at)
       VALUES (?, 'Pump', ?, '', 'draft', ?, ?)`,
    ).run(uuid(10), uuid(3), TS, TS);
    // A live file in the asset and a file in the trash that came from it.
    s.prepare(
      `INSERT INTO file (id, storage_id, asset_id, role, original_name, relative_path, mime_type, sha256, status, kind, imported_at)
       VALUES (?, ?, ?, 'reference', 'a.png', ?, 'image/png', ?, 'complete', 'image', ?)`,
    ).run(uuid(20), uuid(2), uuid(10), `assets/${uuid(10)}/references/${uuid(20)}_a.png`, SHA, TS);
    s.prepare(
      `INSERT INTO file (id, storage_id, original_name, relative_path, mime_type, sha256, status, kind, imported_at,
                         deleted_at, trashed_asset_id, trashed_role)
       VALUES (?, ?, 'b.png', ?, 'image/png', ?, 'complete', 'image', ?, ?, ?, 'reference')`,
    ).run(uuid(21), uuid(2), `.assetforge/trash/${uuid(21)}_b.png`, SHA, TS, TS, uuid(10));
    // A restore of the trashed file, interrupted before its commit.
    s.prepare(
      `INSERT INTO file_move (file_id, kind, target_relative_path, target_asset_id, target_role, created_at)
       VALUES (?, 'restore', ?, ?, 'reference', ?)`,
    ).run(uuid(21), `assets/${uuid(10)}/references/${uuid(21)}_b.png`, uuid(10), TS);
    s.prepare("INSERT INTO tag (id, name, display_name, created_at) VALUES (?, 'metal', 'metal', ?)").run(uuid(40), TS);
    s.prepare("INSERT INTO file_tag (file_id, tag_id, origin, created_at) VALUES (?, ?, 'manual', ?)").run(uuid(21), uuid(40), TS);
    s.prepare(
      `INSERT INTO job (id, type, resource_class, status, file_id, payload, dedupe_key, attempt, created_at, updated_at)
       VALUES (?, 'vision.analyze_file', 'local_gpu', 'queued', ?, '{"version":1}', ?, 0, ?, ?)`,
    ).run(uuid(30), uuid(20), `vision.analyze_file:${uuid(20)}`, TS, TS);
  } finally {
    s.close();
  }
}

function countRows(path: string): Record<string, number> {
  const s = new Database(path);
  try {
    return Object.fromEntries(
      ROW_COUNTS.map((t) => [t, (s.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]),
    );
  } finally {
    s.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-mig9-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migration 0009', () => {
  test('0009 keeps existing rows and adds an empty file_purge table', async () => {
    await createDatabaseUpTo0008();
    seed();
    const before = countRows(dbPath);

    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    try {
      await expect(db.files.listPurgedIds()).resolves.toEqual([]);
      expect(await db.files.get(uuid(21))).toMatchObject({ deletedAt: TS, trashedAssetId: uuid(10), tags: [{ name: 'metal' }] });
      expect(await db.fileMoves.list()).toEqual([expect.objectContaining({ fileId: uuid(21), kind: 'restore' })]);
      expect(await db.jobs.get(uuid(30))).toMatchObject({ status: 'queued', fileId: uuid(20) });
    } finally {
      await db.close();
    }

    expect(countRows(dbPath)).toEqual(before);
    const check = new Database(dbPath);
    try {
      check.pragma('foreign_keys = ON');
      expect(check.prepare('SELECT count(*) AS n FROM file_purge').get()).toEqual({ n: 0 });
      expect(check.pragma('table_info(file_purge)')).toEqual([
        expect.objectContaining({ name: 'file_id', type: 'TEXT', notnull: 1, pk: 1 }),
        expect.objectContaining({ name: 'purged_at', type: 'TEXT', notnull: 1, pk: 0 }),
      ]);
      // No foreign key: a tombstone outlives its file row by design.
      expect(check.pragma('foreign_key_list(file_purge)')).toEqual([]);
      check.prepare('INSERT INTO file_purge (file_id, purged_at) VALUES (?, ?)').run(uuid(99), TS);
      expect(check.pragma('foreign_key_check')).toEqual([]);
      expect(() => check.prepare('INSERT INTO file_purge (file_id, purged_at) VALUES (?, ?)').run(uuid(99), TS)).toThrow(
        /UNIQUE|PRIMARY KEY/,
      );
    } finally {
      check.close();
    }
  });
});
