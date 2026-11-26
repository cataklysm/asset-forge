import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const UP_TO_0005 = [
  '0000_brainy_tag',
  '0001_regular_gideon',
  '0002_outgoing_franklin_richards',
  '0003_messy_korath',
  '0004_dear_zaladane',
  '0005_lush_mother_askani',
];
const TS = '2026-01-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let dir: string;
let dbPath: string;

/** Applies only the migrations up to 0005, the way an image viewer build left the database. */
async function createDatabaseUpTo0005(): Promise<void> {
  const folder = join(dir, 'upto0005-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  for (const tag of UP_TO_0005) {
    await copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => UP_TO_0005.includes(e.tag));
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}

function seedAssetWithFile(): void {
  const seed = new Database(dbPath);
  try {
    seed.prepare('INSERT INTO workspace (id, format_version, name, created_at) VALUES (?, 1, ?, ?)').run(uuid(1), 'ws', TS);
    seed.prepare("INSERT INTO storage (id, kind, created_at) VALUES (?, 'workspace_root', ?)").run(uuid(2), TS);
    seed
      .prepare("INSERT INTO asset_type (id, key, name, sort_order, built_in) VALUES (?, 'prop', 'Prop', 0, 1)")
      .run(uuid(3));
    seed
      .prepare(
        `INSERT INTO asset (id, name, type_id, description, status, created_at, updated_at)
         VALUES (?, 'Pump', ?, '', 'draft', ?, ?)`,
      )
      .run(uuid(10), uuid(3), TS, TS);
    seed
      .prepare(
        `INSERT INTO file (id, storage_id, asset_id, role, original_name, relative_path, mime_type, sha256, status, imported_at, width, height)
         VALUES (?, ?, ?, 'reference', 'a.png', 'files/a.png', 'image/png', ?, 'complete', ?, 4, 3)`,
      )
      .run(uuid(20), uuid(2), uuid(10), 'a'.repeat(64), TS);
  } finally {
    seed.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-mig6-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migration 0006', () => {
  test('0006 keeps existing data and adds the job and file_analysis tables', async () => {
    await createDatabaseUpTo0005();
    seedAssetWithFile();

    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    try {
      expect(await db.files.get(uuid(20))).toMatchObject({ id: uuid(20), status: 'complete', width: 4, height: 3 });
      expect(await db.jobs.counts()).toMatchObject({ queued: 0, running: 0 });
      expect(await db.analyses.get(uuid(20))).toBeNull();
    } finally {
      await db.close();
    }

    const check = new Database(dbPath);
    try {
      const tables = check
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('job', 'file_analysis') ORDER BY name")
        .all();
      expect(tables).toEqual([{ name: 'file_analysis' }, { name: 'job' }]);
      const insertJob = (id: string, status: string, resourceClass = 'local_gpu') =>
        check
          .prepare(
            `INSERT INTO job (id, type, resource_class, status, file_id, payload, attempt, created_at, updated_at)
             VALUES (?, 'vision.analyze_file', ?, ?, ?, '{"version":1}', 0, ?, ?)`,
          )
          .run(id, resourceClass, status, uuid(20), TS, TS);
      expect(() => insertJob(uuid(30), 'paused')).toThrow(/CHECK constraint failed/);
      expect(() => insertJob(uuid(31), 'queued', 'quantum')).toThrow(/CHECK constraint failed/);
      insertJob(uuid(32), 'queued');
      check.pragma('foreign_keys = ON');
      expect(() => insertJob(uuid(33), 'queued')).not.toThrow();
      expect(() =>
        check
          .prepare(
            `INSERT INTO file_analysis (file_id, sha256, provider, model, prompt_version, analysed_at) VALUES (?, ?, 'ollama', 'm', 1, ?)`,
          )
          .run(uuid(99), 'a'.repeat(64), TS),
      ).toThrow(/FOREIGN KEY/);
      expect(check.pragma('foreign_key_check')).toEqual([]);
    } finally {
      check.close();
    }
  });
});
