import { describe, expect, it } from 'vitest';
import { inboxPath, recoverIncompleteImports, stagingPath, STAGING_DIR, WorkspaceManager } from '../src/index.js';
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
    await db.files.markComplete(ID2, { sizeBytes: 1, sha256: 'a'.repeat(64) });
    storage.files.set(inboxPath(ID2, 'b.png'), Buffer.from('b'));

    const result = await recoverIncompleteImports({ storage, files: db.files });

    expect(result.failedIds).toEqual([]);
    expect(db.files.records.get(ID2)?.status).toBe('complete');
    expect(storage.files.has(inboxPath(ID2, 'b.png'))).toBe(true);
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
