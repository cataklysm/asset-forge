import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const UP_TO_0007 = [
  '0000_brainy_tag',
  '0001_regular_gideon',
  '0002_outgoing_franklin_richards',
  '0003_messy_korath',
  '0004_dear_zaladane',
  '0005_lush_mother_askani',
  '0006_cuddly_micromacro',
  '0007_daffy_doctor_faustus',
];
const TS = '2026-01-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHA = 'a'.repeat(64);

let dir: string;
let dbPath: string;

/** Applies only the migrations up to 0007, the way a phase 4b build left the database. */
async function createDatabaseUpTo0007(): Promise<void> {
  const folder = join(dir, 'upto0007-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  for (const tag of UP_TO_0007) {
    await copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => UP_TO_0007.includes(e.tag));
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}

const ROW_COUNTS = ['asset', 'file', 'file_move', 'job', 'file_analysis'] as const;

function seed(): void {
  const s = new Database(dbPath);
  try {
    s.prepare('INSERT INTO workspace (id, format_version, name, created_at) VALUES (?, 1, ?, ?)').run(
      uuid(1),
      'ws',
      TS,
    );
    s.prepare("INSERT INTO storage (id, kind, created_at) VALUES (?, 'workspace_root', ?)").run(uuid(2), TS);
    s.prepare("INSERT INTO asset_type (id, key, name, sort_order, built_in) VALUES (?, 'prop', 'Prop', 0, 1)").run(
      uuid(3),
    );
    const asset = s.prepare(
      `INSERT INTO asset (id, name, type_id, description, status, created_at, updated_at)
       VALUES (?, ?, ?, '', 'draft', ?, ?)`,
    );
    asset.run(uuid(10), 'Pump', uuid(3), TS, TS);
    asset.run(uuid(11), 'Valve', uuid(3), TS, TS);
    // An attached file and an inbox file.
    s.prepare(
      `INSERT INTO file (id, storage_id, asset_id, role, original_name, relative_path, mime_type, sha256, status, kind, imported_at)
       VALUES (?, ?, ?, 'reference', 'a.png', ?, 'image/png', ?, 'complete', 'image', ?)`,
    ).run(uuid(20), uuid(2), uuid(10), `assets/${uuid(10)}/references/${uuid(20)}_a.png`, SHA, TS);
    s.prepare(
      `INSERT INTO file (id, storage_id, original_name, relative_path, mime_type, sha256, status, kind, imported_at)
       VALUES (?, ?, 'b.png', ?, 'image/png', ?, 'complete', 'image', ?)`,
    ).run(uuid(21), uuid(2), `inbox/${uuid(21)}_b.png`, SHA, TS);
    // A move of the inbox file into the second asset, interrupted before its commit.
    s.prepare(
      `INSERT INTO file_move (file_id, target_relative_path, target_asset_id, target_role, created_at)
       VALUES (?, ?, ?, 'concept', ?)`,
    ).run(uuid(21), `assets/${uuid(11)}/references/${uuid(21)}_b.png`, uuid(11), TS);
    s.prepare(
      `INSERT INTO file_analysis (file_id, sha256, provider, model, prompt_version, analysed_at) VALUES (?, ?, 'ollama', 'qwen', 1, ?)`,
    ).run(uuid(20), SHA, TS);
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
  dir = await mkdtemp(join(tmpdir(), 'af-mig8-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migration 0008', () => {
  test('0008 keeps existing rows and adds the trash columns with neutral values', async () => {
    await createDatabaseUpTo0007();
    seed();
    const before = countRows(dbPath);

    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    try {
      expect(await db.files.get(uuid(20))).toMatchObject({
        assetId: uuid(10),
        role: 'reference',
        openable: true,
        deletedAt: null,
        trashedAssetId: null,
        trashedAssetName: null,
        trashedRole: null,
      });
      expect(await db.files.get(uuid(21))).toMatchObject({ assetId: null, deletedAt: null, trashedAssetId: null });
      expect(await db.fileMoves.list()).toEqual([
        expect.objectContaining({ fileId: uuid(21), kind: 'relocate', targetAssetId: uuid(11) }),
      ]);
      expect(await db.jobs.get(uuid(30))).toMatchObject({ status: 'queued', fileId: uuid(20) });
    } finally {
      await db.close();
    }

    expect(countRows(dbPath)).toEqual(before);
    const check = new Database(dbPath);
    try {
      check.pragma('foreign_keys = ON');
      expect(check.prepare('SELECT deleted_at, trashed_asset_id, trashed_role FROM file ORDER BY id').all()).toEqual([
        { deleted_at: null, trashed_asset_id: null, trashed_role: null },
        { deleted_at: null, trashed_asset_id: null, trashed_role: null },
      ]);
      expect(check.prepare('SELECT kind FROM file_move').all()).toEqual([{ kind: 'relocate' }]);
      expect(check.pragma('foreign_key_check')).toEqual([]);
      expect(
        (
          check
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'file_deleted_at_idx'")
            .all() as unknown[]
        ).length,
      ).toBe(1);

      // `trashed_asset_id` points at an asset and is cleared when that asset goes.
      expect(() => check.prepare('UPDATE file SET trashed_asset_id = ? WHERE id = ?').run(uuid(99), uuid(21))).toThrow(
        /FOREIGN KEY/,
      );
      check
        .prepare(
          "UPDATE file SET asset_id = NULL, role = NULL, trashed_asset_id = ?, trashed_role = 'concept', deleted_at = ? WHERE id = ?",
        )
        .run(uuid(11), TS, uuid(20));
      check.prepare('DELETE FROM file_move').run();
      check.prepare('DELETE FROM asset WHERE id = ?').run(uuid(11));
      expect(check.prepare('SELECT trashed_asset_id FROM file WHERE id = ?').get(uuid(20))).toEqual({
        trashed_asset_id: null,
      });
      check
        .prepare("UPDATE file SET trashed_asset_id = ?, trashed_role = 'reference', deleted_at = ? WHERE id = ?")
        .run(uuid(10), TS, uuid(21));
    } finally {
      check.close();
    }

    // A trashed row reads with its origin and is never openable.
    const reopened = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    try {
      expect(await reopened.files.get(uuid(21))).toMatchObject({
        assetId: null,
        role: null,
        openable: false,
        deletedAt: TS,
        trashedAssetId: uuid(10),
        trashedAssetName: 'Pump',
        trashedRole: 'reference',
      });
      expect(await reopened.files.get(uuid(20))).toMatchObject({
        openable: false,
        deletedAt: TS,
        trashedAssetId: null,
        trashedAssetName: null,
        trashedRole: 'concept',
      });
    } finally {
      await reopened.close();
    }
  });
});
