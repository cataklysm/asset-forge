import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Asset, FileRole, ImportStatus } from '@assetforge/contracts';
import { BUILT_IN_ASSET_TYPES, type WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STORAGE_ID = uuid(1);
const TYPE_ID = uuid(2);
const PNG = 'image/png';
const BLEND = 'application/octet-stream';

let dir: string;
let db: WorkspaceDatabase;
/** The better-sqlite3 connection behind `db`. */
let handle: Database.Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-cover-'));
  // Captures the connection that openWorkspaceDatabase creates (it calls `pragma` on it first).
  const pragma = vi.spyOn(Database.prototype, 'pragma');
  try {
    db = await openWorkspaceDatabase(join(dir, 'ws.db'), MIGRATIONS_FOLDER);
    handle = pragma.mock.contexts[0] as Database.Database;
  } finally {
    pragma.mockRestore();
  }
  await db.storages.ensurePrimary({ id: STORAGE_ID, createdAt: T1 });
  await db.assetTypes.insertMissing([
    { id: TYPE_ID, key: BUILT_IN_ASSET_TYPES[0]!.key, name: 'T', sortOrder: 0, builtIn: true, defaultWorkflowTemplateId: null },
  ]);
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

async function addAsset(n: number, name: string): Promise<Asset> {
  const a: Asset = { id: uuid(n), name, typeId: TYPE_ID, description: '', status: 'draft', createdAt: T1, updatedAt: T1 };
  await db.assets.insert(a);
  return a;
}

async function addFile(f: {
  n: number;
  assetId: string | null;
  mimeType?: string;
  importedAt?: string;
  status?: ImportStatus;
  role?: FileRole;
}): Promise<string> {
  const id = uuid(f.n);
  await db.files.insertPending({
    id,
    storageId: STORAGE_ID,
    originalName: `f${f.n}`,
    relativePath: `inbox/${id}/f${f.n}`,
    mimeType: f.mimeType ?? PNG,
    importedAt: f.importedAt ?? T1,
    kind: 'image',
  });
  const status = f.status ?? 'complete';
  if (status === 'complete') await db.files.markComplete(id, { sizeBytes: 1, sha256: 'a'.repeat(64) });
  if (status === 'failed') await db.files.markFailed(id, 'Import failed');
  if (f.assetId !== null) await placeIn(id, f.assetId, f.role ?? 'reference');
  return id;
}

const placeIn = (fileId: string, assetId: string, role: FileRole) =>
  db.files.setPlacement(fileId, { relativePath: `assets/${assetId}/${role}/${fileId}`, assetId, role });

const covers = async () =>
  (await db.assets.list({ limit: 200, offset: 0 })).items.map((a) => [a.name, a.coverFileId]);

describe('asset cover repository', () => {
  test('list carries the chosen, the automatic (tie by id) or no cover', async () => {
    const chosen = await addAsset(10, 'Alpha');
    const automatic = await addAsset(11, 'Beta');
    const none = await addAsset(12, 'Gamma');
    await addFile({ n: 100, assetId: chosen.id, importedAt: T1 });
    const picked = await addFile({ n: 101, assetId: chosen.id, importedAt: T2 });
    await db.assets.setCover(chosen.id, picked, T2);
    // Equal importedAt: the smaller id wins, whatever the insertion order.
    await addFile({ n: 111, assetId: automatic.id, importedAt: T1 });
    await addFile({ n: 110, assetId: automatic.id, importedAt: T1, mimeType: 'image/jpeg' });
    await addFile({ n: 109, assetId: automatic.id, importedAt: T1, mimeType: BLEND });
    await addFile({ n: 112, assetId: automatic.id, importedAt: T2 });
    await addFile({ n: 120, assetId: none.id, mimeType: BLEND });

    await expect(covers()).resolves.toEqual([
      ['Alpha', picked],
      ['Beta', uuid(110)],
      ['Gamma', null],
    ]);
    await expect(db.assets.getCover(chosen.id)).resolves.toEqual({ coverFileId: picked, coverIsChosen: true });
    await expect(db.assets.getCover(automatic.id)).resolves.toEqual({ coverFileId: uuid(110), coverIsChosen: false });
    await expect(db.assets.getCover(none.id)).resolves.toEqual({ coverFileId: null, coverIsChosen: false });
    await expect(db.assets.get(chosen.id)).resolves.toMatchObject({ updatedAt: T2 });
  });

  test('pending and failed images are never the automatic cover', async () => {
    const a = await addAsset(10, 'Alpha');
    await addFile({ n: 100, assetId: a.id, status: 'pending' });
    await addFile({ n: 101, assetId: a.id, status: 'failed' });
    await expect(covers()).resolves.toEqual([['Alpha', null]]);
    await expect(db.assets.getCover(a.id)).resolves.toEqual({ coverFileId: null, coverIsChosen: false });
    const complete = await addFile({ n: 102, assetId: a.id, importedAt: T2 });
    await expect(db.assets.getCover(a.id)).resolves.toEqual({ coverFileId: complete, coverIsChosen: false });
  });

  test('setCover with null returns to the automatic cover', async () => {
    const a = await addAsset(10, 'Alpha');
    const first = await addFile({ n: 100, assetId: a.id, importedAt: T1 });
    const second = await addFile({ n: 101, assetId: a.id, importedAt: T2 });
    await db.assets.setCover(a.id, second, T2);
    await db.assets.setCover(a.id, null, T2);
    await expect(db.assets.getCover(a.id)).resolves.toEqual({ coverFileId: first, coverIsChosen: false });
  });

  test('getCover of an unknown asset is null', async () => {
    await expect(db.assets.getCover(uuid(999))).resolves.toBeNull();
  });

  test('setPlacement to the inbox or to another asset clears the cover', async () => {
    const a = await addAsset(10, 'Alpha');
    const b = await addAsset(11, 'Beta');
    const toInbox = await addFile({ n: 100, assetId: a.id });
    await db.assets.setCover(a.id, toInbox, T2);
    await db.files.setPlacement(toInbox, { relativePath: `inbox/${toInbox}/f100`, assetId: null, role: null });
    await expect(db.assets.getCover(a.id)).resolves.toEqual({ coverFileId: null, coverIsChosen: false });

    const toOther = await addFile({ n: 101, assetId: a.id });
    await db.assets.setCover(a.id, toOther, T2);
    await placeIn(toOther, b.id, 'reference');
    await expect(db.assets.getCover(a.id)).resolves.toEqual({ coverFileId: null, coverIsChosen: false });
    await expect(db.assets.getCover(b.id)).resolves.toEqual({ coverFileId: toOther, coverIsChosen: false });
    // Clearing is not an edit of the asset.
    await expect(db.assets.get(a.id)).resolves.toMatchObject({ updatedAt: T2 });
  });

  test('setPlacement to another role of the same asset keeps the cover', async () => {
    const a = await addAsset(10, 'Alpha');
    await addFile({ n: 100, assetId: a.id, importedAt: T1 });
    const cover = await addFile({ n: 101, assetId: a.id, importedAt: T2 });
    await db.assets.setCover(a.id, cover, T2);
    await placeIn(cover, a.id, 'texture');
    await expect(db.assets.getCover(a.id)).resolves.toEqual({ coverFileId: cover, coverIsChosen: true });
  });

  test('setPlacement of an unknown file leaves every cover alone', async () => {
    const a = await addAsset(10, 'Alpha');
    const cover = await addFile({ n: 100, assetId: a.id });
    await db.assets.setCover(a.id, cover, T2);
    await expect(placeIn(uuid(999), a.id, 'reference')).rejects.toMatchObject({ code: 'not_found' });
    await expect(db.assets.getCover(a.id)).resolves.toEqual({ coverFileId: cover, coverIsChosen: true });
  });

  test('fileMoves.commit to another asset clears the cover, within the asset keeps it', async () => {
    const a = await addAsset(10, 'Alpha');
    const b = await addAsset(11, 'Beta');
    const cover = await addFile({ n: 100, assetId: a.id });
    await db.assets.setCover(a.id, cover, T2);
    const move = (assetId: string, role: FileRole) =>
      db.fileMoves
        .begin({ fileId: cover, targetRelativePath: `assets/${assetId}/${role}/${cover}`, targetAssetId: assetId, targetRole: role, createdAt: T2 })
        .then(() => db.fileMoves.commit(cover));

    await move(a.id, 'texture');
    await expect(db.assets.getCover(a.id)).resolves.toEqual({ coverFileId: cover, coverIsChosen: true });
    await move(b.id, 'reference');
    await expect(db.assets.getCover(a.id)).resolves.toEqual({ coverFileId: null, coverIsChosen: false });
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  test('deleting the cover file row sets the cover to null through the foreign key', async () => {
    const a = await addAsset(10, 'Alpha');
    const cover = await addFile({ n: 100, assetId: a.id });
    await db.assets.setCover(a.id, cover, T2);
    expect(handle.pragma('foreign_keys', { simple: true })).toBe(1);

    handle.prepare('DELETE FROM file WHERE id = ?').run(cover);

    expect(handle.prepare('SELECT cover_file_id AS c FROM asset WHERE id = ?').get(a.id)).toEqual({ c: null });
    expect(handle.pragma('foreign_key_check')).toEqual([]);
    await expect(db.assets.getCover(a.id)).resolves.toEqual({ coverFileId: null, coverIsChosen: false });
  });

  test('list reads the covers of a page with one statement, whatever the page size', async () => {
    for (let i = 0; i < 30; i++) {
      const a = await addAsset(1000 + i, `Asset ${String(i).padStart(2, '0')}`);
      await addFile({ n: 2000 + i, assetId: a.id });
    }
    const prepare = handle.prepare.bind(handle);
    let statements = 0;
    handle.prepare = ((source: string) => {
      statements++;
      return prepare(source);
    }) as typeof handle.prepare;
    const countFor = async (limit: number) => {
      statements = 0;
      const page = await db.assets.list({ limit, offset: 0 });
      expect(page.items).toHaveLength(limit);
      expect(page.items.every((item) => item.coverFileId !== null)).toBe(true);
      return statements;
    };
    const small = await countFor(3);
    const large = await countFor(30);
    expect(large).toBe(small);
  });
});
