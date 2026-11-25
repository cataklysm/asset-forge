import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const PHASE_2A_TAGS = ['0000_brainy_tag', '0001_regular_gideon'];
const TS = '2026-01-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let dir: string;
let dbPath: string;
let db: WorkspaceDatabase | undefined;

/** Applies only the migrations up to 0001, the way a phase 2a build left the database. */
async function createPhase2aDatabase(): Promise<void> {
  const folder = join(dir, 'phase2a-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  for (const tag of PHASE_2A_TAGS) {
    await copyFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => PHASE_2A_TAGS.includes(e.tag));
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-mig2-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  await db?.close();
  db = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe('migration 0002', () => {
  test('upgrades a phase 2a database', async () => {
    await createPhase2aDatabase();
    const seed = new Database(dbPath);
    const insertType = seed.prepare(
      'INSERT INTO asset_type (id, key, name, sort_order, built_in) VALUES (?, ?, ?, ?, 1)',
    );
    insertType.run(uuid(1), 'character', 'Character', 0);
    insertType.run(uuid(2), 'prop', 'Prop', 1);
    seed
      .prepare(
        `INSERT INTO asset (id, name, type_id, description, status, created_at, updated_at)
         VALUES (?, 'Pump', ?, 'd', 'in_review', ?, ?)`,
      )
      .run(uuid(10), uuid(2), TS, TS);
    seed.close();

    db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    expect(await db.assetTypes.list()).toEqual([
      { id: uuid(1), key: 'character', name: 'Character', sortOrder: 0, builtIn: true, defaultWorkflowTemplateId: null },
      { id: uuid(2), key: 'prop', name: 'Prop', sortOrder: 1, builtIn: true, defaultWorkflowTemplateId: null },
    ]);
    const list = await db.assets.list({ limit: 10, offset: 0 });
    expect(list.items).toEqual([
      {
        id: uuid(10),
        name: 'Pump',
        typeId: uuid(2),
        description: 'd',
        status: 'in_review',
        createdAt: TS,
        updatedAt: TS,
        projectCount: 0,
        fileCount: 0,
        workflowProgress: null,
        coverFileId: null,
      },
    ]);
    expect(await db.assetWorkflows.getByAsset(uuid(10))).toBeNull();
  });
});
