import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const TS = '2026-11-28T10:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PARAMETERS = JSON.stringify({ v: 1, aspectRatio: null, resolution: null, safeMode: true });

let dir: string;
let dbPath: string;

/** Applies every migration before 0018, the way the readability clean-up left the database. */
async function createDatabaseUpTo0017(): Promise<void> {
  const folder = join(dir, 'upto0017-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx < 18);
  for (const entry of journal.entries) {
    await copyFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}

/** Two files, a library prompt with one version, two generations with their inputs and outputs. */
function seed(): void {
  const s = new Database(dbPath);
  try {
    s.pragma('foreign_keys = ON');
    s.prepare(
      'INSERT INTO workspace (id, format_version, name, created_at, derived_data_version) VALUES (?, 1, ?, ?, 3)',
    ).run(uuid(1), 'ws', TS);
    s.prepare('INSERT INTO storage (id, kind, created_at) VALUES (?, ?, ?)').run(uuid(2), 'workspace_root', TS);
    const insertFile = s.prepare(
      `INSERT INTO file (id, storage_id, original_name, relative_path, mime_type, size_bytes, sha256, kind, status, imported_at)
       VALUES (?, ?, ?, ?, 'image/png', 1, ?, 'image', 'complete', ?)`,
    );
    insertFile.run(uuid(3), uuid(2), 'oak.png', `inbox/${uuid(3)}_oak.png`, 'a'.repeat(64), TS);
    insertFile.run(uuid(4), uuid(2), 'oak edit 1.png', `inbox/${uuid(4)}_oak edit 1.png`, 'b'.repeat(64), TS);
    s.prepare(
      "INSERT INTO prompt (id, title, title_key, description, created_at, updated_at) VALUES (?, 'Night', 'night', '', ?, ?)",
    ).run(uuid(5), TS, TS);
    s.prepare(
      "INSERT INTO prompt_version (id, prompt_id, number, content, variables, created_at) VALUES (?, ?, 1, 'Make it {{time}}', '[]', ?)",
    ).run(uuid(6), uuid(5), TS);
    s.prepare(
      `INSERT INTO generation (id, kind, status, provider_id, provider_name, provider_kind, model, prompt, parameters, created_at, finished_at, prompt_version_id, prompt_title, prompt_version_number, prompt_variables)
       VALUES (?, 'edit', 'succeeded', 'p1', 'Venice', 'venice', 'qwen-image', 'Make it night', ?, ?, ?, ?, 'Night', 1, ?)`,
    ).run(uuid(10), PARAMETERS, TS, TS, uuid(6), JSON.stringify({ v: 1, values: { time: 'night' } }));
    s.prepare(
      `INSERT INTO generation (id, kind, status, error_code, provider_id, provider_name, provider_kind, parameters, job_id, created_at)
       VALUES (?, 'upscale', 'failed', 'provider_outcome_unknown', 'p1', 'Venice', 'venice', ?, ?, ?)`,
    ).run(uuid(11), JSON.stringify({ v: 1, scale: 2 }), uuid(30), '2026-11-28T11:00:00.000Z');
    const insertInput = s.prepare(
      'INSERT INTO generation_input (generation_id, position, file_id, sha256, original_name) VALUES (?, ?, ?, ?, ?)',
    );
    insertInput.run(uuid(10), 0, uuid(3), 'a'.repeat(64), 'oak.png');
    insertInput.run(uuid(11), 0, null, 'c'.repeat(64), 'purged.png');
    const insertOutput = s.prepare(
      'INSERT INTO generation_output (generation_id, position, file_id, sha256, original_name) VALUES (?, ?, ?, ?, ?)',
    );
    insertOutput.run(uuid(10), 0, uuid(4), 'b'.repeat(64), 'oak edit 1.png');
    insertOutput.run(uuid(10), 1, null, 'd'.repeat(64), 'oak edit 2.png');
  } finally {
    s.close();
  }
}

/**
 * Every row of the three generation tables in a fixed order.
 *
 * @param s the connection
 * @returns the rows per table
 */
function snapshot(s: Database.Database): Record<string, unknown[]> {
  return {
    generation: s.prepare('SELECT * FROM generation ORDER BY id').all(),
    input: s.prepare('SELECT * FROM generation_input ORDER BY generation_id, position').all(),
    output: s.prepare('SELECT * FROM generation_output ORDER BY generation_id, position').all(),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-mig18-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migration 0018', () => {
  test('0018 rebuilds generation with the current provider kind check and keeps rows, indexes and foreign keys', async () => {
    await createDatabaseUpTo0017();
    seed();
    const before = new Database(dbPath);
    const rowsBefore = snapshot(before);
    before.close();
    expect(rowsBefore.input).toHaveLength(2);
    expect(rowsBefore.output).toHaveLength(2);

    const db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    await db.close();

    const check = new Database(dbPath);
    try {
      check.pragma('foreign_keys = ON');
      expect(snapshot(check)).toEqual(rowsBefore);
      expect(check.pragma('foreign_key_check')).toEqual([]);
      const indexes = (table: string) =>
        (check.pragma(`index_list(${table})`) as { name: string }[]).map((index) => index.name);
      expect(indexes('generation')).toEqual(
        expect.arrayContaining([
          'generation_job_id_idx',
          'generation_created_at_idx',
          'generation_prompt_version_id_idx',
        ]),
      );
      expect(indexes('generation_input')).toContain('generation_input_file_id_idx');
      expect(indexes('generation_output')).toContain('generation_output_file_id_idx');
      const keys = (table: string) =>
        (check.pragma(`foreign_key_list(${table})`) as { table: string; from: string; on_delete: string }[])
          .map((key) => `${key.from}->${key.table}:${key.on_delete}`)
          .sort();
      expect(keys('generation')).toEqual(['prompt_version_id->prompt_version:SET NULL']);
      expect(keys('generation_input')).toEqual(['file_id->file:SET NULL', 'generation_id->generation:CASCADE']);
      expect(keys('generation_output')).toEqual(['file_id->file:SET NULL', 'generation_id->generation:CASCADE']);
      const leftovers = check
        .prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE '\\_\\_new%' ESCAPE '\\' OR name LIKE '\\_\\_park%' ESCAPE '\\'",
        )
        .all() as { name: string }[];
      expect(leftovers).toEqual([]);

      check
        .prepare(
          `INSERT INTO generation (id, kind, status, provider_id, provider_name, provider_kind, parameters, created_at)
           VALUES (?, 'upscale', 'pending', 'p2', 'vLLM', 'openai', ?, ?)`,
        )
        .run(uuid(12), PARAMETERS, TS);
      expect(() =>
        check
          .prepare(
            `INSERT INTO generation (id, kind, status, provider_id, provider_name, provider_kind, parameters, created_at)
             VALUES (?, 'upscale', 'pending', 'p3', 'Other', 'other', ?, ?)`,
          )
          .run(uuid(13), PARAMETERS, TS),
      ).toThrow(/CHECK constraint failed/);

      check.prepare('DELETE FROM prompt_version WHERE id = ?').run(uuid(6));
      expect(check.prepare('SELECT prompt_version_id AS id FROM generation WHERE id = ?').get(uuid(10))).toEqual({
        id: null,
      });
      check.prepare('DELETE FROM generation WHERE id = ?').run(uuid(10));
      expect(check.prepare('SELECT count(*) AS n FROM generation_output').get()).toEqual({ n: 0 });
      expect(check.prepare('SELECT count(*) AS n FROM generation_input').get()).toEqual({ n: 1 });
    } finally {
      check.close();
    }
  });
});
