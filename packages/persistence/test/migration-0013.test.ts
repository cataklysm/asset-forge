import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const UP_TO_0012 = [
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
];
const TS = '2026-01-01T00:00:00.000Z';
const TYPE = 'vision.analyze_file';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let dir: string;
let dbPath: string;

/** Applies only the migrations up to 0012, the way the vision providers build left the database. */
async function createDatabaseUpTo0012(): Promise<void> {
  const folder = join(dir, 'upto0012-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  for (const tag of UP_TO_0012) {
    await copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => UP_TO_0012.includes(e.tag));
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}

/** One complete file and one queued analysis job of it. */
function seed(): void {
  const s = new Database(dbPath);
  try {
    s.prepare('INSERT INTO workspace (id, format_version, name, created_at) VALUES (?, 1, ?, ?)').run(
      uuid(1),
      'ws',
      TS,
    );
    s.prepare('INSERT INTO storage (id, kind, created_at) VALUES (?, ?, ?)').run(uuid(2), 'workspace_root', TS);
    s.prepare(
      `INSERT INTO file (id, storage_id, original_name, relative_path, mime_type, size_bytes, sha256, kind, status, imported_at)
       VALUES (?, ?, 'oak.png', ?, 'image/png', 1, ?, 'image', 'complete', ?)`,
    ).run(uuid(3), uuid(2), `inbox/${uuid(3)}/oak.png`, 'a'.repeat(64), TS);
    s.prepare(
      `INSERT INTO job (id, type, resource_class, status, file_id, provider_id, payload, attempt, created_at, updated_at)
       VALUES (?, ?, 'local_gpu', 'queued', ?, 'p1', ?, 0, ?, ?)`,
    ).run(uuid(10), TYPE, uuid(3), JSON.stringify({ version: 1 }), TS, TS);
  } finally {
    s.close();
  }
}

const columnNames = (s: Database.Database, table: string) =>
  (s.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
const indexColumns = (s: Database.Database, index: string) =>
  (s.pragma(`index_info(${index})`) as { name: string }[]).map((c) => c.name);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-mig13-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migration 0013', () => {
  test('0013 adds the generation tables and indexes and leaves the old rows untouched', async () => {
    await createDatabaseUpTo0012();
    seed();

    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    try {
      expect(await db.jobs.get(uuid(10))).toMatchObject({
        status: 'queued',
        lane: 'p1',
        fileId: uuid(3),
        payload: { version: 1 },
      });
      expect(await db.files.get(uuid(3))).toMatchObject({
        status: 'complete',
        originalName: 'oak.png',
        sha256: 'a'.repeat(64),
      });
      expect(await db.generations.resultsOf(uuid(3), 10)).toEqual([]);
    } finally {
      await db.close();
    }

    const check = new Database(dbPath);
    try {
      expect(columnNames(check, 'generation')).toEqual([
        'id',
        'kind',
        'status',
        'error_code',
        'provider_id',
        'provider_name',
        'provider_kind',
        'model',
        'prompt',
        'parameters',
        'job_id',
        'created_at',
        'finished_at',
        // Added by 0014.
        'prompt_version_id',
        'prompt_title',
        'prompt_version_number',
        'prompt_variables',
      ]);
      for (const table of ['generation_input', 'generation_output']) {
        expect(columnNames(check, table)).toEqual(['generation_id', 'position', 'file_id', 'sha256', 'original_name']);
        expect(check.pragma(`foreign_key_list(${table})`)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ table: 'generation', from: 'generation_id', on_delete: 'CASCADE' }),
            expect.objectContaining({ table: 'file', from: 'file_id', on_delete: 'SET NULL' }),
          ]),
        );
        expect(indexColumns(check, `${table}_file_id_idx`)).toEqual(['file_id']);
      }
      // 0013 adds none; the only one is 0014's prompt version reference.
      expect(check.pragma('foreign_key_list(generation)')).toEqual([
        expect.objectContaining({ table: 'prompt_version', from: 'prompt_version_id' }),
      ]);
      expect(indexColumns(check, 'generation_job_id_idx')).toEqual(['job_id']);
      expect(indexColumns(check, 'generation_created_at_idx')).toEqual(['created_at', 'id']);
      expect(check.prepare('SELECT id, status, file_id, provider_id FROM job').all()).toEqual([
        { id: uuid(10), status: 'queued', file_id: uuid(3), provider_id: 'p1' },
      ]);
      expect(check.prepare('SELECT id, status FROM file').all()).toEqual([{ id: uuid(3), status: 'complete' }]);
      expect(check.prepare('SELECT count(*) AS n FROM generation').get()).toEqual({ n: 0 });
    } finally {
      check.close();
    }
  });
});
