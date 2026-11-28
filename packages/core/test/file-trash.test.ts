import { describe, expect, it, vi } from 'vitest';
import {
  assetFilePath,
  createAsset,
  emptyTrash,
  inboxPath,
  InvalidOperationError,
  NotFoundError,
  purgeFiles,
  recoverFileMoves,
  relocateFile,
  restoreFiles,
  stagingPath,
  StorageUnreachableError,
  sweepTrash,
  trashCount,
  trashFiles,
  TRASH_DIR,
  trashPath,
  WorkspaceManager,
  type FileBatchItem,
  type JobControl,
  type WorkspaceSession,
} from '../src/index.js';
import { createFakeHost, type InMemoryDatabase } from './fakes.js';

const ROOT = '/ws/a';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
const TS = '2026-01-01T00:00:00.000Z';

/** Records every cancel; a pending job is cancelled at once, a running one only noted (its handler never settles). */
class RecordingControl implements JobControl {
  readonly cancelled: string[] = [];
  wakes = 0;
  constructor(private readonly db: InMemoryDatabase) {}
  wake(): void {
    this.wakes++;
  }
  async cancel(jobId: string): Promise<void> {
    this.cancelled.push(jobId);
    await this.db.jobs.cancelPending({ id: jobId, now: TS });
  }
  async cancelAll(): Promise<number> {
    return 0;
  }
}

async function setup() {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const storage = fake.storages.get(ROOT)!;
  const db = fake.databases.get(summary.id)!;
  const session: WorkspaceSession = await manager.read(async (s) => s);
  const typeId = (await db.assetTypes.list())[0]!.id;
  const asset = await createAsset(session, { name: 'Pump', typeId });
  let n = 0;
  /** Imports one file into the inbox, or onto `asset` with a role. */
  const importOne = async (
    name = `file-${++n}.png`,
    target: { assetId: string; role: 'reference' | 'texture' } | null = null,
  ) => {
    const source = `/src/${++n}/${name}`;
    fake.sources.set(source, Buffer.from(`content of ${source}`));
    const [result] = await manager.importFiles([source], target);
    return result!.file!;
  };
  const control = new RecordingControl(db);
  return { ...fake, manager, summary, storage, db, session, typeId, asset, importOne, control };
}

const ok = (items: FileBatchItem[]) => {
  for (const item of items) if (item.error) throw item.error;
  return items.map((i) => i.file);
};

describe('trashFiles', () => {
  it('trashing an asset file moves the binary into the trash directory and records the origin', async () => {
    const { session, storage, db, asset, importOne, control } = await setup();
    const file = await importOne('pump.png', { assetId: asset.id, role: 'reference' });
    const before = file.relativePath;
    expect(before).toBe(assetFilePath(asset.id, 'reference', file.id, 'pump.png'));

    const [item] = await trashFiles(session, control, [file.id]);

    expect(item!.error).toBeNull();
    const target = trashPath(file.id, 'pump.png');
    expect(storage.files.has(target)).toBe(true);
    expect(storage.files.has(before)).toBe(false);
    expect(item!.file).toMatchObject({
      id: file.id,
      assetId: null,
      role: null,
      relativePath: target,
      trashedAssetId: asset.id,
      trashedAssetName: 'Pump',
      trashedRole: 'reference',
      status: 'complete',
      openable: false,
    });
    expect(item!.file!.deletedAt).not.toBeNull();
    expect(await db.files.get(file.id)).toEqual(item!.file);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
    expect(await trashCount(session)).toBe(1);
  });

  it('trashing an inbox file', async () => {
    const { session, storage, importOne, control } = await setup();
    const file = await importOne('a.png');
    const [file2] = ok(await trashFiles(session, control, [file.id]));
    expect(file2).toMatchObject({
      assetId: null,
      role: null,
      trashedAssetId: null,
      trashedRole: null,
      relativePath: trashPath(file.id, 'a.png'),
    });
    expect(storage.files.has(inboxPath(file.id, 'a.png'))).toBe(false);
  });

  it('restore puts it back into the inbox', async () => {
    const { session, storage, importOne, control } = await setup();
    const file = await importOne('a.png');
    await trashFiles(session, control, [file.id]);

    const [restored] = ok(await restoreFiles(session, [file.id]));

    expect(restored).toEqual(file);
    expect(storage.files.has(inboxPath(file.id, 'a.png'))).toBe(true);
    expect(storage.files.has(trashPath(file.id, 'a.png'))).toBe(false);
    expect(await trashCount(session)).toBe(0);
  });

  it('restore returns the file to its asset and role with tags, analysis record and proposal intact', async () => {
    const { session, storage, db, asset, importOne, control } = await setup();
    const file = await importOne('pump.png', { assetId: asset.id, role: 'texture' });
    await db.tags.addToFile({
      fileId: file.id,
      name: 'metal',
      displayName: 'Metal',
      origin: 'manual',
      newId: crypto.randomUUID(),
      now: TS,
    });
    const fingerprint = { provider: 'ollama', model: 'm', promptVersion: 1, promptName: null };
    await db.analyses.apply({
      fileId: file.id,
      sha256: file.sha256!,
      tags: [{ name: 'red', displayName: 'red', newId: crypto.randomUUID() }],
      ...fingerprint,
      now: TS,
    });
    await db.analyses.propose({
      fileId: file.id,
      sha256: file.sha256!,
      tags: [{ name: 'blue', displayName: 'blue' }],
      ...fingerprint,
      createdAt: TS,
    });
    await db.assets.setCover(asset.id, file.id, TS);

    const [trashed] = ok(await trashFiles(session, control, [file.id]));
    expect(trashed!.tags.map((t) => t.name)).toEqual(['metal', 'red']);
    expect(trashed!.hasProposal).toBe(true);
    expect(await db.assets.getCover(asset.id)).toEqual({ coverFileId: null, coverIsChosen: false });

    const [restored] = ok(await restoreFiles(session, [file.id]));

    const target = assetFilePath(asset.id, 'texture', file.id, 'pump.png');
    expect(restored).toMatchObject({
      assetId: asset.id,
      role: 'texture',
      relativePath: target,
      deletedAt: null,
      trashedAssetId: null,
      trashedRole: null,
    });
    expect(restored!.tags.map((t) => t.name)).toEqual(['metal', 'red']);
    expect(restored!.hasProposal).toBe(true);
    expect(await db.analyses.get(file.id)).toMatchObject({ ...fingerprint, sha256: file.sha256 });
    expect(storage.files.has(target)).toBe(true);
    // The file never becomes the chosen cover again by itself.
    expect((await db.assets.getCover(asset.id))?.coverIsChosen).toBe(false);
  });

  it('restore goes to the inbox when the asset is gone', async () => {
    const { session, storage, db, asset, importOne, control } = await setup();
    const file = await importOne('pump.png', { assetId: asset.id, role: 'reference' });
    await trashFiles(session, control, [file.id]);
    // As after the asset row was deleted (foreign key `set null`).
    db.files.records.set(file.id, { ...db.files.records.get(file.id)!, trashedAssetId: null });

    const [restored] = ok(await restoreFiles(session, [file.id]));

    expect(restored).toMatchObject({
      assetId: null,
      role: null,
      relativePath: inboxPath(file.id, 'pump.png'),
      deletedAt: null,
    });
    expect(storage.files.has(inboxPath(file.id, 'pump.png'))).toBe(true);
  });

  it('two files with the same name get distinct trash paths', async () => {
    const { session, storage, asset, importOne, control } = await setup();
    const a = await importOne('same.png');
    const b = await importOne('same.png', { assetId: asset.id, role: 'reference' });
    const [ta, tb] = ok(await trashFiles(session, control, [a.id, b.id]));
    expect(ta!.relativePath).not.toBe(tb!.relativePath);
    expect(storage.files.has(ta!.relativePath)).toBe(true);
    expect(storage.files.has(tb!.relativePath)).toBe(true);
  });

  it('a name with reserved characters is sanitised', async () => {
    const { session, storage, importOne, control } = await setup();
    const file = await importOne('a:b?c.png');
    const [trashed] = ok(await trashFiles(session, control, [file.id]));
    const rest = trashed!.relativePath.slice(`${TRASH_DIR}/`.length);
    expect(trashed!.relativePath.startsWith(`${TRASH_DIR}/${file.id}_`)).toBe(true);
    expect(rest).not.toMatch(/[/:?]/);
    expect(storage.files.has(trashed!.relativePath)).toBe(true);
  });

  it('trashing cancels queued jobs and asks the scheduler to cancel a running one', async () => {
    const { session, db, importOne, control } = await setup();
    const a = await importOne('a.png');
    const b = await importOne('b.png');
    const job = (id: string, fileId: string) => ({
      id,
      type: 't',
      resourceClass: 'cpu' as const,
      fileId,
      lane: null,
      payload: {},
      dedupeKey: null,
    });
    await db.jobs.enqueue({ jobs: [job('run', a.id)], now: TS });
    await db.jobs.claimNext({ resourceClass: 'cpu', types: ['t'], now: TS });
    await db.jobs.enqueue({ jobs: [job('queued', a.id), job('other', b.id)], now: TS });

    // The running job's handler never settles; the trash does not wait for it.
    const items = await trashFiles(session, control, [a.id]);

    expect(items[0]!.error).toBeNull();
    expect(control.cancelled.sort()).toEqual(['queued', 'run']);
    expect(db.jobs.rows.find((r) => r.id === 'queued')!.status).toBe('cancelled');
    expect(db.jobs.rows.find((r) => r.id === 'run')!.status).toBe('running');
    expect(db.jobs.rows.find((r) => r.id === 'other')!.status).toBe('queued');
  });

  it('a pending file is refused, an already trashed file is refused, an unknown id is not_found — the valid one is still trashed', async () => {
    const { session, db, importOne, control } = await setup();
    const trashed = await importOne('t.png');
    await trashFiles(session, control, [trashed.id]);
    const valid = await importOne('v.png');
    const pendingId = crypto.randomUUID();
    await db.files.insertPending({
      id: pendingId,
      storageId: 's',
      originalName: 'p.png',
      relativePath: inboxPath(pendingId, 'p.png'),
      mimeType: 'image/png',
      importedAt: TS,
      kind: 'image',
    });

    const items = await trashFiles(session, control, [pendingId, trashed.id, UNKNOWN_ID, valid.id]);

    expect(items.map((i) => i.fileId)).toEqual([pendingId, trashed.id, UNKNOWN_ID, valid.id]);
    expect(items[0]!.error).toBeInstanceOf(InvalidOperationError);
    expect(items[0]!.error!.message).toBe('The file is still being imported');
    expect(items[1]!.error).toBeInstanceOf(InvalidOperationError);
    expect(items[1]!.error!.message).toBe('The file is already in the trash');
    expect(items[2]!.error).toBeInstanceOf(NotFoundError);
    expect(items[3]).toMatchObject({ error: null, file: { id: valid.id } });
    expect(items[3]!.file!.deletedAt).not.toBeNull();
    expect(db.files.records.get(pendingId)?.status).toBe('pending');
  });

  it('a failed file is removed outright with its leftover binary', async () => {
    const { session, storage, db, control } = await setup();
    const id = crypto.randomUUID();
    await db.files.insertPending({
      id,
      storageId: 's',
      originalName: 'f.png',
      relativePath: inboxPath(id, 'f.png'),
      mimeType: 'image/png',
      importedAt: TS,
      kind: 'image',
    });
    await db.files.markFailed(id, 'Import was interrupted');
    storage.files.set(stagingPath(id), Buffer.from('part'));
    storage.files.set(inboxPath(id, 'f.png'), Buffer.from('moved'));

    const items = await trashFiles(session, control, [id]);

    expect(items).toEqual([{ fileId: id, file: null, error: null }]);
    expect(db.files.records.has(id)).toBe(false);
    expect(storage.files.has(stagingPath(id))).toBe(false);
    expect(storage.files.has(inboxPath(id, 'f.png'))).toBe(false);
    expect(await storage.list(TRASH_DIR)).toEqual([]);
  });

  it('a complete file with a missing binary is trashed without a move', async () => {
    const { session, storage, db, importOne, control } = await setup();
    const file = await importOne('gone.png');
    storage.files.delete(file.relativePath);
    const move = vi.spyOn(storage, 'move');

    const [trashed] = ok(await trashFiles(session, control, [file.id]));

    expect(move).not.toHaveBeenCalled();
    expect(trashed!.relativePath).toBe(trashPath(file.id, 'gone.png'));
    expect(trashed!.deletedAt).not.toBeNull();

    const [restore] = await restoreFiles(session, [file.id]);
    expect(restore!.error).toBeInstanceOf(InvalidOperationError);
    expect(restore!.error!.message).toBe('The file is missing on disk and cannot be restored');
    expect(db.files.records.get(file.id)!.deletedAt).not.toBeNull();
    await expect(db.fileMoves.list()).resolves.toEqual([]);

    expect(await purgeFiles(session, control, [file.id])).toEqual([{ fileId: file.id, file: null, error: null }]);
    expect(db.files.records.has(file.id)).toBe(false);
  });

  it('an unreachable storage refuses trash, restore and purge', async () => {
    const { session, storage, db, importOne, control } = await setup();
    const trashed = await importOne('t.png');
    await trashFiles(session, control, [trashed.id]);
    const live = await importOne('l.png');
    const rowsBefore = structuredClone([...db.files.records.entries()]);
    const filesBefore = [...storage.files.keys()].sort();
    storage.reachable = false;

    const [t] = await trashFiles(session, control, [live.id]);
    const [r] = await restoreFiles(session, [trashed.id]);
    const [p] = await purgeFiles(session, control, [trashed.id]);

    for (const item of [t, r, p]) {
      expect(item!.error).toBeInstanceOf(StorageUnreachableError);
      expect(item!.error!.message).toBe('The storage of this workspace is not reachable');
      expect(item!.file).toBeNull();
    }
    expect([...db.files.records.entries()]).toEqual(rowsBefore);
    expect([...storage.files.keys()].sort()).toEqual(filesBefore);
  });

  it('a storage that drops inside exists refuses the trash, commits nothing and leaves no journal row', async () => {
    const { session, storage, db, importOne, control } = await setup();
    const file = await importOne('a.png');
    vi.spyOn(storage, 'exists').mockImplementationOnce(async () => {
      storage.reachable = false;
      return false;
    });

    const [item] = await trashFiles(session, control, [file.id]);

    expect(item!.error).toBeInstanceOf(StorageUnreachableError);
    expect(item!.file).toBeNull();
    expect(await db.files.get(file.id)).toEqual(file);
    expect(storage.files.has(file.relativePath)).toBe(true);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('a storage that drops inside exists refuses the restore with the storage error, not the missing message', async () => {
    const { session, storage, db, importOne, control } = await setup();
    const file = await importOne('a.png');
    const [trashed] = ok(await trashFiles(session, control, [file.id]));
    vi.spyOn(storage, 'exists').mockImplementationOnce(async () => {
      storage.reachable = false;
      return false;
    });

    const [item] = await restoreFiles(session, [file.id]);

    expect(item!.error).toBeInstanceOf(StorageUnreachableError);
    expect(item!.error!.message).toBe('The storage of this workspace is not reachable');
    expect(await db.files.get(file.id)).toEqual(trashed);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('a failing move aborts the journal and leaves the file where it was', async () => {
    const { session, storage, db, importOne, control } = await setup();
    const file = await importOne('a.png');
    storage.failNext('move', new Error('EBUSY: C:\\secret\\path'));

    const [item] = await trashFiles(session, control, [file.id]);

    expect(item!.error).toBeInstanceOf(InvalidOperationError);
    expect(item!.error!.message).toBe(
      'The file could not be moved; it may be in use, missing, or the target already exists',
    );
    expect(await db.files.get(file.id)).toEqual(file);
    expect(storage.files.has(file.relativePath)).toBe(true);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });
});

describe('purgeFiles', () => {
  it('purge removes the row and then the binary', async () => {
    const { session, storage, db, importOne, control } = await setup();
    const file = await importOne('a.png');
    await db.tags.addToFile({
      fileId: file.id,
      name: 'x',
      displayName: 'x',
      origin: 'manual',
      newId: crypto.randomUUID(),
      now: TS,
    });
    const [trashed] = ok(await trashFiles(session, control, [file.id]));
    const purge = vi.spyOn(db.files, 'purge');
    const remove = vi.spyOn(storage, 'remove');
    vi.spyOn(session, 'now').mockReturnValue(new Date('2030-01-01T00:00:00.000Z'));

    expect(await purgeFiles(session, control, [file.id])).toEqual([{ fileId: file.id, file: null, error: null }]);

    expect(db.files.records.has(file.id)).toBe(false);
    expect(db.tags.fileAssignments.filter((a) => a.fileId === file.id)).toEqual([]);
    expect(storage.files.has(trashed!.relativePath)).toBe(false);
    expect(remove).toHaveBeenCalledWith(trashed!.relativePath);
    // The tombstone carries the session clock, not a time the repository reads itself.
    expect(purge).toHaveBeenCalledWith(file.id, '2030-01-01T00:00:00.000Z');
    expect(purge.mock.invocationCallOrder[0]!).toBeLessThan(remove.mock.invocationCallOrder[0]!);
    expect(await trashCount(session)).toBe(0);
    // The tombstone written with the row deletion goes once the binary is gone.
    await expect(db.files.listPurgedIds()).resolves.toEqual([]);
  });

  it('removing a failed file outright leaves no tombstone', async () => {
    const { session, db, control } = await setup();
    const id = crypto.randomUUID();
    await db.files.insertPending({
      id,
      storageId: 's',
      originalName: 'f.png',
      relativePath: inboxPath(id, 'f.png'),
      mimeType: 'image/png',
      importedAt: TS,
      kind: 'image',
    });
    await db.files.markFailed(id, 'Import was interrupted');

    ok(await trashFiles(session, control, [id]));

    await expect(db.files.listPurgedIds()).resolves.toEqual([]);
  });

  it('purge of a live file is refused', async () => {
    const { session, storage, db, importOne, control } = await setup();
    const file = await importOne('a.png');
    const [item] = await purgeFiles(session, control, [file.id]);
    expect(item!.error).toBeInstanceOf(InvalidOperationError);
    expect(item!.error!.message).toBe('The file is not in the trash');
    expect(db.files.records.has(file.id)).toBe(true);
    expect(storage.files.has(file.relativePath)).toBe(true);

    const [unknown] = await purgeFiles(session, control, [UNKNOWN_ID]);
    expect(unknown!.error).toBeInstanceOf(NotFoundError);
  });

  it('purging a failed file that is a chosen cover clears the cover like the set null rule', async () => {
    const { db, asset, importOne } = await setup();
    const cover = await importOne('a.png', { assetId: asset.id, role: 'reference' });
    await db.assets.setCover(asset.id, cover.id, 'x');
    await db.files.markFailed(cover.id, 'Import was interrupted');
    expect(await db.files.purge(cover.id, '2026-01-01T00:00:00.000Z')).toBe(true);
    expect(await db.assets.getCover(asset.id)).toEqual({ coverFileId: null, coverIsChosen: false });
  });

  it('restore of a live file is refused and of an unknown id is not_found', async () => {
    const { session, importOne } = await setup();
    const file = await importOne('a.png');
    const [live, unknown] = await restoreFiles(session, [file.id, UNKNOWN_ID]);
    expect(live!.error!.message).toBe('The file is not in the trash');
    expect(live!.error).toBeInstanceOf(InvalidOperationError);
    expect(unknown!.error).toBeInstanceOf(NotFoundError);
  });

  it('purge cancels a still active job first', async () => {
    const { session, db, importOne, control } = await setup();
    const file = await importOne('a.png');
    await trashFiles(session, control, [file.id]);
    // A job that slipped in (a race): purge cancels it before the rows go.
    db.jobs.rows.push({
      id: 'late',
      type: 't',
      resourceClass: 'cpu',
      status: 'running',
      fileId: file.id,
      lane: null,
      payload: {},
      dedupeKey: null,
      attempt: 1,
      runAfter: null,
      errorCode: null,
      errorMessage: null,
      createdAt: TS,
      startedAt: TS,
      finishedAt: null,
      updatedAt: TS,
    });
    const purge = vi.spyOn(db.files, 'purge');
    const cancel = vi.spyOn(control, 'cancel');

    ok(await purgeFiles(session, control, [file.id]));

    expect(control.cancelled).toEqual(['late']);
    expect(cancel.mock.invocationCallOrder[0]!).toBeLessThan(purge.mock.invocationCallOrder[0]!);
    expect(db.jobs.rows.some((r) => r.fileId === file.id)).toBe(false);
  });

  it('purge never removes a path outside the trash directory', async () => {
    const { session, storage, db, importOne, control } = await setup();
    const file = await importOne('a.png');
    await trashFiles(session, control, [file.id]);
    const elsewhere = inboxPath(file.id, 'a.png');
    db.files.records.set(file.id, { ...db.files.records.get(file.id)!, relativePath: elsewhere });
    storage.files.set(elsewhere, Buffer.from('keep'));

    ok(await purgeFiles(session, control, [file.id]));

    expect(db.files.records.has(file.id)).toBe(false);
    expect(storage.files.has(elsewhere)).toBe(true);
  });

  it('a binary that cannot be removed still counts as purged', async () => {
    const { session, storage, db, importOne, control } = await setup();
    const file = await importOne('a.png');
    const [trashed] = ok(await trashFiles(session, control, [file.id]));
    storage.failNext('remove', new Error('EBUSY'));

    expect(await purgeFiles(session, control, [file.id])).toEqual([{ fileId: file.id, file: null, error: null }]);
    expect(db.files.records.has(file.id)).toBe(false);
    expect(storage.files.has(trashed!.relativePath)).toBe(true);
    // The tombstone stays, so the next sweep removes the binary and then the tombstone.
    await expect(db.files.listPurgedIds()).resolves.toEqual([file.id]);

    expect(await sweepTrash({ storage, files: db.files })).toEqual({ removed: [trashed!.relativePath], skipped: [] });
    expect(storage.files.has(trashed!.relativePath)).toBe(false);
    await expect(db.files.listPurgedIds()).resolves.toEqual([]);
  });

  it('a storage that drops inside remove keeps the tombstone for the sweep', async () => {
    const { session, storage, db, importOne, control } = await setup();
    const file = await importOne('a.png');
    const [trashed] = ok(await trashFiles(session, control, [file.id]));
    // A dropped share answers remove without an error and without removing anything.
    vi.spyOn(storage, 'remove').mockImplementationOnce(async () => {
      storage.reachable = false;
    });

    expect(await purgeFiles(session, control, [file.id])).toEqual([{ fileId: file.id, file: null, error: null }]);
    expect(storage.files.has(trashed!.relativePath)).toBe(true);
    await expect(db.files.listPurgedIds()).resolves.toEqual([file.id]);

    storage.reachable = true;
    expect(await sweepTrash({ storage, files: db.files })).toEqual({ removed: [trashed!.relativePath], skipped: [] });
  });

  it('a purge that loses a race to another purge answers not_found', async () => {
    const { session, db, importOne, control } = await setup();
    const file = await importOne('a.png');
    ok(await trashFiles(session, control, [file.id]));
    const purge = db.files.purge.bind(db.files);
    vi.spyOn(db.files, 'purge').mockImplementationOnce(async (id, purgedAt) => {
      // The other purge deletes the row first.
      await purge(id, purgedAt);
      return false;
    });

    const [item] = await purgeFiles(session, control, [file.id]);

    expect(item!.error).toBeInstanceOf(NotFoundError);
    expect(db.files.records.has(file.id)).toBe(false);
  });
});

describe('emptyTrash', () => {
  it('emptyTrash purges everything and reports purged and failed', async () => {
    const { session, storage, db, control } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 450; i++) {
      const id = crypto.randomUUID();
      await db.files.insertPending({
        id,
        storageId: 's',
        originalName: `${i}.png`,
        relativePath: inboxPath(id, `${i}.png`),
        mimeType: 'image/png',
        importedAt: TS,
        kind: 'image',
      });
      await db.files.markComplete(id, { sizeBytes: 1, sha256: 'b'.repeat(64), width: null, height: null });
      storage.files.set(inboxPath(id, `${i}.png`), Buffer.from(String(i)));
      ids.push(id);
    }
    for (let i = 0; i < ids.length; i += 200) ok(await trashFiles(session, control, ids.slice(i, i + 200)));
    expect(await trashCount(session)).toBe(450);
    const failing = ids[123]!;
    const original = db.files.purge.bind(db.files);
    vi.spyOn(db.files, 'purge').mockImplementation(async (id, purgedAt) => {
      if (id === failing) throw new Error('database is locked');
      return original(id, purgedAt);
    });

    expect(await emptyTrash(session, control)).toEqual({ purged: 449, failed: 1 });
    expect(await trashCount(session)).toBe(1);
    expect(await storage.list(TRASH_DIR)).toHaveLength(1);
  });

  it('hands each failure to onFailure and does not count a file another purge removed first', async () => {
    const { session, db, importOne, control } = await setup();
    const failing = await importOne('fail.png');
    const raced = await importOne('raced.png');
    const kept = await importOne('ok.png');
    ok(await trashFiles(session, control, [failing.id, raced.id, kept.id]));
    const original = db.files.purge.bind(db.files);
    vi.spyOn(db.files, 'purge').mockImplementation(async (id, purgedAt) => {
      if (id === failing.id) throw new Error('database is locked');
      if (id !== raced.id) return original(id, purgedAt);
      // Another purge won the race: the row is gone when this one runs.
      await original(id, purgedAt);
      return false;
    });
    const failures: [string, string][] = [];

    const result = await emptyTrash(session, control, (fileId, error) => failures.push([fileId, error.message]));

    expect(result).toEqual({ purged: 1, failed: 1 });
    expect(failures).toEqual([[failing.id, 'database is locked']]);
  });

  it('a throwing onFailure changes nothing', async () => {
    const { session, db, importOne, control } = await setup();
    const failing = await importOne('fail.png');
    ok(await trashFiles(session, control, [failing.id]));
    vi.spyOn(db.files, 'purge').mockRejectedValue(new Error('database is locked'));

    const result = await emptyTrash(session, control, () => {
      throw new Error('log failed');
    });

    expect(result).toEqual({ purged: 0, failed: 1 });
  });
});

describe('sweepTrash', () => {
  it('sweepTrash removes only binaries of tombstoned ids without a row and keeps the others', async () => {
    const { session, storage, db, importOne, control } = await setup();
    const trashed = await importOne('t.png');
    const [t] = ok(await trashFiles(session, control, [trashed.id]));
    const live = await importOne('l.png');
    const purged = `${TRASH_DIR}/${UNKNOWN_ID}_x.png`;
    const NO_TOMBSTONE = '88888888-8888-4888-8888-888888888888';
    const unknown = `${TRASH_DIR}/${NO_TOMBSTONE}_y.png`;
    const liveCopy = `${TRASH_DIR}/${live.id}_copy.png`;
    const notes = `${TRASH_DIR}/notes.txt`;
    for (const p of [purged, unknown, liveCopy, notes]) storage.files.set(p, Buffer.from(p));
    db.files.purged.add(UNKNOWN_ID);
    // A tombstone for an id that still has a row never removes its binaries.
    db.files.purged.add(trashed.id);

    const result = await sweepTrash({ storage, files: db.files });

    expect(result).toEqual({ removed: [purged], skipped: [] });
    expect(storage.files.has(purged)).toBe(false);
    expect(storage.files.has(unknown)).toBe(true);
    expect(storage.files.has(t!.relativePath)).toBe(true);
    expect(storage.files.has(liveCopy)).toBe(true);
    expect(storage.files.has(notes)).toBe(true);
    expect(await db.files.listPurgedIds()).not.toContain(UNKNOWN_ID);
  });

  it('a binary without a row and without a tombstone survives the sweep', async () => {
    const { storage, db } = await setup();
    const stray = `${TRASH_DIR}/${UNKNOWN_ID}_x.png`;
    storage.files.set(stray, Buffer.from('x'));

    expect(await sweepTrash({ storage, files: db.files })).toEqual({ removed: [], skipped: [] });
    expect(storage.files.has(stray)).toBe(true);
  });

  it('a tombstone whose binary is already gone is cleared on a reachable storage, kept on an unreachable one', async () => {
    const { storage, db } = await setup();
    db.files.purged.add(UNKNOWN_ID);
    storage.reachable = false;
    expect(await sweepTrash({ storage, files: db.files })).toEqual({ removed: [], skipped: [] });
    await expect(db.files.listPurgedIds()).resolves.toEqual([UNKNOWN_ID]);

    storage.reachable = true;
    expect(await sweepTrash({ storage, files: db.files })).toEqual({ removed: [], skipped: [] });
    await expect(db.files.listPurgedIds()).resolves.toEqual([]);
  });

  it('does nothing while the storage is unreachable', async () => {
    const { storage, db } = await setup();
    const purged = `${TRASH_DIR}/${UNKNOWN_ID}_x.png`;
    storage.files.set(purged, Buffer.from('x'));
    db.files.purged.add(UNKNOWN_ID);
    storage.reachable = false;
    const remove = vi.spyOn(storage, 'remove');

    expect(await sweepTrash({ storage, files: db.files })).toEqual({ removed: [], skipped: [] });
    expect(remove).not.toHaveBeenCalled();
    await expect(db.files.listPurgedIds()).resolves.toEqual([UNKNOWN_ID]);
  });

  it('reports a binary that cannot be removed, keeps its tombstone and never throws', async () => {
    const { storage, db } = await setup();
    const purged = `${TRASH_DIR}/${UNKNOWN_ID}_x.png`;
    storage.files.set(purged, Buffer.from('x'));
    db.files.purged.add(UNKNOWN_ID);
    storage.failNext('remove', new Error('EBUSY'));
    expect(await sweepTrash({ storage, files: db.files })).toEqual({ removed: [], skipped: [purged] });
    await expect(db.files.listPurgedIds()).resolves.toEqual([UNKNOWN_ID]);

    storage.failNext('list', new Error('EIO'));
    expect(await sweepTrash({ storage, files: db.files })).toEqual({ removed: [], skipped: [] });
    await expect(db.files.listPurgedIds()).resolves.toEqual([UNKNOWN_ID]);
  });
});

describe('an open move row before restore and purge', () => {
  /** A trashed inbox file whose restore moved the binary back but whose commit and its immediate resolve failed. */
  async function failedRestoreCommit() {
    const ctx = await setup();
    const { session, storage, db, importOne, control } = ctx;
    const file = await importOne('a.png');
    ok(await trashFiles(session, control, [file.id]));
    db.fileMoves.failCommits(2);
    const [failed] = await restoreFiles(session, [file.id]);
    expect(failed!.error).not.toBeNull();
    expect(db.files.records.get(file.id)!.deletedAt).not.toBeNull();
    expect(storage.files.has(inboxPath(file.id, 'a.png'))).toBe(true);
    await expect(db.fileMoves.list()).resolves.toHaveLength(1);
    return { ...ctx, file };
  }

  it('purge after a restore whose commit failed completes the restore instead of orphaning the binary', async () => {
    const { session, storage, db, file, control } = await failedRestoreCommit();

    const [item] = await purgeFiles(session, control, [file.id]);

    expect(item!.error).toBeInstanceOf(InvalidOperationError);
    expect(item!.error!.message).toBe('The file is not in the trash');
    expect(db.files.records.get(file.id)).toMatchObject({ relativePath: inboxPath(file.id, 'a.png'), deletedAt: null });
    expect(storage.files.has(inboxPath(file.id, 'a.png'))).toBe(true);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('empty trash after a restore whose commit failed completes the restore instead of orphaning the binary', async () => {
    const { session, storage, db, file, control } = await failedRestoreCommit();

    expect(await emptyTrash(session, control)).toEqual({ purged: 0, failed: 1 });

    expect(db.files.records.get(file.id)).toMatchObject({ relativePath: inboxPath(file.id, 'a.png'), deletedAt: null });
    expect(storage.files.has(inboxPath(file.id, 'a.png'))).toBe(true);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('a second restore after a failed commit completes the first one', async () => {
    const { session, storage, db, file } = await failedRestoreCommit();

    const [restored] = ok(await restoreFiles(session, [file.id]));

    expect(restored).toMatchObject({ id: file.id, relativePath: inboxPath(file.id, 'a.png'), deletedAt: null });
    expect(storage.files.has(inboxPath(file.id, 'a.png'))).toBe(true);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('purge with a move row that did not happen discards it and purges', async () => {
    const { session, storage, db, importOne, control } = await setup();
    const file = await importOne('a.png');
    const [trashed] = ok(await trashFiles(session, control, [file.id]));
    await db.fileMoves.begin({
      fileId: file.id,
      kind: 'restore',
      targetRelativePath: inboxPath(file.id, 'a.png'),
      targetAssetId: null,
      targetRole: null,
      createdAt: TS,
    });

    expect(await purgeFiles(session, control, [file.id])).toEqual([{ fileId: file.id, file: null, error: null }]);

    expect(db.files.records.has(file.id)).toBe(false);
    expect(storage.files.has(trashed!.relativePath)).toBe(false);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('purge is refused while the move row cannot be resolved; recovery then makes the file live', async () => {
    const { session, storage, db, file, control } = await failedRestoreCommit();
    db.fileMoves.failCommits(1);

    const [item] = await purgeFiles(session, control, [file.id]);

    expect(item!.error).not.toBeNull();
    expect(db.files.records.get(file.id)!.deletedAt).not.toBeNull();
    expect(storage.files.has(inboxPath(file.id, 'a.png'))).toBe(true);
    await expect(db.fileMoves.list()).resolves.toHaveLength(1);

    await recoverFileMoves({ storage, files: db.files, fileMoves: db.fileMoves });
    expect(db.files.records.get(file.id)).toMatchObject({ relativePath: inboxPath(file.id, 'a.png'), deletedAt: null });
  });

  it('a storage that drops while the move row is resolved keeps the row and refuses the purge', async () => {
    const { session, storage, db, file, control } = await failedRestoreCommit();
    vi.spyOn(storage, 'exists').mockImplementationOnce(async () => {
      storage.reachable = false;
      return false;
    });

    const [item] = await purgeFiles(session, control, [file.id]);

    expect(item!.error).toBeInstanceOf(StorageUnreachableError);
    expect(db.files.records.get(file.id)!.deletedAt).not.toBeNull();
    expect(storage.files.has(inboxPath(file.id, 'a.png'))).toBe(true);
    await expect(db.fileMoves.list()).resolves.toHaveLength(1);

    storage.reachable = true;
    await recoverFileMoves({ storage, files: db.files, fileMoves: db.fileMoves });
    expect(db.files.records.get(file.id)).toMatchObject({ relativePath: inboxPath(file.id, 'a.png'), deletedAt: null });
  });

  it('the repository refuses to purge a file with an open move row', async () => {
    const { db, session, importOne, control } = await setup();
    const file = await importOne('a.png');
    ok(await trashFiles(session, control, [file.id]));
    await db.fileMoves.begin({
      fileId: file.id,
      kind: 'restore',
      targetRelativePath: inboxPath(file.id, 'a.png'),
      targetAssetId: null,
      targetRole: null,
      createdAt: TS,
    });

    await expect(db.files.purge(file.id, '2026-01-01T00:00:00.000Z')).rejects.toThrow(
      new InvalidOperationError('The file is being moved'),
    );
    expect(db.files.records.has(file.id)).toBe(true);
    await expect(db.fileMoves.list()).resolves.toHaveLength(1);
  });
});

describe('relocate after restore', () => {
  it('a restored file can be placed again', async () => {
    const { session, asset, importOne, control } = await setup();
    const file = await importOne('a.png');
    await trashFiles(session, control, [file.id]);
    await restoreFiles(session, [file.id]);
    await expect(relocateFile(session, file.id, { assetId: asset.id, role: 'reference' })).resolves.toMatchObject({
      assetId: asset.id,
    });
  });
});
