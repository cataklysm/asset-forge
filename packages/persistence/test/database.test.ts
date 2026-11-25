import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FileRecordSchema } from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError, type WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const meta = {
  id: '11111111-1111-4111-8111-111111111111',
  formatVersion: 1,
  name: 'Test',
  createdAt: '2026-01-01T00:00:00.000Z',
};

let dir: string;
let dbPath: string;
let db: WorkspaceDatabase | undefined;

const STORAGE_ID = '22222222-2222-4222-8222-222222222222';

const open = async () => {
  db = await openWorkspaceDatabase(dbPath, MIGRATIONS_FOLDER);
  await db.storages.ensurePrimary({ id: STORAGE_ID, createdAt: '2026-01-01T00:00:00.000Z' });
  return db;
};
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pending = (n: number, importedAt = '2026-01-01T00:00:00.000Z') => ({
  id: uuid(n),
  storageId: STORAGE_ID,
  originalName: `f${n}.png`,
  relativePath: `files/f${n}.png`,
  mimeType: 'image/png',
  importedAt,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-db-'));
  dbPath = join(dir, 'nested', 'assetforge.sqlite');
});

afterEach(async () => {
  await db?.close();
  db = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe('workspace database', () => {
  test('creates the file; meta is null until init', async () => {
    const d = await open();
    expect((await stat(dbPath)).isFile()).toBe(true);
    expect(await d.meta.get()).toBeNull();
    await d.meta.init(meta);
    expect(await d.meta.get()).toEqual(meta);
  });

  test('reopening applies migrations idempotently and keeps data', async () => {
    let d = await open();
    await d.meta.init(meta);
    await d.files.insertPending(pending(1));
    await d.close();
    d = await open();
    expect(await d.meta.get()).toEqual(meta);
    expect((await d.files.list({ limit: 10, offset: 0 })).total).toBe(1);
  });

  test('insertPending yields a pending record', async () => {
    const d = await open();
    await d.files.insertPending(pending(1));
    const list = await d.files.list({ limit: 10, offset: 0 });
    expect(list.total).toBe(1);
    expect(list.items[0]).toEqual({
      ...pending(1),
      assetId: null,
      role: null,
      sizeBytes: null,
      sha256: null,
      status: 'pending',
      error: null,
    });
    expect(() => FileRecordSchema.parse(list.items[0])).not.toThrow();
  });

  test('markComplete and markFailed update status', async () => {
    const d = await open();
    await d.files.insertPending(pending(1));
    await d.files.insertPending(pending(2));
    await d.files.markComplete(uuid(1), { sizeBytes: 42, sha256: HASH_A });
    await d.files.markFailed(uuid(2), 'disk full');
    const { items } = await d.files.list({ limit: 10, offset: 0 });
    const one = items.find((i) => i.id === uuid(1));
    const two = items.find((i) => i.id === uuid(2));
    expect(one).toMatchObject({ status: 'complete', sizeBytes: 42, sha256: HASH_A, error: null });
    expect(two).toMatchObject({ status: 'failed', error: 'disk full' });
    items.forEach((i) => FileRecordSchema.parse(i));
  });

  test('findCompleteBySha256 returns only complete rows with that hash', async () => {
    const d = await open();
    for (const n of [1, 2, 3, 4]) await d.files.insertPending(pending(n));
    await d.files.markComplete(uuid(1), { sizeBytes: 1, sha256: HASH_A });
    await d.files.markComplete(uuid(2), { sizeBytes: 1, sha256: HASH_B });
    await d.files.markComplete(uuid(3), { sizeBytes: 1, sha256: HASH_A });
    const found = await d.files.findCompleteBySha256(HASH_A);
    expect(found.map((f) => f.id).sort()).toEqual([uuid(1), uuid(3)]);
    expect(await d.files.findCompleteBySha256('c'.repeat(64))).toEqual([]);
  });

  test('listByStatus returns only rows with that status', async () => {
    const d = await open();
    for (const n of [1, 2, 3]) await d.files.insertPending(pending(n));
    await d.files.markComplete(uuid(1), { sizeBytes: 1, sha256: HASH_A });
    await d.files.markFailed(uuid(3), 'x');
    expect((await d.files.listByStatus('pending')).map((f) => f.id)).toEqual([uuid(2)]);
    expect((await d.files.listByStatus('failed')).map((f) => f.id)).toEqual([uuid(3)]);
  });

  test('list orders newest first with stable tie-break and paginates', async () => {
    const d = await open();
    await d.files.insertPending(pending(1, '2026-01-01T00:00:00.000Z'));
    await d.files.insertPending(pending(2, '2026-01-03T00:00:00.000Z'));
    await d.files.insertPending(pending(3, '2026-01-02T00:00:00.000Z'));
    const all = await d.files.list({ limit: 10, offset: 0 });
    expect(all.items.map((f) => f.id)).toEqual([uuid(2), uuid(3), uuid(1)]);
    const page = await d.files.list({ limit: 2, offset: 1 });
    expect(page.items.map((f) => f.id)).toEqual([uuid(3), uuid(1)]);
    expect(page.total).toBe(3);

    await d.files.insertPending(pending(4, '2026-01-03T00:00:00.000Z'));
    const tied = await d.files.list({ limit: 10, offset: 0 });
    expect(tied.items.slice(0, 2).map((f) => f.id)).toEqual([uuid(4), uuid(2)]);
  });

  test('a duplicate relativePath rejects', async () => {
    const d = await open();
    await d.files.insertPending(pending(1));
    await expect(d.files.insertPending({ ...pending(2), relativePath: 'files/f1.png' })).rejects.toThrow();
  });

  test('markComplete and markFailed reject for an unknown id', async () => {
    const d = await open();
    await expect(d.files.markComplete(uuid(9), { sizeBytes: 1, sha256: HASH_A })).rejects.toBeInstanceOf(NotFoundError);
    await expect(d.files.markFailed(uuid(9), 'x')).rejects.toBeInstanceOf(NotFoundError);
  });

  test('meta.init rejects a second row', async () => {
    const d = await open();
    await d.meta.init(meta);
    await expect(d.meta.init({ ...meta, id: uuid(9) })).rejects.toBeInstanceOf(InvalidOperationError);
    expect(await d.meta.get()).toEqual(meta);
  });

  test('a list page and its total come from one snapshot', async () => {
    const d = await open();
    for (const n of [1, 2, 3, 4, 5]) await d.files.insertPending(pending(n, `2026-01-0${n}T00:00:00.000Z`));
    const pages = [
      await d.files.list({ limit: 2, offset: 0 }),
      await d.files.list({ limit: 2, offset: 2 }),
      await d.files.list({ limit: 2, offset: 4 }),
    ];
    expect(pages.map((p) => p.total)).toEqual([5, 5, 5]);
    expect(pages.flatMap((p) => p.items.map((f) => f.id))).toEqual([uuid(5), uuid(4), uuid(3), uuid(2), uuid(1)]);
  });

  test('enforces foreign keys on its connection', async () => {
    const d = await open();
    await expect(
      d.files.insertPending({ ...pending(1), storageId: '99999999-9999-4999-8999-999999999999' }),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  test('the primary storage is created once', async () => {
    const d = await open();
    expect(await d.storages.ensurePrimary({ id: uuid(9), createdAt: '2026-02-01T00:00:00.000Z' })).toEqual({
      id: STORAGE_ID,
      kind: 'workspace_root',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });
});
