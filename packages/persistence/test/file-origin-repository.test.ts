import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MAX_FILE_ORIGINS } from '@assetforge/contracts';
import type { WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';
const T3 = '2026-01-03T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STORAGE_ID = uuid(1);
const URL_A = 'https://example.org/a.png';
const URL_B = 'https://example.org/b.png';

let dir: string;
let db: WorkspaceDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-origins-'));
  db = await openWorkspaceDatabase(join(dir, 'ws.db'), MIGRATIONS_FOLDER);
  await db.storages.ensurePrimary({ id: STORAGE_ID, createdAt: T1 });
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

const pendingRow = (n: number, importedAt = T1) => ({
  id: uuid(n),
  storageId: STORAGE_ID,
  originalName: `f${n}.png`,
  relativePath: `inbox/${uuid(n)}/f${n}.png`,
  mimeType: 'image/png',
  importedAt,
  kind: 'image' as const,
});

async function addFile(
  n: number,
  status: 'pending' | 'complete' | 'failed' = 'complete',
  importedAt = T1,
): Promise<string> {
  await db.files.insertPending(pendingRow(n, importedAt));
  if (status === 'complete')
    await db.files.markComplete(uuid(n), { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
  if (status === 'failed') await db.files.markFailed(uuid(n), 'This file cannot be read');
  return uuid(n);
}

async function trash(fileId: string): Promise<void> {
  await db.fileMoves.begin({
    fileId,
    kind: 'trash',
    targetRelativePath: `.assetforge/trash/${fileId}_f.png`,
    targetAssetId: null,
    targetRole: null,
    createdAt: T2,
  });
  await db.fileMoves.commit(fileId);
}

const origin = (n: number, fileId: string, url: string, createdAt = T1) => ({ id: uuid(n), fileId, url, createdAt });

describe('file origin repository', () => {
  test('lists by created_at, then id; get answers the file', async () => {
    const f = await addFile(10);
    expect(await db.fileOrigins.insert(origin(102, f, 'https://example.org/late', T2))).toBe(true);
    expect(await db.fileOrigins.insert(origin(101, f, URL_B))).toBe(true);
    expect(await db.fileOrigins.insert(origin(100, f, URL_A))).toBe(true);
    expect(await db.fileOrigins.listByFile(f)).toEqual([
      { id: uuid(100), url: URL_A, createdAt: T1 },
      { id: uuid(101), url: URL_B, createdAt: T1 },
      { id: uuid(102), url: 'https://example.org/late', createdAt: T2 },
    ]);
    expect(await db.fileOrigins.get(uuid(101))).toEqual({ id: uuid(101), fileId: f, url: URL_B, createdAt: T1 });
    expect(await db.fileOrigins.get(uuid(999))).toBeNull();
  });

  test('a file carries a url once; another file may carry it too', async () => {
    const f = await addFile(10);
    const g = await addFile(11);
    expect(await db.fileOrigins.insert(origin(100, f, URL_A))).toBe(true);
    expect(await db.fileOrigins.insert(origin(101, f, URL_A, T2))).toBe(false);
    expect(await db.fileOrigins.listByFile(f)).toEqual([{ id: uuid(100), url: URL_A, createdAt: T1 }]);
    expect(await db.fileOrigins.insert(origin(102, g, URL_A))).toBe(true);
  });

  test(`a file takes at most ${MAX_FILE_ORIGINS} origins`, async () => {
    const f = await addFile(10);
    for (let i = 0; i < MAX_FILE_ORIGINS; i++) {
      expect(await db.fileOrigins.insert(origin(1000 + i, f, `https://example.org/${i}`))).toBe(true);
    }
    expect(await db.fileOrigins.insert(origin(2000, f, 'https://example.org/one-more'))).toBe(false);
    expect(await db.fileOrigins.get(uuid(2000))).toBeNull();
    expect(await db.fileOrigins.listByFile(f)).toHaveLength(MAX_FILE_ORIGINS);
  });

  test('knownUrls and findCompleteFileByUrl ignore pending and failed files but include a trashed complete one', async () => {
    const pending = await addFile(10, 'pending');
    const failed = await addFile(11, 'failed');
    const trashed = await addFile(12, 'complete', T2);
    const older = await addFile(13, 'complete', T1);
    await db.fileOrigins.insert(origin(100, pending, URL_A));
    await db.fileOrigins.insert(origin(101, failed, URL_A));
    await db.fileOrigins.insert(origin(102, failed, URL_B));
    await db.fileOrigins.insert(origin(103, trashed, 'https://example.org/t.png'));
    await trash(trashed);
    expect(
      await db.fileOrigins.knownUrls([URL_A, URL_B, 'https://example.org/t.png', 'https://example.org/none']),
    ).toEqual(new Set(['https://example.org/t.png']));
    expect(await db.fileOrigins.knownUrls([])).toEqual(new Set());
    expect(await db.fileOrigins.findCompleteFileByUrl(URL_A)).toBeNull();
    expect(await db.fileOrigins.findCompleteFileByUrl('https://example.org/t.png')).toBe(trashed);

    // The oldest complete file wins.
    await db.fileOrigins.insert(origin(104, trashed, URL_A, T1));
    await db.fileOrigins.insert(origin(105, older, URL_A, T3));
    expect(await db.fileOrigins.findCompleteFileByUrl(URL_A)).toBe(older);
    expect(await db.fileOrigins.knownUrls([URL_A])).toEqual(new Set([URL_A]));
  });

  test('trash and restore keep the origins; the purge removes them', async () => {
    const f = await addFile(10);
    await db.fileOrigins.insert(origin(100, f, URL_A));
    await trash(f);
    expect(await db.fileOrigins.listByFile(f)).toHaveLength(1);
    await db.fileMoves.begin({
      fileId: f,
      kind: 'restore',
      targetRelativePath: `inbox/${f}/f10.png`,
      targetAssetId: null,
      targetRole: null,
      createdAt: T3,
    });
    await db.fileMoves.commit(f);
    expect(await db.fileOrigins.listByFile(f)).toHaveLength(1);
    await trash(f);
    expect(await db.files.purge(f)).toBe(true);
    expect(await db.fileOrigins.listByFile(f)).toEqual([]);
    expect(await db.fileOrigins.get(uuid(100))).toBeNull();
  });

  test('purging a failed file removes its origins', async () => {
    const f = await addFile(10, 'failed');
    await db.fileOrigins.insert(origin(100, f, URL_A));
    expect(await db.files.purge(f)).toBe(true);
    expect(await db.fileOrigins.get(uuid(100))).toBeNull();
  });
});

describe('pending downloads', () => {
  test('insertPending with an origin writes both rows; created_at is importedAt', async () => {
    await db.files.insertPending({ ...pendingRow(10, T2), origin: { id: uuid(100), url: URL_A } });
    expect(await db.files.get(uuid(10))).toMatchObject({ status: 'pending' });
    expect(await db.fileOrigins.listByFile(uuid(10))).toEqual([{ id: uuid(100), url: URL_A, createdAt: T2 }]);
  });

  test('insertPending with an origin writes nothing when the origin cannot be stored', async () => {
    await addFile(9);
    await db.fileOrigins.insert(origin(100, uuid(9), URL_A));
    // The origin id is taken: the file row is rolled back with it.
    await expect(
      db.files.insertPending({ ...pendingRow(10), origin: { id: uuid(100), url: URL_B } }),
    ).rejects.toThrow();
    expect(await db.files.get(uuid(10))).toBeNull();
  });

  test('listPendingDownloadIds answers pending rows with an origin only', async () => {
    await db.files.insertPending({ ...pendingRow(10), origin: { id: uuid(100), url: URL_A } });
    await db.files.insertPending({ ...pendingRow(11), origin: { id: uuid(101), url: URL_B } });
    await addFile(12, 'pending');
    const done = await addFile(13);
    await db.fileOrigins.insert(origin(102, done, URL_A));
    expect((await db.files.listPendingDownloadIds()).sort()).toEqual([uuid(10), uuid(11)]);
  });

  test('deletePending removes the pending row and its origin, and answers false otherwise', async () => {
    await db.files.insertPending({ ...pendingRow(10), origin: { id: uuid(100), url: URL_A } });
    expect(await db.files.deletePending(uuid(10))).toBe(true);
    expect(await db.files.get(uuid(10))).toBeNull();
    expect(await db.fileOrigins.get(uuid(100))).toBeNull();
    expect(await db.files.deletePending(uuid(10))).toBe(false);

    const done = await addFile(11);
    await db.fileOrigins.insert(origin(101, done, URL_A));
    expect(await db.files.deletePending(done)).toBe(false);
    expect(await db.files.get(done)).toMatchObject({ status: 'complete' });
    expect(await db.fileOrigins.listByFile(done)).toHaveLength(1);
  });
});
