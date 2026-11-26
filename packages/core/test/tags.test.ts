import { describe, expect, it, vi } from 'vitest';
import {
  addAssetTag,
  addFileTag,
  addFileTags,
  createAsset,
  getAssetDetail,
  importFile,
  inboxPath,
  NotFoundError,
  removeAssetTag,
  removeFileTag,
  removeFileTags,
  ValidationFailedError,
  suggestTags,
  tagName,
  WorkspaceManager,
  type ImportContext,
  type WorkspaceSession,
} from '../src/index.js';
import { createFakeHost, type InMemoryDatabase } from './fakes.js';

const ROOT = '/ws/a';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
const T1 = '2026-01-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function setup() {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const db = fake.databases.get(summary.id)!;
  const session: WorkspaceSession = await manager.read(async (s) => s);
  const typeId = (await db.assetTypes.list())[0]!.id;
  const asset = await createAsset(session, { name: 'Pump', typeId });
  const other = await createAsset(session, { name: 'Valve', typeId });
  return { fake, manager, db, session, asset, other };
}

async function addFile(
  ctx: { db: InMemoryDatabase; session: WorkspaceSession },
  n: number,
  status: 'pending' | 'complete' | 'failed' = 'complete',
) {
  const name = `f${n}.png`;
  await ctx.db.files.insertPending({
    id: uuid(n),
    storageId: ctx.session.storageId,
    originalName: name,
    relativePath: inboxPath(uuid(n), name),
    mimeType: 'image/png',
    importedAt: T1,
    kind: 'image',
  });
  if (status === 'complete') await ctx.db.files.markComplete(uuid(n), { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
  if (status === 'failed') await ctx.db.files.markFailed(uuid(n), 'Import failed');
  return uuid(n);
}

describe('tagName', () => {
  it('keeps the display spelling and lower-cases the key', () => {
    expect(tagName('  Sci   Fi ')).toEqual({ name: 'sci fi', displayName: 'Sci Fi' });
  });

  it('an empty or too long tag fails with validation_failed', () => {
    expect(() => tagName('   ')).toThrow(expect.objectContaining({ code: 'validation_failed' }));
    expect(() => tagName('x'.repeat(65))).toThrow(expect.objectContaining({ code: 'validation_failed' }));
  });

  it('a tag without a letter or digit fails with validation_failed', () => {
    expect(() => tagName('!!!')).toThrow(expect.objectContaining({ code: 'validation_failed' }));
  });
});

describe('asset tags', () => {
  it('adding a tag twice is a no-op and keeps the first display name', async () => {
    const { session, asset } = await setup();
    await addAssetTag(session, { assetId: asset.id, name: 'Sci Fi' });
    const detail = await addAssetTag(session, { assetId: asset.id, name: 'sci fi' });
    expect(detail.tags).toEqual([{ name: 'sci fi', displayName: 'Sci Fi', origin: 'manual' }]);
  });

  it('removing a missing tag is a no-op', async () => {
    const { session, asset } = await setup();
    const detail = await removeAssetTag(session, { assetId: asset.id, name: 'nothing' });
    expect(detail.tags).toEqual([]);
    await addAssetTag(session, { assetId: asset.id, name: 'a' });
    expect((await removeAssetTag(session, { assetId: asset.id, name: 'b' })).tags).toHaveLength(1);
    expect((await removeAssetTag(session, { assetId: asset.id, name: 'A' })).tags).toEqual([]);
  });

  it('an empty or too long tag fails with validation_failed', async () => {
    const { session, asset } = await setup();
    await expect(addAssetTag(session, { assetId: asset.id, name: '  ' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(addAssetTag(session, { assetId: asset.id, name: 'x'.repeat(65) })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(removeAssetTag(session, { assetId: asset.id, name: '' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(addAssetTag(session, { assetId: asset.id, name: '!!!' })).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('tagging an unknown asset or file fails with not_found', async () => {
    const { session } = await setup();
    await expect(addAssetTag(session, { assetId: UNKNOWN_ID, name: 'a' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(removeAssetTag(session, { assetId: UNKNOWN_ID, name: 'a' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(addFileTag(session, { fileId: UNKNOWN_ID, name: 'a' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(removeFileTag(session, { fileId: UNKNOWN_ID, name: 'a' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('file tags', () => {
  it('tagging a pending or failed file fails with validation_failed', async () => {
    const ctx = await setup();
    const pending = await addFile(ctx, 1, 'pending');
    const failed = await addFile(ctx, 2, 'failed');
    await expect(addFileTag(ctx.session, { fileId: pending, name: 'a' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(addFileTag(ctx.session, { fileId: failed, name: 'a' })).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('adds and removes a tag on a complete file', async () => {
    const ctx = await setup();
    const id = await addFile(ctx, 1);
    const tagged = await addFileTag(ctx.session, { fileId: id, name: 'Hero' });
    expect(tagged.tags).toEqual([{ name: 'hero', displayName: 'Hero', origin: 'manual' }]);
    expect((await removeFileTag(ctx.session, { fileId: id, name: 'hero' })).tags).toEqual([]);
  });
});

describe('file tag batches', () => {
  it('addFileTags is all or nothing', async () => {
    const ctx = await setup();
    const a = await addFile(ctx, 1);
    const b = await addFile(ctx, 2);
    const pending = await addFile(ctx, 3, 'pending');
    const missing = UNKNOWN_ID;
    const getFile = async (id: string) => (await ctx.session.database.files.get(id))!;

    await expect(addFileTags(ctx.session, { fileIds: [a, pending], name: 'Oak' })).rejects.toBeInstanceOf(ValidationFailedError);
    expect((await getFile(a)).tags).toEqual([]);
    await expect(addFileTags(ctx.session, { fileIds: [a, missing], name: 'Oak' })).rejects.toBeInstanceOf(NotFoundError);
    expect((await getFile(a)).tags).toEqual([]);
    const records = await addFileTags(ctx.session, { fileIds: [b, a], name: 'Oak' });
    expect(records.map((r) => r.id)).toEqual([b, a]);
    expect(records.every((r) => r.tags.some((t) => t.name === 'oak' && t.displayName === 'Oak' && t.origin === 'manual'))).toBe(true);
    expect((await getFile(a)).tags).toEqual([{ name: 'oak', displayName: 'Oak', origin: 'manual' }]);
  });

  it('removeFileTags removes from all and ignores files without the tag', async () => {
    const ctx = await setup();
    const a = await addFile(ctx, 1);
    const b = await addFile(ctx, 2);
    const c = await addFile(ctx, 3);
    await addFileTags(ctx.session, { fileIds: [a, b], name: 'Oak' });
    await ctx.db.tags.addToFile({ fileId: a, name: 'oak', displayName: 'oak', origin: 'ai', newId: uuid(900), now: T1 });

    const records = await removeFileTags(ctx.session, { fileIds: [c, a, b], name: 'OAK' });
    expect(records.map((r) => r.id)).toEqual([c, a, b]);
    // Only the manual assignment goes; the AI one stays distinguishable and untouched.
    expect(records.map((r) => r.tags)).toEqual([[], [{ name: 'oak', displayName: 'Oak', origin: 'ai' }], []]);
  });

  it('removeFileTags is all or nothing', async () => {
    const ctx = await setup();
    const a = await addFile(ctx, 1);
    const pending = await addFile(ctx, 2, 'pending');
    await addFileTags(ctx.session, { fileIds: [a], name: 'Oak' });
    await expect(removeFileTags(ctx.session, { fileIds: [a, pending], name: 'oak' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(removeFileTags(ctx.session, { fileIds: [a, UNKNOWN_ID], name: 'oak' })).rejects.toBeInstanceOf(NotFoundError);
    expect((await ctx.session.database.files.get(a))!.tags).toHaveLength(1);
  });

  it('an invalid tag name fails with validation_failed before any lookup', async () => {
    const ctx = await setup();
    const get = vi.spyOn(ctx.db.files, 'get');
    const add = vi.spyOn(ctx.db.tags, 'addToFiles');
    const remove = vi.spyOn(ctx.db.tags, 'removeFromFiles');
    await expect(addFileTags(ctx.session, { fileIds: [UNKNOWN_ID], name: '  ' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(removeFileTags(ctx.session, { fileIds: [UNKNOWN_ID], name: 'x'.repeat(65) })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(get).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('suggestTags', () => {
  it('suggestions offer only tags in use, by prefix, most used first', async () => {
    const ctx = await setup();
    const { session, asset, other } = ctx;
    const file = await addFile(ctx, 1);
    await addAssetTag(session, { assetId: asset.id, name: 'Sci Fi' });
    await addAssetTag(session, { assetId: other.id, name: 'sci fi' });
    await addFileTag(session, { fileId: file, name: 'scenic' });
    await addAssetTag(session, { assetId: asset.id, name: 'gone' });
    await removeAssetTag(session, { assetId: asset.id, name: 'gone' });
    await addAssetTag(session, { assetId: asset.id, name: 'other' });

    expect(await suggestTags(session, { prefix: 'SC', limit: 10 })).toEqual([
      { name: 'sci fi', displayName: 'Sci Fi' },
      { name: 'scenic', displayName: 'scenic' },
    ]);
    expect(await suggestTags(session, { prefix: 'go', limit: 10 })).toEqual([]);
    expect(await suggestTags(session, { prefix: 'sc', limit: 1 })).toHaveLength(1);
    expect((await suggestTags(session, { prefix: '', limit: 10 })).map((t) => t.name)).toEqual(['sci fi', 'other', 'scenic']);
  });
});

describe('records', () => {
  it('asset detail carries asset tags only, file records carry file tags', async () => {
    const ctx = await setup();
    const { session, asset } = ctx;
    const file = await addFile(ctx, 1);
    await addAssetTag(session, { assetId: asset.id, name: 'shared' });
    await addFileTag(session, { fileId: file, name: 'shared' });
    await addFileTag(session, { fileId: file, name: 'only file' });

    const detail = await getAssetDetail(session, asset.id);
    expect(detail.tags).toEqual([{ name: 'shared', displayName: 'shared', origin: 'manual' }]);
    const record = (await session.database.files.get(file))!;
    expect(record.tags).toEqual([
      { name: 'only file', displayName: 'only file', origin: 'manual' },
      { name: 'shared', displayName: 'shared', origin: 'manual' },
    ]);
  });

  it('import stores the file kind', async () => {
    const { fake, db, session } = await setup();
    fake.sources.set('/src/scene.blend', Buffer.from('b'));
    fake.sources.set('/src/ref.png', Buffer.from('p'));
    const ctx: ImportContext = {
      storage: session.storage,
      storageId: session.storageId,
      files: db.files,
      sources: fake.sources,
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    };
    const blend = (await importFile(ctx, '/src/scene.blend')).file!;
    const png = (await importFile(ctx, '/src/ref.png')).file!;
    expect(blend.kind).toBe('model');
    expect(blend.tags).toEqual([]);
    expect(png.kind).toBe('image');
    expect((await db.files.get(blend.id))!.kind).toBe('model');
  });
});
