import { describe, expect, it, vi } from 'vitest';
import {
  addAssetTag,
  addFileTag,
  addFileTags,
  createAsset,
  getAssetDetail,
  importFile,
  inboxPath,
  InvalidOperationError,
  NotFoundError,
  removeAssetTag,
  removeFileTag,
  removeFileTags,
  renameTag,
  ValidationFailedError,
  suggestTags,
  tagName,
  tagUsage,
  WorkspaceManager,
  type ImportContext,
  type WorkspaceSession,
} from '../src/index.js';
import { createFakeHost, trashForTest, type InMemoryDatabase } from './fakes.js';

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
  if (status === 'complete')
    await ctx.db.files.markComplete(uuid(n), { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
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
    await expect(addAssetTag(session, { assetId: asset.id, name: '  ' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(addAssetTag(session, { assetId: asset.id, name: 'x'.repeat(65) })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(removeAssetTag(session, { assetId: asset.id, name: '' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(addAssetTag(session, { assetId: asset.id, name: '!!!' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('tagging an unknown asset or file fails with not_found', async () => {
    const { session } = await setup();
    await expect(addAssetTag(session, { assetId: UNKNOWN_ID, name: 'a' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(removeAssetTag(session, { assetId: UNKNOWN_ID, name: 'a' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(addFileTag(session, { fileId: UNKNOWN_ID, name: 'a' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(removeFileTag(session, { fileId: UNKNOWN_ID, name: 'a' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('file tags', () => {
  it('tagging a pending or failed file fails with validation_failed', async () => {
    const ctx = await setup();
    const pending = await addFile(ctx, 1, 'pending');
    const failed = await addFile(ctx, 2, 'failed');
    await expect(addFileTag(ctx.session, { fileId: pending, name: 'a' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(addFileTag(ctx.session, { fileId: failed, name: 'a' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('adds and removes a tag on a complete file', async () => {
    const ctx = await setup();
    const id = await addFile(ctx, 1);
    const tagged = await addFileTag(ctx.session, { fileId: id, name: 'Hero' });
    expect(tagged.tags).toEqual([{ name: 'hero', displayName: 'Hero', origin: 'manual' }]);
    expect((await removeFileTag(ctx.session, { fileId: id, name: 'hero' })).tags).toEqual([]);
  });
});

describe('manual wins', () => {
  it('adding by hand over an ai tag leaves one manual assignment', async () => {
    const ctx = await setup();
    const a = await addFile(ctx, 1);
    const b = await addFile(ctx, 2);
    await ctx.db.tags.addToFile({
      fileId: a,
      name: 'oak',
      displayName: 'Oak',
      origin: 'ai',
      newId: uuid(900),
      now: T1,
    });
    expect((await addFileTag(ctx.session, { fileId: a, name: 'Oak' })).tags).toEqual([
      { name: 'oak', displayName: 'Oak', origin: 'manual' },
    ]);
    await ctx.db.tags.addToFile({
      fileId: a,
      name: 'oak',
      displayName: 'Oak',
      origin: 'ai',
      newId: uuid(901),
      now: T1,
    });
    expect((await ctx.session.database.files.get(a))!.tags.map((t) => t.origin)).toEqual(['manual']);

    await ctx.db.tags.addToFile({
      fileId: b,
      name: 'oak',
      displayName: 'Oak',
      origin: 'ai',
      newId: uuid(902),
      now: T1,
    });
    const records = await addFileTags(ctx.session, { fileIds: [a, b], name: 'Oak' });
    expect(records.map((r) => r.tags.map((t) => t.origin))).toEqual([['manual'], ['manual']]);
  });

  it('removing by hand removes an ai tag from a file', async () => {
    const ctx = await setup();
    const a = await addFile(ctx, 1);
    await ctx.db.tags.addToFile({
      fileId: a,
      name: 'oak',
      displayName: 'Oak',
      origin: 'ai',
      newId: uuid(900),
      now: T1,
    });
    expect((await removeFileTag(ctx.session, { fileId: a, name: 'oak' })).tags).toEqual([]);
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

    await expect(addFileTags(ctx.session, { fileIds: [a, pending], name: 'Oak' })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    expect((await getFile(a)).tags).toEqual([]);
    await expect(addFileTags(ctx.session, { fileIds: [a, missing], name: 'Oak' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await getFile(a)).tags).toEqual([]);
    const records = await addFileTags(ctx.session, { fileIds: [b, a], name: 'Oak' });
    expect(records.map((r) => r.id)).toEqual([b, a]);
    expect(
      records.every((r) => r.tags.some((t) => t.name === 'oak' && t.displayName === 'Oak' && t.origin === 'manual')),
    ).toBe(true);
    expect((await getFile(a)).tags).toEqual([{ name: 'oak', displayName: 'Oak', origin: 'manual' }]);
  });

  it('removeFileTags removes from all and ignores files without the tag', async () => {
    const ctx = await setup();
    const a = await addFile(ctx, 1);
    const b = await addFile(ctx, 2);
    const c = await addFile(ctx, 3);
    await ctx.db.tags.addToFile({
      fileId: a,
      name: 'oak',
      displayName: 'oak',
      origin: 'ai',
      newId: uuid(900),
      now: T1,
    });
    await addFileTags(ctx.session, { fileIds: [b], name: 'Oak' });

    const records = await removeFileTags(ctx.session, { fileIds: [c, a, b], name: 'OAK' });
    expect(records.map((r) => r.id)).toEqual([c, a, b]);
    // An AI assignment goes like a manual one.
    expect(records.map((r) => r.tags)).toEqual([[], [], []]);
  });

  it('removeFileTags is all or nothing', async () => {
    const ctx = await setup();
    const a = await addFile(ctx, 1);
    const pending = await addFile(ctx, 2, 'pending');
    await addFileTags(ctx.session, { fileIds: [a], name: 'Oak' });
    await expect(removeFileTags(ctx.session, { fileIds: [a, pending], name: 'oak' })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    await expect(removeFileTags(ctx.session, { fileIds: [a, UNKNOWN_ID], name: 'oak' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await ctx.session.database.files.get(a))!.tags).toHaveLength(1);
  });

  it('an invalid tag name fails with validation_failed before any lookup', async () => {
    const ctx = await setup();
    const get = vi.spyOn(ctx.db.files, 'get');
    const add = vi.spyOn(ctx.db.tags, 'addToFiles');
    const remove = vi.spyOn(ctx.db.tags, 'removeFromFiles');
    await expect(addFileTags(ctx.session, { fileIds: [UNKNOWN_ID], name: '  ' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
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
    expect((await suggestTags(session, { prefix: '', limit: 10 })).map((t) => t.name)).toEqual([
      'sci fi',
      'other',
      'scenic',
    ]);
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
      probe: fake.probe,
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

describe('trashed files', () => {
  it('addFileTag and removeFileTag refuse a trashed file', async () => {
    const ctx = await setup();
    const id = await addFile(ctx, 1);
    await addFileTag(ctx.session, { fileId: id, name: 'Metal' });
    await trashForTest(ctx.session, [id]);
    for (const op of [addFileTag, removeFileTag]) {
      const error = await op(ctx.session, { fileId: id, name: 'Metal' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidOperationError);
      expect((error as Error).message).toBe('The file is in the trash');
    }
    expect((await ctx.db.files.get(id))!.tags.map((t) => t.name)).toEqual(['metal']);
  });

  it('addFileTags and removeFileTags refuse a batch containing one', async () => {
    const ctx = await setup();
    const live = await addFile(ctx, 1);
    const trashed = await addFile(ctx, 2);
    await addFileTags(ctx.session, { fileIds: [live, trashed], name: 'Metal' });
    await trashForTest(ctx.session, [trashed]);
    await expect(addFileTags(ctx.session, { fileIds: [live, trashed], name: 'Wood' })).rejects.toThrow(
      'The file is in the trash',
    );
    await expect(removeFileTags(ctx.session, { fileIds: [live, trashed], name: 'Metal' })).rejects.toThrow(
      'The file is in the trash',
    );
    expect((await ctx.db.files.get(live))!.tags.map((t) => t.name)).toEqual(['metal']);
  });
});

describe('rename and merge', () => {
  type Ctx = Awaited<ReturnType<typeof setup>>;
  type Origin = 'manual' | 'ai';
  let seq = 800;
  const tagAsset = (ctx: Ctx, assetId: string, name: string, displayName: string, origin: Origin) =>
    ctx.db.tags.addToAsset({ assetId, name, displayName, origin, newId: uuid(seq++), now: T1 });
  const tagFile = (ctx: Ctx, fileId: string, name: string, displayName: string, origin: Origin) =>
    ctx.db.tags.addToFile({ fileId, name, displayName, origin, newId: uuid(seq++), now: T1 });
  const fileTags = async (ctx: Ctx, fileId: string) =>
    (await ctx.db.files.get(fileId))!.tags.map((t) => [t.name, t.displayName, t.origin]);
  const assetTags = async (ctx: Ctx, assetId: string) =>
    (await ctx.db.tags.listForAsset(assetId)).map((t) => [t.name, t.displayName, t.origin]);
  const propose = (ctx: Ctx, fileId: string, tags: { name: string; displayName: string }[]) =>
    ctx.db.analyses.propose({
      fileId,
      sha256: 'a'.repeat(64),
      tags,
      provider: 'ollama',
      model: 'm',
      promptVersion: 1,
      promptName: 'Default',
      createdAt: T1,
    });

  it('tagUsage counts assets carrying the tag and files not in the trash', async () => {
    const ctx = await setup();
    const live = await addFile(ctx, 1);
    const trashed = await addFile(ctx, 2);
    await tagAsset(ctx, ctx.asset.id, 'front view', 'Front View', 'manual');
    await tagFile(ctx, live, 'front view', 'Front View', 'ai');
    await tagFile(ctx, trashed, 'front view', 'Front View', 'manual');
    await trashForTest(ctx.session, [trashed]);
    expect(await tagUsage(ctx.session, { name: '  Front   View ' })).toEqual({
      exists: true,
      name: 'front view',
      displayName: 'Front View',
      assets: 1,
      files: 1,
      prompts: 0,
    });
  });

  it('tagUsage of an unknown or invalid text answers exists false', async () => {
    const ctx = await setup();
    expect(await tagUsage(ctx.session, { name: 'unknown' })).toEqual({
      exists: false,
      name: 'unknown',
      displayName: '',
      assets: 0,
      files: 0,
      prompts: 0,
    });
    const empty = { exists: false, name: '', displayName: '', assets: 0, files: 0, prompts: 0 };
    expect(await tagUsage(ctx.session, { name: '!!!' })).toEqual(empty);
    expect(await tagUsage(ctx.session, { name: '' })).toEqual(empty);
  });

  it('renames a tag to a free name and keeps the origins', async () => {
    const ctx = await setup();
    const file = await addFile(ctx, 1);
    await tagAsset(ctx, ctx.asset.id, 'front view', 'Front View', 'manual');
    await tagFile(ctx, file, 'front view', 'Front View', 'ai');
    expect(await renameTag(ctx.session, { from: 'front view', to: 'Frontal', merge: false })).toEqual({
      name: 'frontal',
      displayName: 'Frontal',
      merged: false,
    });
    expect(await assetTags(ctx, ctx.asset.id)).toEqual([['frontal', 'Frontal', 'manual']]);
    expect(await fileTags(ctx, file)).toEqual([['frontal', 'Frontal', 'ai']]);
    expect((await tagUsage(ctx.session, { name: 'front view' })).exists).toBe(false);
  });

  it.each([false, true])('a different spelling of the same name sets the display name (merge %s)', async (merge) => {
    const ctx = await setup();
    await tagAsset(ctx, ctx.asset.id, 'front', 'front', 'manual');
    expect(await renameTag(ctx.session, { from: 'front', to: 'FRONT', merge })).toEqual({
      name: 'front',
      displayName: 'FRONT',
      merged: false,
    });
    expect(await assetTags(ctx, ctx.asset.id)).toEqual([['front', 'FRONT', 'manual']]);
  });

  it('normalises from', async () => {
    const ctx = await setup();
    await tagAsset(ctx, ctx.asset.id, 'front view', 'Front View', 'manual');
    expect(await renameTag(ctx.session, { from: ' Front  View ', to: 'x', merge: false })).toEqual({
      name: 'x',
      displayName: 'x',
      merged: false,
    });
  });

  it.each(['nope', '!!!'])('an unknown or invalid from %j fails with not_found', async (from) => {
    const ctx = await setup();
    const error = await renameTag(ctx.session, { from, to: 'x', merge: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as Error).message).toBe('Tag does not exist');
  });

  it.each(['!!!', 'x'.repeat(65)])('an invalid to fails with validation_failed and changes nothing', async (to) => {
    const ctx = await setup();
    await tagAsset(ctx, ctx.asset.id, 'front view', 'Front View', 'manual');
    const error = await renameTag(ctx.session, { from: 'front view', to, merge: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationFailedError);
    expect((error as Error).message).toBe('A tag needs a letter or digit and at most 64 characters');
    expect(await assetTags(ctx, ctx.asset.id)).toEqual([['front view', 'Front View', 'manual']]);
  });

  it('an existing target without merge fails with invalid_operation and changes nothing', async () => {
    const ctx = await setup();
    const file = await addFile(ctx, 1);
    await tagAsset(ctx, ctx.asset.id, 'front view', 'Front View', 'ai');
    await tagAsset(ctx, ctx.other.id, 'front', 'Front', 'manual');
    await tagFile(ctx, file, 'front view', 'Front View', 'manual');
    await tagFile(ctx, file, 'front', 'Front', 'ai');
    const error = await renameTag(ctx.session, { from: 'front view', to: 'front', merge: false }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InvalidOperationError);
    expect((error as Error).message).toBe('A tag with this name already exists');
    expect(await assetTags(ctx, ctx.asset.id)).toEqual([['front view', 'Front View', 'ai']]);
    expect(await assetTags(ctx, ctx.other.id)).toEqual([['front', 'Front', 'manual']]);
    expect(await fileTags(ctx, file)).toEqual([
      ['front', 'Front', 'ai'],
      ['front view', 'Front View', 'manual'],
    ]);
  });

  // [source origin, target origin, expected origin]; null: the owner does not carry that tag.
  const cases: [Origin | null, Origin | null, Origin][] = [
    ['ai', 'manual', 'manual'],
    ['manual', 'ai', 'manual'],
    ['ai', 'ai', 'ai'],
    ['manual', 'manual', 'manual'],
    ['ai', null, 'ai'],
    [null, 'manual', 'manual'],
  ];

  it('a merge leaves every file carrying the target once, manual when either was manual', async () => {
    const ctx = await setup();
    const files: string[] = [];
    for (const [i, [source, target]] of cases.entries()) {
      const file = await addFile(ctx, i + 1);
      files.push(file);
      if (source) await tagFile(ctx, file, 'front view', 'Front View', source);
      if (target) await tagFile(ctx, file, 'front', 'Front', target);
    }
    expect(await renameTag(ctx.session, { from: 'front view', to: 'front', merge: true })).toEqual({
      name: 'front',
      displayName: 'front',
      merged: true,
    });
    for (const [i, [, , expected]] of cases.entries()) {
      expect(await fileTags(ctx, files[i]!)).toEqual([['front', 'front', expected]]);
    }
    expect((await tagUsage(ctx.session, { name: 'front view' })).exists).toBe(false);
  });

  it('a merge leaves every asset carrying the target once, manual when either was manual', async () => {
    const ctx = await setup();
    const typeId = (await ctx.db.assetTypes.list())[0]!.id;
    const assets: string[] = [];
    for (const [i, [source, target]] of cases.entries()) {
      const asset = await createAsset(ctx.session, { name: `A${i}`, typeId });
      assets.push(asset.id);
      if (source) await tagAsset(ctx, asset.id, 'front view', 'Front View', source);
      if (target) await tagAsset(ctx, asset.id, 'front', 'Front', target);
    }
    expect(await renameTag(ctx.session, { from: 'front view', to: 'front', merge: true })).toEqual({
      name: 'front',
      displayName: 'front',
      merged: true,
    });
    for (const [i, [, , expected]] of cases.entries()) {
      expect(await assetTags(ctx, assets[i]!)).toEqual([['front', 'front', expected]]);
    }
  });

  it('merge true without an existing target is a plain rename', async () => {
    const ctx = await setup();
    await tagAsset(ctx, ctx.asset.id, 'front view', 'Front View', 'manual');
    expect(await renameTag(ctx.session, { from: 'front view', to: 'Frontal', merge: true })).toEqual({
      name: 'frontal',
      displayName: 'Frontal',
      merged: false,
    });
  });

  it('rewrites waiting proposals that hold the source', async () => {
    const ctx = await setup();
    const a = await addFile(ctx, 1);
    const b = await addFile(ctx, 2);
    await tagAsset(ctx, ctx.asset.id, 'front view', 'Front View', 'manual');
    await tagAsset(ctx, ctx.other.id, 'front', 'Front', 'manual');
    expect(
      await propose(ctx, a, [
        { name: 'front view', displayName: 'Front View' },
        { name: 'metal', displayName: 'Metal' },
      ]),
    ).toBe(true);
    await renameTag(ctx.session, { from: 'front view', to: 'Frontal', merge: false });
    expect((await ctx.db.analyses.getProposal(a))!.tags).toEqual([
      { name: 'frontal', displayName: 'Frontal' },
      { name: 'metal', displayName: 'Metal' },
    ]);

    expect(
      await propose(ctx, b, [
        { name: 'frontal', displayName: 'Frontal' },
        { name: 'front', displayName: 'Front' },
      ]),
    ).toBe(true);
    await renameTag(ctx.session, { from: 'frontal', to: 'front', merge: true });
    expect((await ctx.db.analyses.getProposal(b))!.tags).toEqual([{ name: 'front', displayName: 'front' }]);
    expect((await ctx.db.analyses.getProposal(a))!.tags).toEqual([
      { name: 'front', displayName: 'front' },
      { name: 'metal', displayName: 'Metal' },
    ]);
  });

  it('gives every kept target entry of a proposal the new display name on a merge', async () => {
    const ctx = await setup();
    const a = await addFile(ctx, 1);
    const b = await addFile(ctx, 2);
    await tagAsset(ctx, ctx.asset.id, 'front view', 'Front View', 'manual');
    await tagAsset(ctx, ctx.other.id, 'front', 'Front', 'manual');
    expect(
      await propose(ctx, a, [
        { name: 'front', displayName: 'Front' },
        { name: 'front view', displayName: 'Front View' },
      ]),
    ).toBe(true);
    expect(
      await propose(ctx, b, [
        { name: 'metal', displayName: 'Metal' },
        { name: 'front', displayName: 'Front' },
      ]),
    ).toBe(true);
    await renameTag(ctx.session, { from: 'front view', to: 'FRONT', merge: true });
    expect((await ctx.db.analyses.getProposal(a))!.tags).toEqual([{ name: 'front', displayName: 'FRONT' }]);
    expect((await ctx.db.analyses.getProposal(b))!.tags).toEqual([
      { name: 'metal', displayName: 'Metal' },
      { name: 'front', displayName: 'FRONT' },
    ]);
  });

  it('gives proposals holding the tag the new display name on a display-name-only change', async () => {
    const ctx = await setup();
    const a = await addFile(ctx, 1);
    await tagAsset(ctx, ctx.asset.id, 'front', 'front', 'manual');
    expect(
      await propose(ctx, a, [
        { name: 'front', displayName: 'front' },
        { name: 'metal', displayName: 'Metal' },
      ]),
    ).toBe(true);
    await renameTag(ctx.session, { from: 'front', to: 'Front', merge: false });
    expect((await ctx.db.analyses.getProposal(a))!.tags).toEqual([
      { name: 'front', displayName: 'Front' },
      { name: 'metal', displayName: 'Metal' },
    ]);
  });
});
