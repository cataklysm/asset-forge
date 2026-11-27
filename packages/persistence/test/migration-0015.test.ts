import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const UP_TO_0014 = [
  '0000_brainy_tag',
  '0001_regular_gideon',
  '0002_outgoing_franklin_richards',
  '0003_messy_korath',
  '0004_dear_zaladane',
  '0005_lush_mother_askani',
  '0006_cuddly_micromacro',
  '0007_daffy_doctor_faustus',
  '0008_neat_firestar',
  '0009_clever_shotgun',
  '0010_right_captain_stacy',
  '0011_eager_wonder_man',
  '0012_clear_kate_bishop',
  '0013_swift_purple_man',
  '0014_icy_prowler',
];
const TS = '2026-11-27T10:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let dir: string;
let dbPath: string;

/** Applies only the migrations up to 0014, the way the prompt library build left the database. */
async function createDatabaseUpTo0014(): Promise<void> {
  const folder = join(dir, 'upto0014-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  for (const tag of UP_TO_0014) {
    await copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => UP_TO_0014.includes(e.tag));
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}

/** One complete file and one succeeded analysis job of it. */
function seed(): void {
  const s = new Database(dbPath);
  try {
    s.prepare('INSERT INTO workspace (id, format_version, name, created_at) VALUES (?, 1, ?, ?)').run(uuid(1), 'ws', TS);
    s.prepare('INSERT INTO storage (id, kind, created_at) VALUES (?, ?, ?)').run(uuid(2), 'workspace_root', TS);
    s.prepare(
      `INSERT INTO file (id, storage_id, original_name, relative_path, mime_type, size_bytes, sha256, kind, status, imported_at)
       VALUES (?, ?, 'oak.png', ?, 'image/png', 1, ?, 'image', 'complete', ?)`,
    ).run(uuid(3), uuid(2), `inbox/${uuid(3)}/oak.png`, 'a'.repeat(64), TS);
    s.prepare(
      `INSERT INTO job (id, type, resource_class, status, file_id, provider_id, payload, attempt, created_at, finished_at, updated_at)
       VALUES (?, 'vision.analyze_file', 'local_gpu', 'succeeded', ?, 'p1', '{"version":1}', 1, ?, ?, ?)`,
    ).run(uuid(10), uuid(3), TS, TS, TS);
  } finally {
    s.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-mig15-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migration 0015', () => {
  test('0015 adds file_origin and job.result, leaving the file and the job untouched', async () => {
    await createDatabaseUpTo0014();
    seed();

    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    try {
      expect(await db.files.get(uuid(3))).toMatchObject({ status: 'complete', originalName: 'oak.png' });
      const { items } = await db.jobs.list({ limit: 10, offset: 0 });
      expect(items).toEqual([expect.objectContaining({ id: uuid(10), status: 'succeeded', fileName: 'oak.png', result: null })]);
      expect(await db.fileOrigins.listByFile(uuid(3))).toEqual([]);
    } finally {
      await db.close();
    }

    const check = new Database(dbPath);
    try {
      expect(check.prepare('SELECT result FROM job WHERE id = ?').get(uuid(10))).toEqual({ result: null });
      expect(check.prepare('SELECT count(*) AS n FROM file_origin').get()).toEqual({ n: 0 });
      expect(check.pragma('foreign_key_list(file_origin)')).toEqual([
        expect.objectContaining({ table: 'file', from: 'file_id', on_delete: 'CASCADE' }),
      ]);
    } finally {
      check.close();
    }
  });
});
