import { describe, expect, it } from 'vitest';
import {
  inboxPath,
  recoverFileMoves,
  recoverIncompleteImports,
  stagingPath,
  STAGING_DIR,
  trashPath,
  WorkspaceManager,
} from '../src/index.js';
import { createFakeHost } from './fakes.js';

const ROOT = '/ws/a';
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const STORAGE_ID = '44444444-4444-4444-8444-444444444444';

async function setup() {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const storage = fake.storages.get(ROOT)!;
  const db = fake.databases.get(summary.id)!;
  return { ...fake, manager, summary, storage, db };
}

const pending = (id: string, name: string) => ({
  id,
  storageId: STORAGE_ID,
  originalName: name,
  relativePath: inboxPath(id, name),
  mimeType: 'image/png',
  importedAt: '2026-01-01T00:00:00.000Z',
  kind: 'image' as const,
});

const TS = '2026-01-02T00:00:00.000Z';
const trashMove = (id: string, name: string) => ({
  fileId: id,
  kind: 'trash' as const,
  targetRelativePath: trashPath(id, name),
  targetAssetId: null,
  targetRole: null,
  createdAt: TS,
});

async function complete(db: Awaited<ReturnType<typeof setup>>['db'], id: string, name: string) {
  await db.files.insertPending(pending(id, name));
  await db.files.markComplete(id, { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
}

describe('recoverFileMoves for the trash', () => {
  it('an interrupted trash move is committed when the binary already moved', async () => {
    const { storage, db } = await setup();
    await complete(db, ID1, 'a.png');
    await db.fileMoves.begin(trashMove(ID1, 'a.png'));
    storage.files.set(trashPath(ID1, 'a.png'), Buffer.from('a'));

    const result = await recoverFileMoves({ storage, files: db.files, fileMoves: db.fileMoves });

    expect(result.completed).toEqual([ID1]);
    expect(db.files.records.get(ID1)).toMatchObject({ relativePath: trashPath(ID1, 'a.png'), deletedAt: TS, assetId: null, role: null });
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('an interrupted trash move is aborted when it did not', async () => {
    const { storage, db } = await setup();
    await complete(db, ID1, 'a.png');
    await db.fileMoves.begin(trashMove(ID1, 'a.png'));
    storage.files.set(inboxPath(ID1, 'a.png'), Buffer.from('a'));

    const result = await recoverFileMoves({ storage, files: db.files, fileMoves: db.fileMoves });

    expect(result.discarded).toEqual([ID1]);
    expect(db.files.records.get(ID1)).toMatchObject({ relativePath: inboxPath(ID1, 'a.png'), deletedAt: null });
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  const trashed = async () => {
    const ctx = await setup();
    const { storage, db } = ctx;
    await complete(db, ID1, 'a.png');
    await db.fileMoves.begin(trashMove(ID1, 'a.png'));
    await db.fileMoves.commit(ID1);
    await db.fileMoves.begin({ ...trashMove(ID1, 'a.png'), kind: 'restore', targetRelativePath: inboxPath(ID1, 'a.png') });
    return { storage, db };
  };

  it('an interrupted restore move is committed when the binary already moved', async () => {
    const { storage, db } = await trashed();
    storage.files.set(inboxPath(ID1, 'a.png'), Buffer.from('a'));

    const result = await recoverFileMoves({ storage, files: db.files, fileMoves: db.fileMoves });

    expect(result.completed).toEqual([ID1]);
    expect(db.files.records.get(ID1)).toMatchObject({ relativePath: inboxPath(ID1, 'a.png'), deletedAt: null, trashedAssetId: null });
  });

  it('an interrupted restore move is aborted when it did not', async () => {
    const { storage, db } = await trashed();
    storage.files.set(trashPath(ID1, 'a.png'), Buffer.from('a'));

    const result = await recoverFileMoves({ storage, files: db.files, fileMoves: db.fileMoves });

    expect(result.discarded).toEqual([ID1]);
    expect(db.files.records.get(ID1)).toMatchObject({ relativePath: trashPath(ID1, 'a.png'), deletedAt: TS });
  });
});

describe('recoverIncompleteImports', () => {
  it('fails a pending row and removes its staging file', async () => {
    const { storage, db } = await setup();
    await db.files.insertPending(pending(ID1, 'a.png'));
    storage.files.set(stagingPath(ID1), Buffer.from('partial'));

    const result = await recoverIncompleteImports({ storage, files: db.files });

    expect(result.failedIds).toEqual([ID1]);
    expect(result.removedStagingFiles).toContain(stagingPath(ID1));
    expect(db.files.records.get(ID1)).toMatchObject({ status: 'failed', error: 'Import was interrupted' });
    expect(storage.files.has(stagingPath(ID1))).toBe(false);
  });

  it('removes the inbox file of a pending row (crash between move and complete)', async () => {
    const { storage, db } = await setup();
    await db.files.insertPending(pending(ID1, 'a.png'));
    storage.files.set(inboxPath(ID1, 'a.png'), Buffer.from('moved'));

    await recoverIncompleteImports({ storage, files: db.files });

    expect(db.files.records.get(ID1)?.status).toBe('failed');
    expect(storage.files.has(inboxPath(ID1, 'a.png'))).toBe(false);
  });

  it('removes orphan staging files without a row', async () => {
    const { storage, db } = await setup();
    storage.files.set(stagingPath(ID3), Buffer.from('orphan'));

    const result = await recoverIncompleteImports({ storage, files: db.files });

    expect(result.failedIds).toEqual([]);
    expect(result.removedStagingFiles).toContain(stagingPath(ID3));
    expect(await storage.list(STAGING_DIR)).toEqual([]);
  });

  it('leaves complete rows and their files untouched', async () => {
    const { storage, db } = await setup();
    await db.files.insertPending(pending(ID2, 'b.png'));
    await db.files.markComplete(ID2, { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
    storage.files.set(inboxPath(ID2, 'b.png'), Buffer.from('b'));

    const result = await recoverIncompleteImports({ storage, files: db.files });

    expect(result.failedIds).toEqual([]);
    expect(db.files.records.get(ID2)?.status).toBe('complete');
    expect(storage.files.has(inboxPath(ID2, 'b.png'))).toBe(true);
  });
});

describe('recoverIncompleteImports of downloads', () => {
  const ORIGIN = '55555555-5555-4555-8555-555555555555';

  it('deletes a pending row with an origin, with its staged and inbox bytes, and lists it as discarded', async () => {
    const { storage, db } = await setup();
    await db.files.insertPending({ ...pending(ID1, 'a.png'), origin: { id: ORIGIN, url: 'https://a.example/a.png' } });
    storage.files.set(stagingPath(ID1), Buffer.from('partial'));
    storage.files.set(inboxPath(ID1, 'a.png'), Buffer.from('moved'));

    const result = await recoverIncompleteImports({ storage, files: db.files });

    expect(result.discardedIds).toEqual([ID1]);
    expect(result.failedIds).toEqual([]);
    expect(db.files.records.has(ID1)).toBe(false);
    expect(db.fileOrigins.rows.size).toBe(0);
    expect(storage.files.has(stagingPath(ID1))).toBe(false);
    expect(storage.files.has(inboxPath(ID1, 'a.png'))).toBe(false);
  });

  it('still marks a pending row without an origin failed', async () => {
    const { storage, db } = await setup();
    await db.files.insertPending({ ...pending(ID1, 'a.png'), origin: { id: ORIGIN, url: 'https://a.example/a.png' } });
    await db.files.insertPending(pending(ID2, 'b.png'));

    const result = await recoverIncompleteImports({ storage, files: db.files });

    expect(result.discardedIds).toEqual([ID1]);
    expect(result.failedIds).toEqual([ID2]);
    expect(db.files.records.get(ID2)?.status).toBe('failed');
  });

  it('keeps a download row pending when its bytes cannot be removed', async () => {
    const { storage, db } = await setup();
    await db.files.insertPending({ ...pending(ID1, 'a.png'), origin: { id: ORIGIN, url: 'https://a.example/a.png' } });
    storage.failNext('remove', new Error('EBUSY'));

    const result = await recoverIncompleteImports({ storage, files: db.files });

    expect(result.discardedIds).toEqual([]);
    expect(result.skippedPaths).toEqual([stagingPath(ID1)]);
    expect(db.files.records.get(ID1)?.status).toBe('pending');
  });
});

describe('recoverIncompleteImports best-effort', () => {
  it('keeps a row pending and reports the path when its removal fails, and continues', async () => {
    const { storage, db } = await setup();
    await db.files.insertPending(pending(ID1, 'a.png'));
    await db.files.insertPending(pending(ID2, 'b.png'));
    storage.files.set(stagingPath(ID1), Buffer.from('p1'));
    storage.files.set(stagingPath(ID2), Buffer.from('p2'));
    storage.failNext('remove', new Error('EBUSY'));

    const result = await recoverIncompleteImports({ storage, files: db.files });

    expect(result.skippedPaths).toEqual([stagingPath(ID1)]);
    expect(result.failedIds).toEqual([ID2]);
    expect(db.files.records.get(ID1)?.status).toBe('pending');
    expect(db.files.records.get(ID2)?.status).toBe('failed');
    expect(storage.files.has(stagingPath(ID2))).toBe(false);
  });

  it('keeps a row pending when markFailed throws', async () => {
    const { storage, db } = await setup();
    await db.files.insertPending(pending(ID1, 'a.png'));
    const files = Object.create(db.files) as typeof db.files;
    files.markFailed = async () => {
      throw new Error('db gone');
    };

    const result = await recoverIncompleteImports({ storage, files });

    expect(result.failedIds).toEqual([]);
    expect(db.files.records.get(ID1)?.status).toBe('pending');
  });

  it('reports an orphan staging entry that cannot be removed', async () => {
    const { storage, db } = await setup();
    storage.files.set(stagingPath(ID3), Buffer.from('orphan'));
    storage.failNext('remove', new Error('EBUSY'));

    const result = await recoverIncompleteImports({ storage, files: db.files });

    expect(result.skippedPaths).toEqual([stagingPath(ID3)]);
    expect(result.removedStagingFiles).toEqual([]);
  });

  it('leaves the pending rows for the next open when the download ids cannot be listed', async () => {
    const { storage, db } = await setup();
    await db.files.insertPending({ ...pending(ID1, 'a.png'), origin: { id: '55555555-5555-4555-8555-555555555555', url: 'https://a.example/a.png' } });
    const files = Object.create(db.files) as typeof db.files;
    files.listPendingDownloadIds = async () => {
      throw new Error('db gone');
    };

    const result = await recoverIncompleteImports({ storage, files });

    expect(result.discardedIds).toEqual([]);
    expect(result.failedIds).toEqual([]);
    expect(db.files.records.get(ID1)?.status).toBe('pending');
  });

  it('does not throw when listing fails', async () => {
    const { storage, db } = await setup();
    storage.failNext('list', new Error('EIO'));
    await expect(recoverIncompleteImports({ storage, files: db.files })).resolves.toMatchObject({ failedIds: [] });
  });
});

describe('recovery on open', () => {
  it('still opens when a removal fails during recovery', async () => {
    const { manager, storage, db } = await setup();
    await db.files.insertPending(pending(ID1, 'a.png'));
    storage.files.set(stagingPath(ID1), Buffer.from('partial'));
    await manager.close();
    storage.failNext('remove', new Error('EBUSY'));

    await expect(manager.open({ rootPath: ROOT })).resolves.toMatchObject({ rootPath: ROOT });
    expect(db.files.records.get(ID1)?.status).toBe('pending');
  });

  it('opening a workspace sweeps the trash after recovering moves', async () => {
    const { manager, storage, db } = await setup();
    // A complete inbox file whose trash move was interrupted after the binary moved.
    await db.files.insertPending(pending(ID1, 'a.png'));
    await db.files.markComplete(ID1, { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
    await db.fileMoves.begin({ ...trashMove(ID1, 'a.png') });
    storage.files.set(trashPath(ID1, 'a.png'), Buffer.from('a'));
    // A purge whose binary removal did not happen: the row is gone, its tombstone is there.
    const orphan = trashPath(ID3, 'gone.png');
    storage.files.set(orphan, Buffer.from('orphan'));
    db.files.purged.add(ID3);
    await manager.close();

    await manager.open({ rootPath: ROOT });

    expect(db.files.records.get(ID1)).toMatchObject({ relativePath: trashPath(ID1, 'a.png') });
    expect(db.files.records.get(ID1)!.deletedAt).not.toBeNull();
    expect(storage.files.has(trashPath(ID1, 'a.png'))).toBe(true);
    expect(storage.files.has(orphan)).toBe(false);
    await expect(db.files.listPurgedIds()).resolves.toEqual([]);
  });

  it('a crash between the row deletion and the binary removal is cleaned up by the sweep on open', async () => {
    const { manager, storage, db } = await setup();
    await complete(db, ID1, 'a.png');
    await db.fileMoves.begin(trashMove(ID1, 'a.png'));
    await db.fileMoves.commit(ID1);
    storage.files.set(trashPath(ID1, 'a.png'), Buffer.from('a'));
    // The purge transaction committed; the process died before the binary was removed.
    await db.files.purge(ID1);
    await manager.close();

    await manager.open({ rootPath: ROOT });

    expect(storage.files.has(trashPath(ID1, 'a.png'))).toBe(false);
    await expect(db.files.listPurgedIds()).resolves.toEqual([]);
  });

  it('does not sweep the trash when the database is new (a kept folder opened again)', async () => {
    const { manager, storage, db, summary, databases } = await setup();
    await complete(db, ID1, 'a.png');
    await db.fileMoves.begin(trashMove(ID1, 'a.png'));
    await db.fileMoves.commit(ID1);
    storage.files.set(trashPath(ID1, 'a.png'), Buffer.from('a'));

    await manager.remove({ id: summary.id, trashFolder: false });
    expect(databases.has(summary.id)).toBe(false);
    await manager.open({ rootPath: ROOT });

    expect(databases.get(summary.id)!.files.records.size).toBe(0);
    expect(storage.files.has(trashPath(ID1, 'a.png'))).toBe(true);
  });

  it('a trashed binary survives two opens with a recreated database', async () => {
    const { manager, storage, db, summary } = await setup();
    await complete(db, ID1, 'a.png');
    await db.fileMoves.begin(trashMove(ID1, 'a.png'));
    await db.fileMoves.commit(ID1);
    storage.files.set(trashPath(ID1, 'a.png'), Buffer.from('a'));

    await manager.remove({ id: summary.id, trashFolder: false });
    await manager.open({ rootPath: ROOT });
    expect(storage.files.has(trashPath(ID1, 'a.png'))).toBe(true);
    await manager.close();
    await manager.open({ rootPath: ROOT });

    expect(storage.files.has(trashPath(ID1, 'a.png'))).toBe(true);
  });

  it('still opens when the trash sweep fails', async () => {
    const { manager, storage, db } = await setup();
    storage.files.set(trashPath(ID3, 'gone.png'), Buffer.from('orphan'));
    db.files.purged.add(ID3);
    await manager.close();
    storage.failNext('remove', new Error('EBUSY'));
    await expect(manager.open({ rootPath: ROOT })).resolves.toMatchObject({ rootPath: ROOT });
  });

  it('cleans up an interrupted import when the workspace is reopened', async () => {
    const { manager, storage, db } = await setup();
    await db.files.insertPending(pending(ID1, 'a.png'));
    storage.files.set(stagingPath(ID1), Buffer.from('partial'));
    await manager.close();

    await manager.open({ rootPath: ROOT });

    const list = await manager.listFiles({ limit: 10, offset: 0, scope: { kind: 'all' } });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: ID1, status: 'failed', error: 'Import was interrupted' });
    expect(await storage.list(STAGING_DIR)).toEqual([]);
  });
});
