import { describe, expect, it } from 'vitest';
import type { FileRole, ImportStatus } from '@assetforge/contracts';
import {
  assetFilePath,
  automaticCover,
  createAsset,
  getAssetDetail,
  inboxPath,
  listAssets,
  recoverFileMoves,
  relocateFile,
  setAssetCover,
  WorkspaceManager,
  type WorkspaceSession,
} from '../src/index.js';
import { createFakeHost, type InMemoryDatabase } from './fakes.js';

const ROOT = '/ws/a';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';
const T3 = '2026-01-03T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function setup() {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const storage = fake.storages.get(ROOT)!;
  const db = fake.databases.get(summary.id)!;
  const session: WorkspaceSession = await manager.read(async (s) => s);
  const typeId = (await db.assetTypes.list())[0]!.id;
  const asset = await createAsset(session, { name: 'Pump', typeId });
  const other = await createAsset(session, { name: 'Valve', typeId });
  return { manager, storage, db, session, asset, other };
}

/** Inserts a file row with full control over status, type, time and placement; writes its bytes. */
async function addFile(
  ctx: { db: InMemoryDatabase; session: WorkspaceSession; storage: { files: Map<string, Buffer> } },
  f: {
    id: string;
    name: string;
    mimeType: string;
    importedAt: string;
    assetId?: string | null;
    role?: FileRole;
    status?: ImportStatus;
  },
) {
  const assetId = f.assetId ?? null;
  const role = assetId === null ? null : (f.role ?? 'reference');
  const relativePath = assetId === null ? inboxPath(f.id, f.name) : assetFilePath(assetId, role!, f.id, f.name);
  await ctx.db.files.insertPending({
    id: f.id,
    storageId: ctx.session.storageId,
    originalName: f.name,
    relativePath: inboxPath(f.id, f.name),
    mimeType: f.mimeType,
    importedAt: f.importedAt,
  });
  const status = f.status ?? 'complete';
  if (status === 'complete') await ctx.db.files.markComplete(f.id, { sizeBytes: 1, sha256: 'a'.repeat(64) });
  if (status === 'failed') await ctx.db.files.markFailed(f.id, 'Import failed');
  if (assetId !== null) await ctx.db.files.setPlacement(f.id, { relativePath, assetId, role });
  ctx.storage.files.set(relativePath, Buffer.from(f.name));
  return ctx.db.files.records.get(f.id)!;
}

const png = 'image/png';

describe('automaticCover', () => {
  it('automaticCover picks the earliest complete image, ties by id', () => {
    expect(
      automaticCover([
        { id: uuid(3), status: 'complete', mimeType: png, importedAt: T2 },
        { id: uuid(2), status: 'complete', mimeType: 'image/jpeg', importedAt: T1 },
        { id: uuid(1), status: 'complete', mimeType: 'application/octet-stream', importedAt: T1 },
        { id: uuid(4), status: 'complete', mimeType: png, importedAt: T1 },
      ]),
    ).toBe(uuid(2));
    expect(
      automaticCover([
        { id: uuid(9), status: 'complete', mimeType: png, importedAt: T1 },
        { id: uuid(5), status: 'complete', mimeType: 'image/webp', importedAt: T1 },
      ]),
    ).toBe(uuid(5));
    expect(automaticCover([])).toBeNull();
  });

  it('pending and failed images are never the cover', async () => {
    expect(
      automaticCover([
        { id: uuid(1), status: 'pending', mimeType: png, importedAt: T1 },
        { id: uuid(2), status: 'failed', mimeType: png, importedAt: T1 },
      ]),
    ).toBeNull();

    const ctx = await setup();
    // Placed rows that never completed: the repository does not check the status, only the use case.
    await addFile(ctx, { id: uuid(1), name: 'p.png', mimeType: png, importedAt: T1, assetId: ctx.asset.id, status: 'pending' });
    await addFile(ctx, { id: uuid(2), name: 'f.png', mimeType: png, importedAt: T1, assetId: ctx.asset.id, status: 'failed' });
    await expect(getAssetDetail(ctx.session, ctx.asset.id)).resolves.toMatchObject({ coverFileId: null, coverIsChosen: false });
    for (const fileId of [uuid(1), uuid(2)]) {
      await expect(setAssetCover(ctx.session, { assetId: ctx.asset.id, fileId })).rejects.toMatchObject({
        code: 'validation_failed',
      });
    }
    const listed = await listAssets(ctx.session, { limit: 10, offset: 0 });
    expect(listed.items.find((a) => a.id === ctx.asset.id)!.coverFileId).toBeNull();
  });
});

describe('asset cover', () => {
  it('a chosen cover wins over the automatic one', async () => {
    const ctx = await setup();
    await addFile(ctx, { id: uuid(1), name: 'a.png', mimeType: png, importedAt: T1, assetId: ctx.asset.id });
    await addFile(ctx, { id: uuid(2), name: 'b.png', mimeType: png, importedAt: T2, assetId: ctx.asset.id });
    await expect(getAssetDetail(ctx.session, ctx.asset.id)).resolves.toMatchObject({ coverFileId: uuid(1), coverIsChosen: false });

    const before = await ctx.db.assets.get(ctx.asset.id);
    const chosen = await setAssetCover(ctx.session, { assetId: ctx.asset.id, fileId: uuid(2) });
    expect(chosen).toEqual({ ...before, updatedAt: chosen.updatedAt, coverFileId: uuid(2), coverIsChosen: true });
    await expect(getAssetDetail(ctx.session, ctx.asset.id)).resolves.toEqual(chosen);
  });

  it('setAssetCover sets updatedAt to now', async () => {
    const ctx = await setup();
    await addFile(ctx, { id: uuid(1), name: 'a.png', mimeType: png, importedAt: T1, assetId: ctx.asset.id });
    const now = new Date('2030-05-05T05:05:05.000Z');
    const session: WorkspaceSession = { ...ctx.session, now: () => now };
    const chosen = await setAssetCover(session, { assetId: ctx.asset.id, fileId: uuid(1) });
    expect(chosen.updatedAt).toBe(now.toISOString());
    await expect(ctx.db.assets.get(ctx.asset.id)).resolves.toMatchObject({ updatedAt: now.toISOString() });
  });

  it('no image means no cover', async () => {
    const ctx = await setup();
    await addFile(ctx, { id: uuid(1), name: 'pump.blend', mimeType: 'application/octet-stream', importedAt: T1, assetId: ctx.asset.id });
    await expect(getAssetDetail(ctx.session, ctx.asset.id)).resolves.toMatchObject({ coverFileId: null, coverIsChosen: false });
  });

  it('getAssetDetail and setAssetCover reject an unknown asset with not_found', async () => {
    const ctx = await setup();
    await expect(getAssetDetail(ctx.session, UNKNOWN_ID)).rejects.toMatchObject({ code: 'not_found' });
    await expect(setAssetCover(ctx.session, { assetId: UNKNOWN_ID, fileId: null })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('setAssetCover rejects files of another asset, inbox files and non-images', async () => {
    const ctx = await setup();
    await addFile(ctx, { id: uuid(1), name: 'other.png', mimeType: png, importedAt: T1, assetId: ctx.other.id });
    await addFile(ctx, { id: uuid(2), name: 'inbox.png', mimeType: png, importedAt: T1 });
    await addFile(ctx, { id: uuid(3), name: 'pump.blend', mimeType: 'application/octet-stream', importedAt: T1, assetId: ctx.asset.id });
    const before = await ctx.db.assets.get(ctx.asset.id);
    for (const fileId of [uuid(1), uuid(2), uuid(3), UNKNOWN_ID]) {
      await expect(setAssetCover(ctx.session, { assetId: ctx.asset.id, fileId })).rejects.toMatchObject({
        code: 'validation_failed',
      });
    }
    await expect(ctx.db.assets.get(ctx.asset.id)).resolves.toEqual(before);
    await expect(getAssetDetail(ctx.session, ctx.asset.id)).resolves.toMatchObject({ coverFileId: null, coverIsChosen: false });
  });

  it('setAssetCover with null returns to the automatic cover', async () => {
    const ctx = await setup();
    await addFile(ctx, { id: uuid(1), name: 'a.png', mimeType: png, importedAt: T1, assetId: ctx.asset.id });
    await addFile(ctx, { id: uuid(2), name: 'b.png', mimeType: png, importedAt: T2, assetId: ctx.asset.id });
    await setAssetCover(ctx.session, { assetId: ctx.asset.id, fileId: uuid(2) });
    const reset = await setAssetCover(ctx.session, { assetId: ctx.asset.id, fileId: null });
    expect(reset).toMatchObject({ coverFileId: uuid(1), coverIsChosen: false });
  });

  it('detaching the cover file clears the choice', async () => {
    const ctx = await setup();
    await addFile(ctx, { id: uuid(1), name: 'a.png', mimeType: png, importedAt: T1, assetId: ctx.asset.id });
    await addFile(ctx, { id: uuid(2), name: 'b.png', mimeType: png, importedAt: T2, assetId: ctx.asset.id });
    const chosen = await setAssetCover(ctx.session, { assetId: ctx.asset.id, fileId: uuid(2) });
    await relocateFile(ctx.session, uuid(2), null);
    const detail = await getAssetDetail(ctx.session, ctx.asset.id);
    expect(detail).toMatchObject({ coverFileId: uuid(1), coverIsChosen: false });
    // Clearing is a side effect of the move, not an edit of the asset.
    expect(detail.updatedAt).toBe(chosen.updatedAt);
  });

  it('moving the cover file to another asset clears the choice', async () => {
    const ctx = await setup();
    await addFile(ctx, { id: uuid(1), name: 'a.png', mimeType: png, importedAt: T1, assetId: ctx.asset.id });
    await setAssetCover(ctx.session, { assetId: ctx.asset.id, fileId: uuid(1) });
    await relocateFile(ctx.session, uuid(1), { assetId: ctx.other.id, role: 'reference' });
    await expect(getAssetDetail(ctx.session, ctx.asset.id)).resolves.toMatchObject({ coverFileId: null, coverIsChosen: false });
    await expect(getAssetDetail(ctx.session, ctx.other.id)).resolves.toMatchObject({ coverFileId: uuid(1), coverIsChosen: false });
  });

  it('a role change within the asset keeps the cover', async () => {
    const ctx = await setup();
    await addFile(ctx, { id: uuid(1), name: 'a.png', mimeType: png, importedAt: T1, assetId: ctx.asset.id });
    await addFile(ctx, { id: uuid(2), name: 'b.png', mimeType: png, importedAt: T2, assetId: ctx.asset.id });
    await setAssetCover(ctx.session, { assetId: ctx.asset.id, fileId: uuid(2) });
    // `concept` shares the directory of `reference` (row update only), `texture` moves the file.
    for (const role of ['concept', 'texture'] as const) {
      await relocateFile(ctx.session, uuid(2), { assetId: ctx.asset.id, role });
      await expect(getAssetDetail(ctx.session, ctx.asset.id)).resolves.toMatchObject({
        coverFileId: uuid(2),
        coverIsChosen: true,
      });
    }
  });

  it('repairing a committed move on open clears the choice', async () => {
    const ctx = await setup();
    const file = await addFile(ctx, { id: uuid(1), name: 'a.png', mimeType: png, importedAt: T1, assetId: ctx.asset.id });
    await setAssetCover(ctx.session, { assetId: ctx.asset.id, fileId: uuid(1) });
    const target = assetFilePath(ctx.other.id, 'reference', file.id, 'a.png');
    await ctx.db.fileMoves.begin({
      fileId: file.id,
      targetRelativePath: target,
      targetAssetId: ctx.other.id,
      targetRole: 'reference',
      createdAt: T3,
    });
    await ctx.storage.move(file.relativePath, target);
    const result = await recoverFileMoves({ storage: ctx.storage, files: ctx.db.files, fileMoves: ctx.db.fileMoves });
    expect(result.completed).toEqual([file.id]);
    await expect(getAssetDetail(ctx.session, ctx.asset.id)).resolves.toMatchObject({ coverFileId: null, coverIsChosen: false });
  });

  it('listAssets carries the effective cover of each asset', async () => {
    const ctx = await setup();
    const third = await createAsset(ctx.session, { name: 'Zeppelin', typeId: ctx.asset.typeId });
    await addFile(ctx, { id: uuid(1), name: 'a.png', mimeType: png, importedAt: T1, assetId: ctx.asset.id });
    await addFile(ctx, { id: uuid(2), name: 'b.png', mimeType: png, importedAt: T2, assetId: ctx.asset.id });
    await addFile(ctx, { id: uuid(4), name: 'd.png', mimeType: png, importedAt: T1, assetId: ctx.other.id });
    await addFile(ctx, { id: uuid(3), name: 'c.png', mimeType: png, importedAt: T1, assetId: ctx.other.id });
    await addFile(ctx, { id: uuid(5), name: 'z.blend', mimeType: 'application/octet-stream', importedAt: T1, assetId: third.id });
    await setAssetCover(ctx.session, { assetId: ctx.asset.id, fileId: uuid(2) });

    const listed = await listAssets(ctx.session, { limit: 10, offset: 0 });
    expect(listed.items.map((a) => [a.name, a.coverFileId])).toEqual([
      ['Pump', uuid(2)],
      ['Valve', uuid(3)],
      ['Zeppelin', null],
    ]);
  });
});
