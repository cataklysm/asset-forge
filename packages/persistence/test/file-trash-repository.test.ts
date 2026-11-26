import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Asset, FileKind, FileRole } from '@assetforge/contracts';
import { BUILT_IN_ASSET_TYPES, type FileMove, type WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const TS = '2026-01-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STORAGE = uuid(1);
const TYPE_ID = uuid(2);
const PUMP = uuid(3);
const MOTEL = uuid(4);
const SHA = 'a'.repeat(64);

let dir: string;
let db: WorkspaceDatabase;
let handle: Database.Database;
let nextId = 5000;
const newId = () => uuid(nextId++);
let minute = 0;

const asset = (id: string, name: string): Asset => ({
  id,
  name,
  typeId: TYPE_ID,
  description: '',
  status: 'draft',
  createdAt: TS,
  updatedAt: TS,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-trash-'));
  const pragma = vi.spyOn(Database.prototype, 'pragma');
  try {
    db = await openWorkspaceDatabase(join(dir, 'ws.db'), MIGRATIONS_FOLDER);
    handle = pragma.mock.contexts[0] as Database.Database;
  } finally {
    pragma.mockRestore();
  }
  await db.storages.ensurePrimary({ id: STORAGE, createdAt: TS });
  await db.assetTypes.insertMissing([
    { id: TYPE_ID, key: BUILT_IN_ASSET_TYPES[0]!.key, name: 'T', sortOrder: 0, builtIn: true, defaultWorkflowTemplateId: null },
  ]);
  await db.assets.insert(asset(PUMP, 'Pump'));
  await db.assets.insert(asset(MOTEL, 'Motel'));
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

/** A complete file, newer than every file added before it; in an asset when `placement` is given. */
async function addFile(
  originalName: string,
  placement?: { assetId: string; role: FileRole },
  o: { kind?: FileKind; complete?: boolean } = {},
): Promise<string> {
  const id = newId();
  const importedAt = new Date(Date.UTC(2026, 0, 1, 0, minute++)).toISOString();
  await db.files.insertPending({
    id,
    storageId: STORAGE,
    originalName,
    relativePath: `inbox/${id}/${originalName}`,
    mimeType: 'image/png',
    importedAt,
    kind: o.kind ?? 'image',
  });
  if (o.complete !== false) await db.files.markComplete(id, { sizeBytes: 1, sha256: SHA, width: null, height: null });
  if (placement) await db.files.setPlacement(id, { relativePath: `assets/${placement.assetId}/${id}_${originalName}`, ...placement });
  return id;
}

const trashMove = (fileId: string, createdAt = '2026-02-01T00:00:00.000Z'): FileMove => ({
  fileId,
  kind: 'trash',
  targetRelativePath: `.assetforge/trash/${fileId}_f.png`,
  targetAssetId: null,
  targetRole: null,
  createdAt,
});

async function trash(fileId: string, createdAt?: string) {
  await db.fileMoves.begin(trashMove(fileId, createdAt));
  return db.fileMoves.commit(fileId);
}

async function restore(fileId: string, target: { assetId: string; role: FileRole } | null) {
  await db.fileMoves.begin({
    fileId,
    kind: 'restore',
    targetRelativePath: target ? `assets/${target.assetId}/${fileId}_f.png` : `inbox/${fileId}/f.png`,
    targetAssetId: target?.assetId ?? null,
    targetRole: target?.role ?? null,
    createdAt: '2026-03-01T00:00:00.000Z',
  });
  return db.fileMoves.commit(fileId);
}

const tagFile = (fileId: string, name: string) =>
  db.tags.addToFile({ fileId, name, displayName: name, origin: 'manual', newId: newId(), now: TS });
const rows = (statement: string, ...params: unknown[]) => handle.prepare(statement).all(...params);
const countOf = (table: string, fileId: string) =>
  (handle.prepare(`select count(*) as n from ${table} where file_id = ?`).get(fileId) as { n: number }).n;
const coverOf = (assetId: string) =>
  (handle.prepare('select cover_file_id as c from asset where id = ?').get(assetId) as { c: string | null }).c;
const ids = async (scope: Parameters<WorkspaceDatabase['files']['list']>[0]['scope'], o: object = {}) => {
  const list = await db.files.list({ limit: 60, offset: 0, scope, ...o });
  return { ids: list.items.map((f) => f.id), total: list.total };
};

/** No row in the trash keeps an asset or a role. */
function expectInvariant(): void {
  expect(rows('select id from file where deleted_at is not null and (asset_id is not null or role is not null)')).toEqual([]);
}

describe('file trash repository', () => {
  test('commit of a trash move records the origin and clears the placement', async () => {
    const f = await addFile('f.png', { assetId: PUMP, role: 'texture' });
    const committed = await trash(f, '2026-02-03T00:00:00.000Z');
    expect(committed).toMatchObject({
      assetId: null,
      role: null,
      deletedAt: '2026-02-03T00:00:00.000Z',
      trashedAssetId: PUMP,
      trashedRole: 'texture',
      trashedAssetName: 'Pump',
      relativePath: `.assetforge/trash/${f}_f.png`,
      status: 'complete',
      openable: false,
    });
    await expect(db.files.get(f)).resolves.toEqual(committed);
    await expect(db.fileMoves.list()).resolves.toEqual([]);
    expectInvariant();
  });

  test('trashing the chosen cover clears it', async () => {
    const f = await addFile('f.png', { assetId: PUMP, role: 'reference' });
    await db.assets.setCover(PUMP, f, TS);
    expect(coverOf(PUMP)).toBe(f);
    await trash(f);
    expect(coverOf(PUMP)).toBeNull();
  });

  test("trashing removes the file name from the asset's search index", async () => {
    const f = await addFile('zebracrossing.png', { assetId: PUMP, role: 'reference' });
    const found = async () => (await db.assets.list({ limit: 10, offset: 0, query: 'zebracrossing' })).items.map((a) => a.id);
    await expect(found()).resolves.toEqual([PUMP]);
    await trash(f);
    await expect(found()).resolves.toEqual([]);
    await restore(f, { assetId: PUMP, role: 'reference' });
    await expect(found()).resolves.toEqual([PUMP]);
  });

  test('commit of a restore move puts the file back and clears the trash columns', async () => {
    const f = await addFile('f.png', { assetId: PUMP, role: 'texture' });
    await db.assets.setCover(PUMP, f, TS);
    await trash(f);
    const restored = await restore(f, { assetId: PUMP, role: 'texture' });
    expect(restored).toMatchObject({
      assetId: PUMP,
      role: 'texture',
      deletedAt: null,
      trashedAssetId: null,
      trashedRole: null,
      trashedAssetName: null,
      relativePath: `assets/${PUMP}/${f}_f.png`,
      openable: true,
    });
    await expect(db.fileMoves.list()).resolves.toEqual([]);
    expect(coverOf(PUMP)).toBeNull();
    expect((await db.assets.list({ limit: 10, offset: 0 })).items.find((a) => a.id === PUMP)?.fileCount).toBe(1);
  });

  test('an inbox file is trashed with a null origin and restored to the inbox', async () => {
    const f = await addFile('f.png');
    await expect(trash(f)).resolves.toMatchObject({ assetId: null, role: null, trashedAssetId: null, trashedRole: null, trashedAssetName: null });
    await expect(ids({ kind: 'inbox' })).resolves.toEqual({ ids: [], total: 0 });
    await expect(restore(f, null)).resolves.toMatchObject({ assetId: null, role: null, deletedAt: null, relativePath: `inbox/${f}/f.png` });
    await expect(ids({ kind: 'inbox' })).resolves.toEqual({ ids: [f], total: 1 });
    expectInvariant();
  });

  test('deleting the asset of a trashed file nulls trashed_asset_id', async () => {
    const f = await addFile('f.png', { assetId: MOTEL, role: 'reference' });
    await trash(f);
    expect(handle.pragma('foreign_keys', { simple: true })).toBe(1);
    handle.prepare('delete from asset_search_map where asset_id = ?').run(MOTEL);
    handle.prepare('delete from asset where id = ?').run(MOTEL);
    await expect(db.files.get(f)).resolves.toMatchObject({ trashedAssetId: null, trashedAssetName: null, trashedRole: 'reference' });
  });

  test('scope all, inbox and asset exclude a trashed file; scope trash lists only trashed files, newest deletion first', async () => {
    const older = await addFile('older.png', { assetId: PUMP, role: 'reference' });
    const newer = await addFile('newer.png');
    const inbox = await addFile('inbox.png');
    const live = await addFile('live.png', { assetId: PUMP, role: 'reference' });
    // Deleted in the reverse order of import, so the trash order is not the import order.
    await trash(newer, '2026-02-01T00:00:00.000Z');
    await trash(older, '2026-02-02T00:00:00.000Z');

    await expect(ids({ kind: 'all' })).resolves.toEqual({ ids: [live, inbox], total: 2 });
    await expect(ids({ kind: 'inbox' })).resolves.toEqual({ ids: [inbox], total: 1 });
    await expect(ids({ kind: 'asset', assetId: PUMP })).resolves.toEqual({ ids: [live], total: 1 });
    await expect(ids({ kind: 'trash' })).resolves.toEqual({ ids: [older, newer], total: 2 });
    await expect(db.files.list({ limit: 1, offset: 1, scope: { kind: 'trash' } })).resolves.toMatchObject({
      items: [{ id: newer }],
      total: 2,
    });
  });

  test('scope trash honours query, tagNames and kind', async () => {
    const tex = await addFile('rusty-door.png', { assetId: PUMP, role: 'texture' });
    const mesh = await addFile('rusty-mesh.glb', undefined, { kind: 'model' });
    const other = await addFile('clean.png');
    await addFile('rusty-live.png');
    await tagFile(tex, 'metal');
    await tagFile(other, 'metal');
    // The proposal is made before the trash; a trashed file takes no new one.
    await db.analyses.propose({
      fileId: other,
      sha256: SHA,
      provider: 'ollama',
      model: 'qwen',
      promptVersion: 1,
      tags: [{ name: 'x', displayName: 'x' }],
      createdAt: TS,
    });
    for (const f of [tex, mesh, other]) await trash(f);

    const trashScope = { kind: 'trash' } as const;
    await expect(ids(trashScope, { query: 'rusty' })).resolves.toMatchObject({ total: 2 });
    expect((await ids(trashScope, { query: 'rusty' })).ids.sort()).toEqual([tex, mesh].sort());
    expect((await ids(trashScope, { tagNames: ['metal'] })).ids.sort()).toEqual([tex, other].sort());
    await expect(ids(trashScope, { query: 'rusty', tagNames: ['metal'] })).resolves.toEqual({ ids: [tex], total: 1 });
    await expect(ids(trashScope, { kind: 'model' })).resolves.toEqual({ ids: [mesh], total: 1 });
    await expect(ids(trashScope, { hasProposal: true })).resolves.toEqual({ ids: [other], total: 1 });
    // A trashed file has no role any more, so a role filter finds nothing in the trash.
    await expect(ids(trashScope, { role: 'texture' })).resolves.toEqual({ ids: [], total: 0 });
  });

  test('findCompleteBySha256 ignores a trashed file', async () => {
    const a = await addFile('a.png');
    const b = await addFile('b.png', { assetId: PUMP, role: 'reference' });
    await trash(a);
    expect((await db.files.findCompleteBySha256(SHA)).map((f) => f.id)).toEqual([b]);
  });

  test('purge removes the row with its tags, analysis, proposal and jobs', async () => {
    expect(handle.pragma('foreign_keys', { simple: true })).toBe(1);
    const seedDependents = async (f: string) => {
      await tagFile(f, 'metal');
      await db.analyses.apply({
        fileId: f,
        sha256: SHA,
        tags: [{ name: 'rust', displayName: 'rust', newId: newId() }],
        provider: 'ollama',
        model: 'qwen',
        promptVersion: 1,
        now: TS,
      });
      await db.analyses.propose({
        fileId: f,
        sha256: SHA,
        provider: 'ollama',
        model: 'qwen',
        promptVersion: 1,
        tags: [{ name: 'x', displayName: 'x' }],
        createdAt: TS,
      });
      await db.jobs.enqueue({
        jobs: [
          { id: newId(), type: 'vision.analyze_file', resourceClass: 'local_gpu', fileId: f, payload: { version: 1 }, dedupeKey: null },
        ],
        now: TS,
      });
    };
    const doomed = await addFile('doomed.png', { assetId: PUMP, role: 'reference' });
    const kept = await addFile('kept.png');
    await seedDependents(doomed);
    await seedDependents(kept);
    await trash(doomed);

    await expect(db.files.purge(doomed)).resolves.toBe(true);
    await expect(db.files.get(doomed)).resolves.toBeNull();
    for (const table of ['file_tag', 'file_analysis', 'file_analysis_proposal', 'job']) {
      expect({ table, n: countOf(table, doomed) }).toEqual({ table, n: 0 });
    }
    expect(countOf('file_tag', kept)).toBe(2);
    expect(countOf('file_analysis', kept)).toBe(1);
    expect(countOf('file_analysis_proposal', kept)).toBe(1);
    expect(countOf('job', kept)).toBe(1);
    await expect(db.files.get(kept)).resolves.toMatchObject({ id: kept });
  });

  test('purge refuses a file with an open move row and deletes nothing', async () => {
    const f = await addFile('moving.png', { assetId: PUMP, role: 'reference' });
    await tagFile(f, 'metal');
    await trash(f);
    // A move row left behind by a restore whose commit failed.
    await db.fileMoves.begin({ ...trashMove(f), kind: 'restore' });

    await expect(db.files.purge(f)).rejects.toMatchObject({ code: 'invalid_operation', message: 'The file is being moved' });
    await expect(db.files.get(f)).resolves.toMatchObject({ id: f });
    expect(countOf('file_tag', f)).toBe(1);
    expect(countOf('file_move', f)).toBe(1);
  });

  test('purge refuses a live complete file and an unknown id', async () => {
    const live = await addFile('live.png', { assetId: PUMP, role: 'reference' });
    const pending = await addFile('pending.png', undefined, { complete: false });
    await tagFile(live, 'metal');
    await expect(db.files.purge(live)).resolves.toBe(false);
    await expect(db.files.purge(pending)).resolves.toBe(false);
    await expect(db.files.purge(uuid(999))).resolves.toBe(false);
    await expect(db.files.get(live)).resolves.toMatchObject({ tags: [{ name: 'metal' }] });
    await expect(db.files.get(pending)).resolves.toMatchObject({ status: 'pending' });
  });

  test('purge removes a failed file that was never trashed', async () => {
    const f = await addFile('broken.png', undefined, { complete: false });
    await db.files.markFailed(f, 'The file could not be imported');
    await expect(db.files.purge(f)).resolves.toBe(true);
    await expect(db.files.get(f)).resolves.toBeNull();
  });

  test('countTrashed and listTrashedIds', async () => {
    await expect(db.files.countTrashed()).resolves.toBe(0);
    await expect(db.files.listTrashedIds()).resolves.toEqual([]);
    const a = await addFile('a.png');
    const b = await addFile('b.png', { assetId: PUMP, role: 'reference' });
    await addFile('c.png');
    const failed = await addFile('d.png', undefined, { complete: false });
    await db.files.markFailed(failed, 'The file could not be imported');
    await trash(b, '2026-02-01T00:00:00.000Z');
    await trash(a, '2026-02-02T00:00:00.000Z');
    await expect(db.files.countTrashed()).resolves.toBe(2);
    await expect(db.files.listTrashedIds()).resolves.toEqual([a, b]);
  });

  test('the invariant holds for every trashed row', async () => {
    const inAsset = await addFile('a.png', { assetId: PUMP, role: 'texture' });
    const inInbox = await addFile('b.png');
    const back = await addFile('c.png', { assetId: MOTEL, role: 'model' });
    const cover = await addFile('d.png', { assetId: MOTEL, role: 'reference' });
    await db.assets.setCover(MOTEL, cover, TS);
    for (const f of [inAsset, inInbox, back, cover]) await trash(f);
    expectInvariant();
    await restore(back, { assetId: MOTEL, role: 'model' });
    await trash(back);
    await restore(inInbox, null);
    expectInvariant();
    expect(rows('select count(*) as n from file where deleted_at is not null')).toEqual([{ n: 3 }]);
  });
});

describe('trash invariant guards', () => {
  const fileRow = (id: string) => handle.prepare('select * from file where id = ?').get(id);
  const moveRow = (id: string) => handle.prepare('select * from file_move where file_id = ?').get(id);

  /** Begins `move`, expects its commit to be refused with `message`, and checks that nothing changed. */
  async function expectRefusedCommit(move: FileMove, message: string): Promise<void> {
    await db.fileMoves.begin(move);
    const before = { file: fileRow(move.fileId), move: moveRow(move.fileId) };
    await expect(db.fileMoves.commit(move.fileId)).rejects.toMatchObject({ code: 'invalid_operation', message });
    // The journal row stays for a later decision and the file row is untouched.
    expect({ file: fileRow(move.fileId), move: moveRow(move.fileId) }).toEqual(before);
    expect(before.move).toBeDefined();
    expectInvariant();
  }

  test('a relocate commit on a trashed file is refused', async () => {
    const f = await addFile('f.png', { assetId: PUMP, role: 'texture' });
    await trash(f);
    await expectRefusedCommit(
      {
        fileId: f,
        kind: 'relocate',
        targetRelativePath: `assets/${MOTEL}/${f}_f.png`,
        targetAssetId: MOTEL,
        targetRole: 'reference',
        createdAt: '2026-03-01T00:00:00.000Z',
      },
      'The file is in the trash',
    );
    expect((await ids({ kind: 'asset', assetId: MOTEL })).total).toBe(0);
  });

  test('a trash commit on a file already in the trash is refused and keeps its origin', async () => {
    const f = await addFile('f.png', { assetId: PUMP, role: 'texture' });
    await trash(f);
    await expectRefusedCommit(trashMove(f, '2026-04-01T00:00:00.000Z'), 'The file is already in the trash');
    expect(await db.files.get(f)).toMatchObject({ trashedAssetId: PUMP, trashedRole: 'texture', deletedAt: '2026-02-01T00:00:00.000Z' });
  });

  test('a restore commit on a live file is refused', async () => {
    const f = await addFile('f.png', { assetId: PUMP, role: 'texture' });
    await expectRefusedCommit(
      {
        fileId: f,
        kind: 'restore',
        targetRelativePath: `assets/${MOTEL}/${f}_f.png`,
        targetAssetId: MOTEL,
        targetRole: 'reference',
        createdAt: '2026-03-01T00:00:00.000Z',
      },
      'The file is not in the trash',
    );
  });

  test('setPlacement on a trashed file is refused and changes nothing', async () => {
    const f = await addFile('f.png', { assetId: PUMP, role: 'texture' });
    await trash(f);
    const before = fileRow(f);
    await expect(
      db.files.setPlacement(f, { relativePath: `assets/${MOTEL}/${f}_f.png`, assetId: MOTEL, role: 'reference' }),
    ).rejects.toMatchObject({ code: 'invalid_operation', message: 'The file is in the trash' });
    expect(fileRow(f)).toEqual(before);
    expectInvariant();
  });

  test('the legitimate commits of recovery still go through', async () => {
    // An interrupted trash move finds a live row, an interrupted restore a trashed one.
    const live = await addFile('live.png', { assetId: PUMP, role: 'texture' });
    await db.fileMoves.begin(trashMove(live));
    await expect(db.fileMoves.commit(live)).resolves.toMatchObject({ deletedAt: '2026-02-01T00:00:00.000Z', trashedAssetId: PUMP });
    await expect(restore(live, { assetId: PUMP, role: 'texture' })).resolves.toMatchObject({ assetId: PUMP, deletedAt: null });
    expect(moveRow(live)).toBeUndefined();
    expectInvariant();
  });
});
