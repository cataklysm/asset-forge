import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FileRecordSchema } from '@assetforge/contracts';
import type { WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const PHASE_1_TAG = '0000_brainy_tag';
const WORKSPACE_CREATED_AT = '2026-01-01T00:00:00.000Z';
const HASH = 'a'.repeat(64);

const phase1Files = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    original_name: 'done.png',
    relative_path: 'inbox/11111111-1111-4111-8111-111111111111_done.png',
    mime_type: 'image/png',
    size_bytes: 5,
    sha256: HASH,
    status: 'complete',
    error: null,
    imported_at: '2026-01-02T00:00:00.000Z',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    original_name: 'broken.png',
    relative_path: 'inbox/22222222-2222-4222-8222-222222222222_broken.png',
    mime_type: 'image/png',
    size_bytes: null,
    sha256: null,
    status: 'failed',
    error: 'Import failed',
    imported_at: '2026-01-03T00:00:00.000Z',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    original_name: 'half.png',
    relative_path: 'inbox/33333333-3333-4333-8333-333333333333_half.png',
    mime_type: 'image/png',
    size_bytes: null,
    sha256: null,
    status: 'pending',
    error: null,
    imported_at: '2026-01-04T00:00:00.000Z',
  },
];

let dir: string;
let dbPath: string;
let db: WorkspaceDatabase | undefined;
let raw: Database.Database | undefined;

/** Applies only the phase 1 migration, the way a phase 1 build left the database. */
async function createPhase1Database(): Promise<void> {
  const folder = join(dir, 'phase1-migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  await copyFile(join(MIGRATIONS_FOLDER, `${PHASE_1_TAG}.sql`), join(folder, `${PHASE_1_TAG}.sql`));
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => e.tag === PHASE_1_TAG);
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    sqlite.close();
  }
}

/** A second connection on the same file, with foreign keys enforced as the adapter does. */
function openRaw(): Database.Database {
  raw = new Database(dbPath);
  raw.pragma('foreign_keys = ON');
  return raw;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-mig-'));
  dbPath = join(dir, 'assetforge.sqlite');
});

afterEach(async () => {
  raw?.close();
  raw = undefined;
  await db?.close();
  db = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe('migration 0001', () => {
  test('upgrades a phase 1 database', async () => {
    await createPhase1Database();
    const seed = new Database(dbPath);
    seed
      .prepare('INSERT INTO workspace (id, format_version, name, created_at) VALUES (?, ?, ?, ?)')
      .run('44444444-4444-4444-8444-444444444444', 1, 'Old', WORKSPACE_CREATED_AT);
    const insert = seed.prepare(
      `INSERT INTO file (id, asset_id, original_name, relative_path, mime_type, size_bytes, sha256, status, error, imported_at)
       VALUES (@id, NULL, @original_name, @relative_path, @mime_type, @size_bytes, @sha256, @status, @error, @imported_at)`,
    );
    for (const f of phase1Files) insert.run(f);
    seed.close();

    db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    const primary = await db.storages.getPrimary();
    expect(primary).not.toBeNull();
    expect(FileRecordSchema.shape.storageId.safeParse(primary!.id).success).toBe(true);
    expect(primary!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(primary!.kind).toBe('workspace_root');
    expect(primary!.createdAt).toBe(WORKSPACE_CREATED_AT);

    const list = await db.files.list({ limit: 10, offset: 0, scope: { kind: 'all' } });
    expect(list.total).toBe(3);
    for (const f of phase1Files) {
      const item = list.items.find((i) => i.id === f.id);
      expect(item).toBeDefined();
      expect(() => FileRecordSchema.parse(item)).not.toThrow();
      expect(item).toMatchObject({
        storageId: primary!.id,
        role: null,
        originalName: f.original_name,
        relativePath: f.relative_path,
        mimeType: f.mime_type,
        sizeBytes: f.size_bytes,
        sha256: f.sha256,
        status: f.status,
        error: f.error,
        importedAt: f.imported_at,
      });
    }
    expect(openRaw().pragma('foreign_key_check')).toEqual([]);
  });

  test('dates the storage of a database without a workspace row at the upgrade time', async () => {
    await createPhase1Database();
    const seed = new Database(dbPath);
    seed
      .prepare(
        `INSERT INTO file (id, original_name, relative_path, mime_type, status, imported_at)
         VALUES (@id, @original_name, @relative_path, @mime_type, @status, @imported_at)`,
      )
      .run(phase1Files[2]!);
    seed.close();

    const before = Date.now();
    db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    const primary = await db.storages.getPrimary();
    expect(primary!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(primary!.createdAt)).toBeGreaterThanOrEqual(before - 1000);
    expect((await db.files.list({ limit: 10, offset: 0, scope: { kind: 'all' } })).items[0]!.storageId).toBe(primary!.id);
  });

  test('leaves a database without rows without a storage', async () => {
    await createPhase1Database();
    db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    expect(await db.storages.getPrimary()).toBeNull();

    const first = { id: '55555555-5555-4555-8555-555555555555', createdAt: WORKSPACE_CREATED_AT };
    expect(await db.storages.ensurePrimary(first)).toEqual({ ...first, kind: 'workspace_root' });
    const second = { id: '66666666-6666-4666-8666-666666666666', createdAt: '2026-02-01T00:00:00.000Z' };
    expect(await db.storages.ensurePrimary(second)).toEqual({ ...first, kind: 'workspace_root' });
    expect(await db.storages.getPrimary()).toEqual({ ...first, kind: 'workspace_root' });
  });

  test('rejects a file row without a storage', async () => {
    db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    const insert = openRaw().prepare(
      `INSERT INTO file (id, storage_id, original_name, relative_path, mime_type, status, imported_at)
       VALUES ('77777777-7777-4777-8777-777777777777', ?, 'a.png', 'inbox/a.png', 'image/png', 'pending', ?)`,
    );
    expect(() => insert.run(null, WORKSPACE_CREATED_AT)).toThrow(/NOT NULL/);
    expect(() => insert.run('88888888-8888-4888-8888-888888888888', WORKSPACE_CREATED_AT)).toThrow(/FOREIGN KEY/);
  });

  test('rejects a role without an asset', async () => {
    db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    const storage = await db.storages.ensurePrimary({
      id: '55555555-5555-4555-8555-555555555555',
      createdAt: WORKSPACE_CREATED_AT,
    });
    const insert = openRaw().prepare(
      `INSERT INTO file (id, storage_id, role, original_name, relative_path, mime_type, status, imported_at)
       VALUES ('77777777-7777-4777-8777-777777777777', ?, 'reference', 'a.png', 'inbox/a.png', 'image/png', 'pending', ?)`,
    );
    expect(() => insert.run(storage.id, WORKSPACE_CREATED_AT)).toThrow(/CHECK/);
  });

  test('rejects an asset with an unknown type', async () => {
    db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
    const insert = openRaw().prepare(
      `INSERT INTO asset (id, name, type_id, status, created_at, updated_at)
       VALUES ('77777777-7777-4777-8777-777777777777', 'A', '99999999-9999-4999-8999-999999999999', 'draft', ?, ?)`,
    );
    expect(() => insert.run(WORKSPACE_CREATED_AT, WORKSPACE_CREATED_AT)).toThrow(/FOREIGN KEY/);
  });
});
