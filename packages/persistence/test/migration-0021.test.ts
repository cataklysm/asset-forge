import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';
import { migrationsUpTo } from './migrations-folder.js';

const LINEAGE = /^[0-9a-f]{32}$/;
const ID = '11111111-1111-4111-8111-111111111111';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-migration21-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A database at migration 0020 with a workspace row written by hand, then upgraded.
 *
 * @param name the file name
 * @returns the lineage the upgrade gave it
 */
async function upgradedLineage(name: string): Promise<string> {
  const folder = await migrationsUpTo(join(dir, `before-${name}`), 21);
  const path = join(dir, name);
  const old = await openWorkspaceDatabase(path, folder);
  await old.close();
  const raw = new Database(path);
  raw
    .prepare(
      "INSERT INTO workspace (id, format_version, name, created_at) VALUES (?, 1, 'Old', '2026-01-01T00:00:00Z')",
    )
    .run(ID);
  raw.close();
  const upgraded = await openWorkspaceDatabase(path, MIGRATIONS_FOLDER);
  try {
    return (await upgraded.meta.get())!.lineageId;
  } finally {
    await upgraded.close();
  }
}

test('existing workspace row gets a 32-hex lineage', async () => {
  expect(await upgradedLineage('one.sqlite')).toMatch(LINEAGE);
});

test('two databases get different lineages', async () => {
  const first = await upgradedLineage('one.sqlite');
  const second = await upgradedLineage('two.sqlite');
  expect(first).not.toBe(second);
});

test('a fresh database gets one through init', async () => {
  const database = await openWorkspaceDatabase(join(dir, 'fresh.sqlite'), MIGRATIONS_FOLDER);
  try {
    await database.meta.init({ id: ID, formatVersion: 1, name: 'New', createdAt: '2026-01-01T00:00:00Z' });
    expect((await database.meta.get())!.lineageId).toMatch(LINEAGE);
  } finally {
    await database.close();
  }
});
