import { describe, expect, it, vi } from 'vitest';
import {
  assetFilePath,
  assignAsset,
  assignFiles,
  createAsset,
  createProject,
  inboxPath,
  InvalidOperationError,
  listAssets,
  listFiles,
  NotFoundError,
  recoverFileMoves,
  relocateFile,
  removeAssignment,
  WorkspaceManager,
  type FileQuery,
  type WorkspaceSession,
} from '../src/index.js';
import type { FileKind, FileList, FileRole, FileScope } from '@assetforge/contracts';
import { createFakeHost } from './fakes.js';

const ROOT = '/ws/a';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
const TS = '2026-01-01T00:00:00.000Z';

async function setup() {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const storage = fake.storages.get(ROOT)!;
  const db = fake.databases.get(summary.id)!;
  const session: WorkspaceSession = await manager.read(async (s) => s);
  const typeId = (await db.assetTypes.list())[0]!.id;
  const asset = await createAsset(session, { name: 'Pump', typeId });
  const other = await createAsset(session, { name: 'Motel', typeId });
  fake.sources.set('/src/pump.png', Buffer.from('pump'));
  fake.sources.set('/src/motel.png', Buffer.from('motel'));
  const [imported] = await manager.importFiles(['/src/pump.png']);
  const file = imported!.file!;
  return { ...fake, manager, summary, storage, db, session, typeId, asset, other, file };
}

describe('relocateFile', () => {
  it("assigning an inbox file moves it into the asset's role directory", async () => {
    const { session, storage, db, asset, file } = await setup();
    const placed = await relocateFile(session, file.id, { assetId: asset.id, role: 'reference' });

    const target = assetFilePath(asset.id, 'reference', file.id, 'pump.png');
    expect(placed).toEqual({ ...file, relativePath: target, assetId: asset.id, role: 'reference' });
    expect(storage.files.has(file.relativePath)).toBe(false);
    expect(storage.files.get(target)?.toString()).toBe('pump');
    expect(db.files.records.get(file.id)).toEqual(placed);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('changing the role inside one directory only updates the row', async () => {
    const { session, storage, db, asset, file } = await setup();
    const placed = await relocateFile(session, file.id, { assetId: asset.id, role: 'reference' });
    const move = vi.spyOn(storage, 'move');
    const begin = vi.spyOn(db.fileMoves, 'begin');

    const changed = await relocateFile(session, file.id, { assetId: asset.id, role: 'concept' });

    expect(changed).toEqual({ ...placed, role: 'concept' });
    expect(move).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(storage.files.has(placed.relativePath)).toBe(true);
    expect(db.files.records.get(file.id)).toEqual(changed);
  });

  it('changing the role across directories moves the file', async () => {
    const { session, storage, asset, file } = await setup();
    const placed = await relocateFile(session, file.id, { assetId: asset.id, role: 'reference' });
    const changed = await relocateFile(session, file.id, { assetId: asset.id, role: 'texture' });

    const target = assetFilePath(asset.id, 'texture', file.id, 'pump.png');
    expect(changed).toMatchObject({ relativePath: target, assetId: asset.id, role: 'texture' });
    expect(storage.files.has(placed.relativePath)).toBe(false);
    expect(storage.files.has(target)).toBe(true);
  });

  it('moving a file to another asset moves it into that asset', async () => {
    const { session, storage, asset, other, file } = await setup();
    await relocateFile(session, file.id, { assetId: asset.id, role: 'reference' });
    const moved = await relocateFile(session, file.id, { assetId: other.id, role: 'reference' });
    expect(moved).toMatchObject({ relativePath: assetFilePath(other.id, 'reference', file.id, 'pump.png'), assetId: other.id });
    expect(storage.files.has(moved.relativePath)).toBe(true);
  });

  it('detaching moves the file back to its inbox path', async () => {
    const { session, storage, db, asset, file } = await setup();
    const placed = await relocateFile(session, file.id, { assetId: asset.id, role: 'model' });
    const detached = await relocateFile(session, file.id, null);

    expect(detached).toEqual(file);
    expect(detached.relativePath).toBe(inboxPath(file.id, 'pump.png'));
    expect(storage.files.has(placed.relativePath)).toBe(false);
    expect(storage.files.get(file.relativePath)?.toString()).toBe('pump');
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('relocating to the current placement does nothing', async () => {
    const { session, storage, db, asset, file } = await setup();
    const move = vi.spyOn(storage, 'move');
    const setPlacement = vi.spyOn(db.files, 'setPlacement');
    await expect(relocateFile(session, file.id, null)).resolves.toEqual(file);
    expect(move).not.toHaveBeenCalled();
    expect(setPlacement).not.toHaveBeenCalled();

    const placed = await relocateFile(session, file.id, { assetId: asset.id, role: 'final' });
    move.mockClear();
    setPlacement.mockClear();
    await expect(relocateFile(session, file.id, { assetId: asset.id, role: 'final' })).resolves.toEqual(placed);
    expect(move).not.toHaveBeenCalled();
    expect(setPlacement).not.toHaveBeenCalled();
  });

  it('rejects a pending or failed file with invalid_operation', async () => {
    const { session, db, asset } = await setup();
    const storageId = session.storageId;
    const pendingId = '33333333-3333-4333-8333-333333333333';
    const failedId = '44444444-4444-4444-8444-444444444444';
    for (const id of [pendingId, failedId]) {
      await db.files.insertPending({
        id,
        storageId,
        originalName: 'x.png',
        relativePath: inboxPath(id, 'x.png'),
        mimeType: 'image/png',
        importedAt: TS,
        kind: 'image',
      });
    }
    await db.files.markFailed(failedId, 'Import failed');
    for (const id of [pendingId, failedId]) {
      await expect(relocateFile(session, id, { assetId: asset.id, role: 'reference' })).rejects.toBeInstanceOf(
        InvalidOperationError,
      );
    }
    await expect(relocateFile(session, UNKNOWN_ID, null)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects an unknown asset with not_found and leaves the file untouched', async () => {
    const { session, storage, db, file } = await setup();
    await expect(relocateFile(session, file.id, { assetId: UNKNOWN_ID, role: 'reference' })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(db.files.records.get(file.id)).toEqual(file);
    expect(storage.files.has(file.relativePath)).toBe(true);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('a failed move leaves row and file unchanged and no move row', async () => {
    const { session, storage, db, asset, file } = await setup();
    storage.failNext('move', Object.assign(new Error('EBUSY: /abs/path'), { code: 'EBUSY' }));
    const failure = relocateFile(session, file.id, { assetId: asset.id, role: 'reference' });
    await expect(failure).rejects.toBeInstanceOf(InvalidOperationError);
    await expect(failure).rejects.toMatchObject({ code: 'invalid_operation' });
    await expect(failure).rejects.not.toThrow(/abs|EBUSY/);
    expect(db.files.records.get(file.id)).toEqual(file);
    expect(storage.files.has(file.relativePath)).toBe(true);
    expect(storage.files.has(assetFilePath(asset.id, 'reference', file.id, 'pump.png'))).toBe(false);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('never overwrites an existing target', async () => {
    const { session, storage, db, asset, file } = await setup();
    const target = assetFilePath(asset.id, 'reference', file.id, 'pump.png');
    storage.files.set(target, Buffer.from('existing'));
    await expect(relocateFile(session, file.id, { assetId: asset.id, role: 'reference' })).rejects.toMatchObject({
      code: 'invalid_operation',
    });
    expect(storage.files.get(target)?.toString()).toBe('existing');
    expect(storage.files.get(file.relativePath)?.toString()).toBe('pump');
    expect(db.files.records.get(file.id)).toEqual(file);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('a domain error of the move is passed through unchanged', async () => {
    const { session, storage, db, asset, file } = await setup();
    const error = new NotFoundError('Storage is not available');
    storage.failNext('move', error);
    await expect(relocateFile(session, file.id, { assetId: asset.id, role: 'reference' })).rejects.toBe(error);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('a second move for a file with an open move row is rejected', async () => {
    const { session, db, asset, file } = await setup();
    await db.fileMoves.begin({
      fileId: file.id,
      targetRelativePath: assetFilePath(asset.id, 'reference', file.id, 'pump.png'),
      targetAssetId: asset.id,
      targetRole: 'reference',
      createdAt: TS,
    });
    await expect(relocateFile(session, file.id, { assetId: asset.id, role: 'texture' })).rejects.toBeInstanceOf(
      InvalidOperationError,
    );
    expect(db.files.records.get(file.id)).toEqual(file);
  });
});

describe('assignFiles', () => {
  it('assignFiles moves every file it can and reports the one failure in the middle', async () => {
    const ctx = await setup();
    const { session, storage, asset, file } = ctx;
    const [second] = await ctx.manager.importFiles(['/src/motel.png']);
    const a = file.id;
    const b = second!.file!.id;
    const missing = UNKNOWN_ID;

    const res = await assignFiles(session, { fileIds: [a, missing, b], assetId: asset.id, role: 'texture' });

    expect(res.map((r) => r.fileId)).toEqual([a, missing, b]);
    expect(res[0]!.file?.assetId).toBe(asset.id);
    expect(res[0]!.error).toBeNull();
    expect(res[1]).toMatchObject({ file: null });
    expect(res[1]!.error).toBeInstanceOf(NotFoundError);
    expect(res[2]!.file?.role).toBe('texture');
    expect(storage.files.has(assetFilePath(asset.id, 'texture', b, 'motel.png'))).toBe(true);
  });

  it('an unknown asset fails every item with not_found and moves nothing', async () => {
    const { session, storage, file } = await setup();
    const res = await assignFiles(session, { fileIds: [file.id], assetId: UNKNOWN_ID, role: 'texture' });
    expect(res).toEqual([{ fileId: file.id, file: null, error: expect.any(NotFoundError) }]);
    expect(storage.files.has(file.relativePath)).toBe(true);
  });
});

describe('recoverFileMoves', () => {
  const recover = (ctx: Awaited<ReturnType<typeof setup>>) =>
    recoverFileMoves({ storage: ctx.storage, files: ctx.db.files, fileMoves: ctx.db.fileMoves });
  const journal = async (ctx: Awaited<ReturnType<typeof setup>>, moved: boolean) => {
    const target = assetFilePath(ctx.asset.id, 'reference', ctx.file.id, 'pump.png');
    await ctx.db.fileMoves.begin({
      fileId: ctx.file.id,
      targetRelativePath: target,
      targetAssetId: ctx.asset.id,
      targetRole: 'reference',
      createdAt: TS,
    });
    if (moved) await ctx.storage.move(ctx.file.relativePath, target);
    return target;
  };

  it('recovery completes a move whose target exists', async () => {
    const ctx = await setup();
    const target = await journal(ctx, true);
    const result = await recover(ctx);
    expect(result).toEqual({ completed: [ctx.file.id], discarded: [] });
    expect(ctx.db.files.records.get(ctx.file.id)).toEqual({
      ...ctx.file,
      relativePath: target,
      assetId: ctx.asset.id,
      role: 'reference',
    });
    await expect(ctx.db.fileMoves.list()).resolves.toEqual([]);
  });

  it('recovery discards a move whose target is missing', async () => {
    const ctx = await setup();
    await journal(ctx, false);
    const result = await recover(ctx);
    expect(result).toEqual({ completed: [], discarded: [ctx.file.id] });
    expect(ctx.db.files.records.get(ctx.file.id)).toEqual(ctx.file);
    expect(ctx.storage.files.has(ctx.file.relativePath)).toBe(true);
    await expect(ctx.db.fileMoves.list()).resolves.toEqual([]);
  });

  it('discards a move when both source and target exist: row unchanged, both files untouched', async () => {
    const ctx = await setup();
    const target = await journal(ctx, false);
    ctx.storage.files.set(target, Buffer.from('other'));
    const result = await recover(ctx);
    expect(result).toEqual({ completed: [], discarded: [ctx.file.id] });
    expect(ctx.db.files.records.get(ctx.file.id)).toEqual(ctx.file);
    expect(ctx.storage.files.get(ctx.file.relativePath)?.toString()).toBe('pump');
    expect(ctx.storage.files.get(target)?.toString()).toBe('other');
    await expect(ctx.db.fileMoves.list()).resolves.toEqual([]);
  });

  it('skips a row whose check fails and keeps it for the next open', async () => {
    const ctx = await setup();
    await journal(ctx, true);
    ctx.storage.failNext('exists', new Error('EIO'));
    const result = await recover(ctx);
    expect(result).toEqual({ completed: [], discarded: [] });
    await expect(ctx.db.fileMoves.list()).resolves.toHaveLength(1);
    expect(ctx.db.files.records.get(ctx.file.id)).toEqual(ctx.file);
  });

  it('recovery runs when the workspace is opened', async () => {
    const ctx = await setup();
    const target = await journal(ctx, true);
    await ctx.manager.close();
    await ctx.manager.open({ rootPath: ROOT });
    const list = await ctx.manager.listFiles({ limit: 10, offset: 0, scope: { kind: 'asset', assetId: ctx.asset.id } });
    expect(list.items).toEqual([{ ...ctx.file, relativePath: target, assetId: ctx.asset.id, role: 'reference' }]);
    await expect(ctx.db.fileMoves.list()).resolves.toEqual([]);
  });
});

describe('importing into an asset', () => {
  it('importing into an asset places the files and reports the placed records', async () => {
    const { manager, storage, db, asset } = await setup();
    const results = await manager.importFiles(['/src/motel.png', '/src/missing.png'], { assetId: asset.id, role: 'texture' });

    expect(results).toHaveLength(2);
    const placed = results[0]!;
    expect(placed.error).toBeNull();
    expect(placed.file).toMatchObject({
      status: 'complete',
      assetId: asset.id,
      role: 'texture',
      relativePath: assetFilePath(asset.id, 'texture', placed.file!.id, 'motel.png'),
    });
    expect(storage.files.get(placed.file!.relativePath)?.toString()).toBe('motel');
    expect(db.files.records.get(placed.file!.id)).toEqual(placed.file);
    expect(results[1]).toMatchObject({ file: null });
    expect(results[1]!.error).not.toBeNull();
  });

  it('keeps the inbox record and reports the error when the placement fails', async () => {
    const { manager, storage, db, asset } = await setup();
    // The first move is the import's staging -> inbox move; the placement is the second.
    const move = storage.move.bind(storage);
    let calls = 0;
    vi.spyOn(storage, 'move').mockImplementation(async (from, to) => {
      if (++calls === 2) throw new NotFoundError('Placement target is not available');
      return move(from, to);
    });

    const [result] = await manager.importFiles(['/src/motel.png'], { assetId: asset.id, role: 'texture' });

    expect(result!.file).toMatchObject({ status: 'complete', assetId: null, role: null });
    expect(result!.file!.relativePath).toBe(inboxPath(result!.file!.id, 'motel.png'));
    expect(result!.error).toBe('Placement target is not available');
    expect(db.files.records.get(result!.file!.id)).toEqual(result!.file);
    expect(storage.files.has(result!.file!.relativePath)).toBe(true);
  });

  it('importing into an unknown asset imports nothing', async () => {
    const { manager, storage, db } = await setup();
    const before = db.files.records.size;
    const filesBefore = storage.files.size;
    await expect(
      manager.importFiles(['/src/motel.png'], { assetId: UNKNOWN_ID, role: 'texture' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(db.files.records.size).toBe(before);
    expect(storage.files.size).toBe(filesBefore);
  });
});

describe('listing files', () => {
  it('lists files by scope and counts the files of an asset', async () => {
    const { manager, session, asset, other, file } = await setup();
    const [second] = await manager.importFiles(['/src/motel.png']);
    await relocateFile(session, file.id, { assetId: asset.id, role: 'reference' });

    const page = { limit: 10, offset: 0 };
    const ids = async (scope: Parameters<typeof listFiles>[1]['scope']) =>
      (await listFiles(session, { ...page, scope })).items.map((f) => f.id);
    await expect(ids({ kind: 'inbox' })).resolves.toEqual([second!.file!.id]);
    await expect(ids({ kind: 'asset', assetId: asset.id })).resolves.toEqual([file.id]);
    await expect(ids({ kind: 'asset', assetId: other.id })).resolves.toEqual([]);
    expect((await listFiles(session, { ...page, scope: { kind: 'all' } })).total).toBe(2);
    const counts = (await listAssets(session, page)).items.map((a) => [a.name, a.fileCount]);
    expect(counts).toEqual([
      ['Motel', 0],
      ['Pump', 1],
    ]);
  });

  it('removing a project assignment leaves the files of the asset untouched', async () => {
    const { session, storage, db, asset, file } = await setup();
    const project = await createProject(session, { name: 'Game' });
    const placed = await relocateFile(session, file.id, { assetId: asset.id, role: 'reference' });
    await assignAsset(session, { projectId: project.id, assetId: asset.id });
    await removeAssignment(session, { projectId: project.id, assetId: asset.id });
    expect(db.files.records.get(file.id)).toEqual(placed);
    expect(storage.files.get(placed.relativePath)?.toString()).toBe('pump');
  });
});

describe('file list filters', () => {
  async function seed() {
    const fake = createFakeHost();
    const manager = new WorkspaceManager(fake.host);
    await manager.create({ name: 'Demo', rootPath: ROOT });
    const s: WorkspaceSession = await manager.read(async (x) => x);
    const db = s.database;
    const typeId = (await db.assetTypes.list())[0]!.id;
    const asset = await createAsset(s, { name: 'Tree', typeId });
    let n = 0;
    const addFile = async (originalName: string, kind: FileKind, placement?: { assetId: string; role: FileRole }) => {
      const id = `f0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      const relativePath = `inbox/${id}/${originalName}`;
      await db.files.insertPending({ id, storageId: 's', originalName, relativePath, mimeType: 'image/png', importedAt: TS, kind });
      await db.files.markComplete(id, { sizeBytes: 1, sha256: 'a'.repeat(64), width: null, height: null });
      if (placement) await db.files.setPlacement(id, { relativePath: `assets/${id}`, ...placement });
      return id;
    };
    const tag = (name: string) => ({ name, displayName: name, origin: 'manual' as const, newId: `t-${name}`, now: TS });
    const tagFile = (fileId: string, name: string) => db.tags.addToFile({ fileId, ...tag(name) });
    const tagAsset = (assetId: string, name: string) => db.tags.addToAsset({ assetId, ...tag(name) });
    return { s, asset, addFile, tagFile, tagAsset };
  }

  const page = (q: Omit<FileQuery, 'limit' | 'offset'>): FileQuery => ({ limit: 60, offset: 0, ...q });
  const names = (list: FileList) => list.items.map((f) => f.originalName).sort();
  const inbox: FileScope = { kind: 'inbox' };
  const all: FileScope = { kind: 'all' };

  it('query folds case and diacritics and matches tag word prefixes', async () => {
    const { s, addFile, tagFile } = await seed();
    await addFile('Säule-01.png', 'image');
    await tagFile(await addFile('wall.png', 'image'), 'sci-fi');
    await addFile('other.png', 'image');

    expect(names(await listFiles(s, page({ scope: inbox, query: 'saule' })))).toEqual(['Säule-01.png']);
    expect(names(await listFiles(s, page({ scope: inbox, query: 'SÄU' })))).toEqual(['Säule-01.png']);
    expect(names(await listFiles(s, page({ scope: inbox, query: 'sci-fi' })))).toEqual(['wall.png']);
    expect(names(await listFiles(s, page({ scope: inbox, query: 'fi' })))).toEqual(['wall.png']);
    expect(names(await listFiles(s, page({ scope: inbox, query: 'all sci' })))).toEqual(['wall.png']); // every word
    expect(names(await listFiles(s, page({ scope: inbox, query: 'ci' })))).toEqual([]); // tags match word prefixes only
    expect((await listFiles(s, page({ scope: inbox, query: ' -* ' }))).total).toBe(3); // no words: no filter
  });

  it('tagNames require every tag on the file itself', async () => {
    const { s, asset, addFile, tagFile, tagAsset } = await seed();
    await tagAsset(asset.id, 'oak');
    await tagFile(await addFile('f.png', 'image', { assetId: asset.id, role: 'texture' }), 'bark');
    await addFile('g.png', 'image', { assetId: asset.id, role: 'texture' });
    const assetScope: FileScope = { kind: 'asset', assetId: asset.id };

    expect(names(await listFiles(s, page({ scope: assetScope, tagNames: ['bark'] })))).toEqual(['f.png']);
    expect(names(await listFiles(s, page({ scope: assetScope, tagNames: [' BARK ', 'bark'] })))).toEqual(['f.png']);
    expect((await listFiles(s, page({ scope: assetScope, tagNames: ['bark', 'oak'] }))).total).toBe(0);
  });

  it('an unknown tag gives an empty page', async () => {
    const { s, addFile } = await seed();
    await addFile('a.png', 'image');
    expect(await listFiles(s, page({ scope: all, tagNames: ['nope'] }))).toEqual({ items: [], total: 0 });
  });

  it('role and kind filter within the scope', async () => {
    const { s, asset, addFile } = await seed();
    await addFile('tex.png', 'image', { assetId: asset.id, role: 'texture' });
    await addFile('ref.png', 'image', { assetId: asset.id, role: 'reference' });
    await addFile('mesh.glb', 'model', { assetId: asset.id, role: 'texture' });
    await addFile('inbox.glb', 'model');
    await addFile('inbox.png', 'image');
    const assetScope: FileScope = { kind: 'asset', assetId: asset.id };

    expect(names(await listFiles(s, page({ scope: assetScope, role: 'texture' })))).toEqual(['mesh.glb', 'tex.png']);
    expect(names(await listFiles(s, page({ scope: assetScope, role: 'texture', kind: 'image' })))).toEqual(['tex.png']);
    expect(names(await listFiles(s, page({ scope: inbox, kind: 'model' })))).toEqual(['inbox.glb']);
    expect(names(await listFiles(s, page({ scope: all, kind: 'model' })))).toEqual(['inbox.glb', 'mesh.glb']);
  });
});
