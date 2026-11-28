import { describe, expect, it } from 'vitest';
import {
  assetFilePath,
  createAsset,
  inboxPath,
  InvalidOperationError,
  recoverFileMoves,
  relocateFile,
  restoreFiles,
  trashFiles,
  trashPath,
  WorkspaceManager,
  type FileBatchItem,
  type JobControl,
  type WorkspaceSession,
} from '../src/index.js';
import { MOVE_RESOLVE_FAILED_EVENT } from '../src/journaled-move.js';
import { createFakeHost } from './fakes.js';

const ROOT = '/ws/a';

/** A job control for a workspace without jobs. */
const NO_JOBS: JobControl = {
  wake: () => undefined,
  cancel: async () => undefined,
  cancelAll: async () => 0,
};

async function setup() {
  const fake = createFakeHost();
  const manager = new WorkspaceManager(fake.host);
  const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
  const storage = fake.storages.get(ROOT)!;
  const db = fake.databases.get(summary.id)!;
  const session: WorkspaceSession = await manager.read(async (s) => s);
  const typeId = (await db.assetTypes.list())[0]!.id;
  const asset = await createAsset(session, { name: 'Pump', typeId });
  fake.sources.set('/src/pump.png', Buffer.from('pump'));
  const [imported] = await manager.importFiles(['/src/pump.png']);
  const file = imported!.file!;
  return { storage, db, session, asset, file };
}

const only = (items: FileBatchItem[]): FileBatchItem => {
  expect(items).toHaveLength(1);
  return items[0]!;
};

describe('a journaled move whose commit fails', () => {
  it('relocate: the commit is retried at once, so row and binary agree and no move row is left', async () => {
    const { storage, db, session, asset, file } = await setup();
    db.fileMoves.failCommits(1);

    const placed = await relocateFile(session, file.id, { assetId: asset.id, role: 'reference' });

    const target = assetFilePath(asset.id, 'reference', file.id, 'pump.png');
    expect(placed).toMatchObject({ id: file.id, relativePath: target, assetId: asset.id, role: 'reference' });
    expect(db.files.records.get(file.id)).toEqual(placed);
    expect(storage.files.has(target)).toBe(true);
    expect(storage.files.has(file.relativePath)).toBe(false);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('trash: the commit is retried at once, so row and binary agree and no move row is left', async () => {
    const { storage, db, session, file } = await setup();
    db.fileMoves.failCommits(1);

    const item = only(await trashFiles(session, NO_JOBS, [file.id]));

    const target = trashPath(file.id, 'pump.png');
    expect(item.error).toBeNull();
    expect(item.file).toMatchObject({ relativePath: target });
    expect(db.files.records.get(file.id)!.deletedAt).not.toBeNull();
    expect(db.files.records.get(file.id)!.relativePath).toBe(target);
    expect(storage.files.has(target)).toBe(true);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('trash of a file whose binary is missing: a failed commit is retried at once', async () => {
    const { storage, db, session, file } = await setup();
    storage.files.delete(file.relativePath);
    db.fileMoves.failCommits(1);

    const item = only(await trashFiles(session, NO_JOBS, [file.id]));

    // The binary never moved, so the recovery rule discards the row; the trash then reports the commit's error.
    expect(item.error?.message).toBe('database is locked');
    expect(db.files.records.get(file.id)).toMatchObject({ relativePath: file.relativePath, deletedAt: null });
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('restore: the commit is retried at once, so row and binary agree and no move row is left', async () => {
    const { storage, db, session, file } = await setup();
    expect(only(await trashFiles(session, NO_JOBS, [file.id])).error).toBeNull();
    db.fileMoves.failCommits(1);

    const item = only(await restoreFiles(session, [file.id]));

    const target = inboxPath(file.id, 'pump.png');
    expect(item.error).toBeNull();
    expect(item.file).toMatchObject({ relativePath: target, deletedAt: null });
    expect(db.files.records.get(file.id)).toMatchObject({ relativePath: target, deletedAt: null });
    expect(storage.files.has(target)).toBe(true);
    expect(storage.files.has(trashPath(file.id, 'pump.png'))).toBe(false);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('a commit and its resolve both failing keep the move row, and the recovery on open repairs it', async () => {
    const { storage, db, session, asset, file } = await setup();
    db.fileMoves.failCommits(2);

    await expect(relocateFile(session, file.id, { assetId: asset.id, role: 'reference' })).rejects.toThrow(
      'database is locked',
    );

    const target = assetFilePath(asset.id, 'reference', file.id, 'pump.png');
    expect(db.files.records.get(file.id)!.relativePath).toBe(file.relativePath);
    expect(storage.files.has(target)).toBe(true);
    await expect(db.fileMoves.list()).resolves.toHaveLength(1);

    expect(await recoverFileMoves({ storage, files: db.files, fileMoves: db.fileMoves })).toEqual({
      completed: [file.id],
      discarded: [],
    });
    expect(db.files.records.get(file.id)).toMatchObject({ relativePath: target, assetId: asset.id });
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('a commit refused for its kind moves the binary back, drops the row and reports the refusal', async () => {
    const { storage, db, session, asset, file } = await setup();
    const refusal = new InvalidOperationError('The file is in the trash');
    db.fileMoves.failCommits(2, refusal);

    await expect(relocateFile(session, file.id, { assetId: asset.id, role: 'reference' })).rejects.toBe(refusal);

    expect(db.files.records.get(file.id)).toMatchObject({ relativePath: file.relativePath, assetId: null });
    expect(storage.files.has(file.relativePath)).toBe(true);
    expect(storage.files.has(assetFilePath(asset.id, 'reference', file.id, 'pump.png'))).toBe(false);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });

  it('a resolve that cannot reach the storage keeps the row for the next open', async () => {
    const { storage, db, session, asset, file } = await setup();
    db.fileMoves.failCommits(1);
    storage.failNext('exists', new Error('EIO'));

    await expect(relocateFile(session, file.id, { assetId: asset.id, role: 'reference' })).rejects.toThrow(
      'database is locked',
    );

    await expect(db.fileMoves.list()).resolves.toHaveLength(1);
    await recoverFileMoves({ storage, files: db.files, fileMoves: db.fileMoves });
    expect(db.files.records.get(file.id)!.relativePath).toBe(assetFilePath(asset.id, 'reference', file.id, 'pump.png'));
    await expect(db.fileMoves.list()).resolves.toEqual([]);
  });
});

describe('the log of a failed immediate resolve', () => {
  const MARKER = 'SECRET_PATH_MARKER';

  /**
   * A workspace under a marked root whose host log collects lines or throws.
   *
   * @param log the host log
   * @returns the pieces a relocate test needs
   */
  async function setupWithLog(log: (line: string) => void) {
    const fake = createFakeHost();
    fake.host.log = log;
    const manager = new WorkspaceManager(fake.host);
    const summary = await manager.create({ name: 'Demo', rootPath: `/ws/${MARKER}` });
    const storage = fake.storages.get(`/ws/${MARKER}`)!;
    const db = fake.databases.get(summary.id)!;
    const session: WorkspaceSession = await manager.read(async (s) => s);
    const typeId = (await db.assetTypes.list())[0]!.id;
    const asset = await createAsset(session, { name: 'Pump', typeId });
    fake.sources.set('/src/pump.png', Buffer.from('pump'));
    const [imported] = await manager.importFiles(['/src/pump.png']);
    return { storage, db, session, asset, file: imported!.file! };
  }

  it('writes one line with the file id and no path', async () => {
    const lines: string[] = [];
    const { storage, db, session, asset, file } = await setupWithLog((line) => lines.push(line));
    db.fileMoves.failCommits(1);
    storage.failNext('exists', new Error(`EIO /data/${MARKER}/a.png`));

    await expect(relocateFile(session, file.id, { assetId: asset.id, role: 'reference' })).rejects.toThrow(
      'database is locked',
    );

    const resolveLines = lines.filter((line) => line.startsWith(MOVE_RESOLVE_FAILED_EVENT));
    expect(resolveLines).toHaveLength(1);
    expect(resolveLines[0]).toContain(`file=${file.id}`);
    for (const line of lines) expect(line).not.toContain(MARKER);
  });

  it('a log that throws does not change the outcome', async () => {
    const { storage, db, session, asset, file } = await setupWithLog(() => {
      throw new Error('log is broken');
    });
    db.fileMoves.failCommits(1);
    storage.failNext('exists', new Error('EIO'));

    await expect(relocateFile(session, file.id, { assetId: asset.id, role: 'reference' })).rejects.toThrow(
      'database is locked',
    );
    await expect(db.fileMoves.list()).resolves.toHaveLength(1);
  });
});
