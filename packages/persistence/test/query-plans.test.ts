import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ANALYZE_FILE_JOB } from '@assetforge/contracts';
import { PREVIEWABLE_MIME_TYPES, type WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

// The plans of statements the scale test does not cover: they must reach their table through a key or an index.

const T0 = '2026-01-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STORAGE_ID = uuid(1);

let dir: string;
let db: WorkspaceDatabase;
let handle: Database.Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-plans-'));
  const pragma = vi.spyOn(Database.prototype, 'pragma');
  try {
    db = await openWorkspaceDatabase(join(dir, 'ws.db'), MIGRATIONS_FOLDER);
    handle = pragma.mock.contexts[0] as Database.Database;
  } finally {
    pragma.mockRestore();
  }
  await db.storages.ensurePrimary({ id: STORAGE_ID, createdAt: T0 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

/** A statement as the repository ran it. */
interface RanStatement {
  source: string;
  parameters: unknown[];
}

/**
 * The SELECT statements the connection runs while `run` runs, with the values they were bound to.
 *
 * @param run the repository call
 * @returns the SQL text and the parameters of each SELECT
 */
async function ranSelects(run: () => Promise<unknown>): Promise<RanStatement[]> {
  const ran: RanStatement[] = [];
  const prepare = handle.prepare.bind(handle);
  const spy = vi.spyOn(handle, 'prepare').mockImplementation((source: string) => {
    const statement = prepare(source);
    for (const method of ['all', 'get', 'run'] as const) {
      const original = statement[method].bind(statement) as (...parameters: unknown[]) => unknown;
      Object.assign(statement, {
        [method]: (...parameters: unknown[]) => {
          ran.push({ source, parameters });
          return original(...parameters);
        },
      });
    }
    return statement;
  });
  try {
    await run();
    return ran.filter((statement) => /^\s*select/i.test(statement.source));
  } finally {
    spy.mockRestore();
  }
}

/**
 * The plan of a statement with its parameters.
 *
 * @param statement the SQL text and the parameters
 * @returns the detail lines of the plan
 */
function planOf(statement: RanStatement): string[] {
  const rows = handle.prepare(`explain query plan ${statement.source}`).all(...statement.parameters);
  return (rows as { detail: string }[]).map((row) => row.detail);
}

describe('query plans', () => {
  test('the target reader page reaches the files of a files target by key', async () => {
    const statements = await ranSelects(() =>
      db.analysisTargets.page({
        target: { kind: 'files', fileIds: [uuid(10), uuid(11)] },
        fingerprint: { provider: 'ollama', model: 'qwen', promptVersion: 1 },
        mimeTypes: PREVIEWABLE_MIME_TYPES,
        afterId: null,
        limit: 500,
      }),
    );
    expect(statements).toHaveLength(1);
    const lines = planOf(statements[0]!);
    expect(lines.some((line) => /^SEARCH file USING (INDEX|PRIMARY KEY|COVERING INDEX)\b/.test(line))).toBe(true);
    expect(lines.filter((line) => line.startsWith('SCAN '))).toEqual([]);
  });

  test('the target reader page of an asset target reaches its files through the asset index', async () => {
    const statements = await ranSelects(() =>
      db.analysisTargets.page({
        target: { kind: 'asset', assetId: uuid(20) },
        fingerprint: { provider: 'ollama', model: 'qwen', promptVersion: 1 },
        mimeTypes: PREVIEWABLE_MIME_TYPES,
        afterId: uuid(10),
        limit: 500,
      }),
    );
    expect(statements).toHaveLength(1);
    const lines = planOf(statements[0]!);
    expect(lines.filter((line) => line.startsWith('SCAN '))).toEqual([]);
    expect(lines.some((line) => /^SEARCH file USING .*INDEX/.test(line))).toBe(true);
  });

  test('the newest job of a file walks job_file_id_type_created_at_idx', async () => {
    const statements = await ranSelects(() => db.jobs.latestForFile(uuid(10), ANALYZE_FILE_JOB));
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      const lines = planOf(statement);
      expect(lines.filter((line) => line.startsWith('SCAN '))).toEqual([]);
      expect(lines.some((line) => line.includes('job_file_id_type_created_at_idx'))).toBe(true);
      expect(lines.some((line) => line.includes('TEMP B-TREE'))).toBe(false);
    }
  });

  test('the gallery page without a query walks asset_name_lower_id_idx in its order', async () => {
    const statements = await ranSelects(() => db.assets.list({ offset: 0, limit: 50 }));
    const page = statements.find((statement) => /order by lower\(/i.test(statement.source));
    expect(page).toBeDefined();
    const lines = planOf(page!);
    expect(lines.some((line) => line.includes('asset_name_lower_id_idx'))).toBe(true);
    expect(lines.some((line) => line.includes('TEMP B-TREE'))).toBe(false);
  });

  test('the inbox page walks file_asset_id_imported_at_id_idx in its order', async () => {
    const statements = await ranSelects(() => db.files.list({ scope: { kind: 'inbox' }, offset: 0, limit: 100 }));
    const page = statements.find((statement) => /order by/i.test(statement.source));
    expect(page).toBeDefined();
    const lines = planOf(page!);
    expect(lines.some((line) => line.includes('file_asset_id_imported_at_id_idx'))).toBe(true);
    expect(lines.some((line) => line.includes('TEMP B-TREE'))).toBe(false);
  });

  test('the files of an asset come in their order from the same index', async () => {
    const statements = await ranSelects(() =>
      db.files.list({ scope: { kind: 'asset', assetId: uuid(20) }, offset: 0, limit: 100 }),
    );
    const page = statements.find((statement) => /order by/i.test(statement.source));
    const lines = planOf(page!);
    expect(lines.some((line) => line.includes('file_asset_id_imported_at_id_idx'))).toBe(true);
    expect(lines.some((line) => line.includes('TEMP B-TREE'))).toBe(false);
  });

  test('clearing a cover and a prompt version reach their rows through an index', () => {
    const cover = handle.prepare('explain query plan update asset set cover_file_id = null where cover_file_id = ?');
    expect((cover.all(uuid(10)) as { detail: string }[]).map((row) => row.detail)).toEqual([
      expect.stringContaining('asset_cover_file_id_idx'),
    ]);
    const version = handle.prepare('explain query plan select id from generation where prompt_version_id = ?');
    expect((version.all(uuid(11)) as { detail: string }[]).map((row) => row.detail)).toEqual([
      expect.stringContaining('generation_prompt_version_id_idx'),
    ]);
  });
});
