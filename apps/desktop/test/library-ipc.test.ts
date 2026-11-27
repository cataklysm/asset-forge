import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcContract, type IpcChannel } from '@assetforge/contracts';
import { assetFilePath, TRASH_DIR, trashPath, type WorkspaceManager } from '@assetforge/core';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { createWorkspaceManager } from '../src/main/composition.js';
import { createWorkspaceHandlers, dispatch, type IpcHandlers } from '../src/main/ipc.js';
import { idleJobHost, idleServices, noopHost } from './idle-job-host.js';

let base: string;
let manager: WorkspaceManager;
let handlers: IpcHandlers;
const measure = vi.fn(async (_path: string): Promise<{ width: number; height: number } | null> => null);
const confirmWorkflow = vi.fn(async (_assetName: string) => false);
const openExternal = vi.fn(async (_url: string): Promise<void> => {});

const uuid = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';

// The desktop package has no type declarations for better-sqlite3; this is the used subset.
const Database = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => {
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
};

beforeEach(async () => {
  confirmWorkflow.mockClear();
  openExternal.mockReset();
  openExternal.mockResolvedValue(undefined);
  measure.mockReset();
  measure.mockResolvedValue(null);
  base = await mkdtemp(join(tmpdir(), 'af-lib-ipc-'));
  manager = createWorkspaceManager({ userDataPath: join(base, 'userData'), migrationsFolder: MIGRATIONS_FOLDER,
    imageProbe: { measure },
  });
  handlers = createWorkspaceHandlers(manager, {
    pickDirectory: async () => null,
    pickFiles: async () => [],
    confirmRemoveWorkspace: async () => 'cancel',
    confirmRemoveWorkflow: confirmWorkflow,
  }, { ...noopHost, openExternal }, idleJobHost, idleServices);
});
afterEach(async () => {
  await manager.close();
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

async function call(channel: IpcChannel, request: unknown) {
  return dispatch(handlers, channel, request);
}

async function ok<T = any>(channel: IpcChannel, request: unknown): Promise<T> {
  const result = await call(channel, request);
  if (!result.ok) throw new Error(`${channel} failed: ${result.error.code}`);
  return result.value as T;
}

async function openWorkspace() {
  await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
}

const page = { limit: 10, offset: 0 };

describe('library IPC', () => {
  it('returns no_workspace_open for every library channel when nothing is open', async () => {
    const requests: Partial<Record<IpcChannel, unknown>> = {
      'assetTypes:list': {},
      'projects:list': page,
      'projects:get': { id: uuid },
      'projects:create': { name: 'P' },
      'projects:update': { id: uuid, patch: { name: 'Q' } },
      'assets:list': page,
      'assets:get': { id: uuid },
      'assets:create': { name: 'A', typeId: uuid },
      'assets:update': { id: uuid, patch: { name: 'B' } },
      'assignments:listByAsset': { assetId: uuid },
      'assignments:listByProject': { ...page, projectId: uuid },
      'assignments:assign': { projectId: uuid, assetId: uuid },
      'assignments:update': { projectId: uuid, assetId: uuid, patch: { priority: 'high' } },
      'assignments:remove': { projectId: uuid, assetId: uuid },
      'relations:list': { assetId: uuid },
      'relations:add': { fromAssetId: uuid, toAssetId: uuid, kind: 'uses' },
      'relations:remove': { fromAssetId: uuid, toAssetId: uuid, kind: 'uses' },
      'files:list': { ...page, scope: { kind: 'inbox' } },
      'files:import': { sourcePaths: [join(base, 'x.png')] },
      'files:assign': { fileId: uuid, assetId: uuid, role: 'reference' },
      'files:unassign': { fileId: uuid },
      'assets:setCover': { assetId: uuid, fileId: null },
      'files:measure': { fileId: uuid },
      'files:openExternal': { fileId: uuid },
      'files:showInFolder': { fileId: uuid },
      'tags:suggest': { prefix: 'me', limit: 10 },
      'assets:addTag': { assetId: uuid, name: 'metal' },
      'assets:removeTag': { assetId: uuid, name: 'metal' },
      'files:addTag': { fileId: uuid, name: 'metal' },
      'files:removeTag': { fileId: uuid, name: 'metal' },
      'files:assignMany': { fileIds: [uuid], assetId: uuid, role: 'reference' },
      'files:addTagMany': { fileIds: [uuid], name: 'metal' },
      'files:removeTagMany': { fileIds: [uuid], name: 'metal' },
      'tags:usage': { name: 'metal' },
      'tags:rename': { from: 'metal', to: 'steel', merge: false },
      'assets:addSource': { assetId: uuid, url: 'https://example.org/' },
      'assets:removeSource': { assetId: uuid, sourceId: uuid },
      'assets:openSource': { assetId: uuid, sourceId: uuid },
    };
    expect(Object.keys(requests)).toHaveLength(38);
    for (const [channel, request] of Object.entries(requests)) {
      expect(ipcContract[channel as IpcChannel].request.safeParse(request).success, channel).toBe(true);
      expect(await call(channel as IpcChannel, request), channel).toMatchObject({
        ok: false,
        error: { code: 'no_workspace_open' },
      });
    }
  });

  it('creates and lists an asset through IPC', async () => {
    await openWorkspace();
    const types = await ok<{ id: string; key: string }[]>('assetTypes:list', {});
    const typeId = types.find((t) => t.key === 'character')!.id;
    const created = await ok('assets:create', { name: ' Pump ', typeId });
    expect(created).toMatchObject({ name: 'Pump', typeId, status: 'draft' });

    const listed = await ok('assets:list', { ...page, query: 'pum' });
    expect(ipcContract['assets:list'].response.safeParse(listed).success).toBe(true);
    expect(listed.items).toMatchObject([{ id: created.id, projectCount: 0, fileCount: 0 }]);

    // A query without words is dropped, so it does not narrow the list.
    const symbols = await ok('assets:list', { ...page, query: '%' });
    expect(symbols.total).toBe(1);
  });

  it('assets:list rejects more than 10 tag names', async () => {
    await openWorkspace();
    const tagNames = Array.from({ length: 11 }, (_, i) => `t${i}`);
    expect(await call('assets:list', { ...page, tagNames })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('assets:list rejects an unknown file kind', async () => {
    await openWorkspace();
    expect(await call('assets:list', { ...page, fileKind: 'spreadsheet' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('projects:list rejects 11 tag names and an unknown status', async () => {
    await openWorkspace();
    const invalid = { ok: false, error: { code: 'invalid_request' } };
    const tagNames = Array.from({ length: 11 }, (_, i) => `t${i}`);
    expect(await call('projects:list', { ...page, tagNames })).toMatchObject(invalid);
    expect(await call('projects:list', { ...page, status: 'paused' })).toMatchObject(invalid);
  });

  it('projects:list returns imageCount and filters by query, status and tags', async () => {
    await openWorkspace();
    const created = await ok('projects:create', { name: 'Forest', description: 'Älter Wald' });
    await ok('projects:create', { name: 'Desert' });

    const all = await ok('projects:list', { limit: 200, offset: 0 });
    expect(ipcContract['projects:list'].response.safeParse(all).success).toBe(true);
    expect(all.items).toMatchObject([
      { name: 'Desert', assetCount: 0, imageCount: 0 },
      { name: 'Forest', assetCount: 0, imageCount: 0 },
    ]);
    expect(all.items[0]).not.toHaveProperty('matchedTags');

    const byQuery = await ok('projects:list', { ...page, query: 'alter', status: 'active' });
    expect(byQuery.items.map((p: { id: string }) => p.id)).toEqual([created.id]);

    const types = await ok<{ id: string }[]>('assetTypes:list', {});
    const assetId = (await ok('assets:create', { name: 'Oak', typeId: types[0]!.id })).id;
    await ok('assignments:assign', { projectId: created.id, assetId });
    await ok('assets:addTag', { assetId, name: 'Oak' });
    const byTag = await ok('projects:list', { ...page, tagNames: ['OAK'] });
    expect(ipcContract['projects:list'].response.safeParse(byTag).success).toBe(true);
    expect(byTag.items).toMatchObject([
      { id: created.id, assetCount: 1, matchedTags: [{ name: 'oak', displayName: 'Oak', onAsset: true, onFiles: false }] },
    ]);
  });

  describe('files:importProgress and files:cancelImport', () => {
    it('answer null and false without a workspace', async () => {
      expect(await ok('files:importProgress', {})).toBeNull();
      expect(await ok('files:cancelImport', {})).toEqual({ cancelling: false });
    });

    it('answer null and false with a workspace and no import running', async () => {
      await openWorkspace();
      expect(await ok('files:importProgress', {})).toBeNull();
      expect(await ok('files:cancelImport', {})).toEqual({ cancelling: false });
    });

    it('answer the running import and mark it cancelled without waiting for the queue', async () => {
      await openWorkspace();
      const progress = { done: 1, total: 4, currentBytes: 5, currentSize: 10, cancelling: false };
      const read = vi.spyOn(manager, 'importProgress').mockReturnValue(progress);
      const cancel = vi.spyOn(manager, 'cancelImport').mockReturnValue(true);
      // A queued operation held until the end: neither channel may wait for it.
      let release = (): void => {};
      const held = manager.exclusive(() => new Promise<void>((resolve) => (release = resolve)));

      const answered = await ok('files:importProgress', {});
      expect(answered).toEqual(progress);
      expect(ipcContract['files:importProgress'].response.safeParse(answered).success).toBe(true);
      expect(await ok('files:cancelImport', {})).toEqual({ cancelling: true });
      release();
      await held;
      expect(read).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      read.mockRestore();
      cancel.mockRestore();
    });
  });

  describe('files:import', () => {
    it('answers no_workspace_open for an unpacking import without a workspace', async () => {
      const source = join(base, 'pack.zip');
      await writeFile(source, 'not a zip');
      expect(await call('files:import', { sourcePaths: [source], unpackArchives: true })).toMatchObject({
        ok: false,
        error: { code: 'no_workspace_open' },
      });
    });

    it('refuses a non-boolean unpackArchives as an invalid request and answers entryName null for a plain import', async () => {
      await openWorkspace();
      const source = join(base, 'a.png');
      await writeFile(source, 'hello');
      expect(await call('files:import', { sourcePaths: [source], unpackArchives: 'x' })).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });

      const results = await ok<any[]>('files:import', { sourcePaths: [source], unpackArchives: true });
      expect(ipcContract['files:import'].response.safeParse(results).success).toBe(true);
      expect(results).toMatchObject([{ sourcePath: source, entryName: null, error: null, file: { status: 'complete' } }]);
    });

    it('passes unpackArchives through to the import', async () => {
      await openWorkspace();
      const source = join(base, 'pack.zip');
      await writeFile(source, 'not a zip');
      // The source is no ZIP, so unpacking answers the archive-level message.
      expect(await ok<any[]>('files:import', { sourcePaths: [source], unpackArchives: true })).toEqual([
        { sourcePath: source, entryName: null, file: null, error: 'This file is not a readable ZIP archive', duplicateOf: [] },
      ]);
      expect(await ok<any[]>('files:import', { sourcePaths: [source] })).toMatchObject([
        { sourcePath: source, entryName: null, error: null, file: { status: 'complete', originalName: 'pack.zip' } },
      ]);
    });
  });

  describe('files:measure', () => {
    it('measures an image imported without dimensions and rejects a non-UUID id', async () => {
      await openWorkspace();
      const source = join(base, 'a.png');
      await writeFile(source, 'hello');
      const [imported] = await ok<any[]>('files:import', { sourcePaths: [source] });
      expect(imported.file).toMatchObject({ width: null, height: null });

      measure.mockResolvedValue({ width: 320, height: 200 });
      const measured = await ok('files:measure', { fileId: imported.file.id });
      expect(ipcContract['files:measure'].response.safeParse(measured).success).toBe(true);
      expect(measured).toMatchObject({ id: imported.file.id, width: 320, height: 200 });

      expect(await call('files:measure', { fileId: 'nope' })).toMatchObject({ ok: false });
    });
  });

  describe('tags', () => {
    async function assetWithFile() {
      await openWorkspace();
      const [type] = await ok<{ id: string }[]>('assetTypes:list', {});
      const asset = await ok('assets:create', { name: 'A', typeId: type!.id });
      const source = join(base, 'a.png');
      await writeFile(source, 'hello');
      const [result] = await ok<any[]>('files:import', {
        sourcePaths: [source],
        target: { assetId: asset.id, role: 'reference' },
      });
      return { asset, file: result.file };
    }

    it('tags round-trip through IPC', async () => {
      const { asset, file } = await assetWithFile();
      const withTag = await ok('assets:addTag', { assetId: asset.id, name: '  Metal ' });
      expect(ipcContract['assets:addTag'].response.safeParse(withTag).success).toBe(true);
      expect(withTag.tags).toMatchObject([{ name: 'metal', displayName: 'Metal', origin: 'manual' }]);
      const tagged = await ok('files:addTag', { fileId: file.id, name: 'Sci-Fi' });
      expect(ipcContract['files:addTag'].response.safeParse(tagged).success).toBe(true);
      expect(tagged.tags).toMatchObject([{ name: 'sci-fi' }]);

      expect((await ok('assets:get', { id: asset.id })).tags.map((t: any) => t.name)).toEqual(['metal']);
      const files = await ok('files:list', { ...page, scope: { kind: 'asset', assetId: asset.id } });
      expect(files.items[0].tags.map((t: any) => t.name)).toEqual(['sci-fi']);

      const suggested = await ok('tags:suggest', { prefix: '', limit: 10 });
      expect(suggested.map((t: any) => t.name).sort()).toEqual(['metal', 'sci-fi']);
      expect(await ok('tags:suggest', { prefix: 'sc', limit: 10 })).toMatchObject([{ name: 'sci-fi' }]);

      for (let i = 0; i < 2; i++) {
        expect((await ok('assets:removeTag', { assetId: asset.id, name: 'METAL' })).tags).toEqual([]);
        expect((await ok('files:removeTag', { fileId: file.id, name: 'sci-fi' })).tags).toEqual([]);
      }
    });

    it('assets:list returns tags, coverTags and matchedTags', async () => {
      await openWorkspace();
      const [type] = await ok<{ id: string }[]>('assetTypes:list', {});
      const asset = await ok('assets:create', { name: 'A', typeId: type!.id });
      await ok('assets:addTag', { assetId: asset.id, name: 'Oak' });
      const listed = await ok('assets:list', { limit: 10, offset: 0, tagNames: ['oak'] });
      expect(ipcContract['assets:list'].response.safeParse(listed).success).toBe(true);
      expect(listed.items[0]).toMatchObject({
        tags: [{ name: 'oak', displayName: 'Oak', origin: 'manual' }],
        coverTags: [],
        matchedTags: [{ name: 'oak', displayName: 'Oak', onAsset: true, onFiles: false }],
      });
      expect((await ok('assets:list', { limit: 10, offset: 0 })).items[0].matchedTags).toBeUndefined();
    });

    it('files:list rejects 11 tag names and a query over 200 characters', async () => {
      await openWorkspace();
      const tagNames = Array.from({ length: 11 }, (_, i) => `t${i}`);
      const invalid = { ok: false, error: { code: 'invalid_request' } };
      expect(await call('files:list', { ...page, scope: { kind: 'all' }, tagNames })).toMatchObject(invalid);
      expect(await call('files:list', { ...page, scope: { kind: 'all' }, query: 'x'.repeat(201) })).toMatchObject(invalid);
    });

    it('files:list filters the inbox by query, tag and kind', async () => {
      await openWorkspace();
      const sources = [join(base, 'Oak-Bark.png'), join(base, 'oak-trunk.glb')];
      for (const source of sources) await writeFile(source, source);
      const imported = await ok<any[]>('files:import', { sourcePaths: sources });
      const [bark, trunk] = imported.map((r) => r.file);
      await ok('files:addTag', { fileId: bark.id, name: 'Sci-Fi' });
      const inbox = { ...page, scope: { kind: 'inbox' } };

      const listed = await ok('files:list', { ...inbox, query: 'OAK', tagNames: ['SCI-FI', 'sci-fi'], kind: 'image' });
      expect(ipcContract['files:list'].response.safeParse(listed).success).toBe(true);
      expect(listed).toMatchObject({ total: 1, items: [{ id: bark.id, tags: [{ name: 'sci-fi' }] }] });
      expect(await ok('files:list', { ...inbox, query: 'oak', kind: 'model' })).toMatchObject({ total: 1, items: [{ id: trunk.id }] });
      expect(await ok('files:list', { ...inbox, query: 'fi' })).toMatchObject({ total: 1, items: [{ id: bark.id }] });
      expect(await ok('files:list', { ...inbox, tagNames: ['unknown'] })).toEqual({ items: [], total: 0 });
      expect((await ok('files:list', { ...inbox, query: '%' })).total).toBe(2); // no words: no filter
    });

    it('a too long tag answers validation_failed without echoing the input', async () => {
      const { asset, file } = await assetWithFile();
      const name = 'x'.repeat(65);
      for (const [channel, request] of [
        ['assets:addTag', { assetId: asset.id, name }],
        ['files:addTag', { fileId: file.id, name }],
      ] as const) {
        const result = await call(channel, request);
        expect(result).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
        expect(JSON.stringify(result)).not.toContain(name);
      }
    });

    it('an unknown asset answers not_found', async () => {
      await openWorkspace();
      expect(await call('assets:addTag', { assetId: uuid, name: 'metal' })).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
    });

    it('files:addTag on a pending file answers validation_failed', async () => {
      await openWorkspace();
      const id = await manager.exclusive(async (s) => {
        const storage = await s.database.storages.getPrimary();
        const fileId = s.newId();
        await s.database.files.insertPending({
          id: fileId,
          storageId: storage!.id,
          originalName: 'pending.png',
          relativePath: 'inbox/pending.png',
          mimeType: 'image/png',
          importedAt: s.now().toISOString(),
          kind: 'image',
        });
        return fileId;
      });
      expect(await call('files:addTag', { fileId: id, name: 'metal' })).toMatchObject({
        ok: false,
        error: { code: 'validation_failed' },
      });
    });

    it('tags:rename renames, refuses an unconfirmed merge and merges', async () => {
      const { asset, file } = await assetWithFile();
      await ok('assets:addTag', { assetId: asset.id, name: 'Front View' });
      await ok('files:addTag', { fileId: file.id, name: 'Front' });

      const renamed = await ok('tags:rename', { from: 'front view', to: ' Frontal ', merge: false });
      expect(ipcContract['tags:rename'].response.safeParse(renamed).success).toBe(true);
      expect(renamed).toEqual({ name: 'frontal', displayName: 'Frontal', merged: false });
      expect((await ok('assets:get', { id: asset.id })).tags).toMatchObject([{ name: 'frontal', displayName: 'Frontal', origin: 'manual' }]);

      expect(await call('tags:rename', { from: 'frontal', to: 'front', merge: false })).toMatchObject({
        ok: false,
        error: { code: 'invalid_operation', message: 'A tag with this name already exists' },
      });
      expect(await ok('tags:rename', { from: 'frontal', to: 'FRONT', merge: true })).toEqual({ name: 'front', displayName: 'FRONT', merged: true });
      expect((await ok('assets:get', { id: asset.id })).tags).toMatchObject([{ name: 'front', displayName: 'FRONT' }]);
      expect((await ok('assets:list', { ...page, query: 'frontal' })).total).toBe(0);
      expect((await ok('assets:list', { ...page, query: 'front' })).total).toBe(1);
      expect(await call('tags:rename', { from: 'frontal', to: 'x', merge: true })).toMatchObject({
        ok: false,
        error: { code: 'not_found', message: 'Tag does not exist' },
      });
    });

    it('tags:usage answers for a valid, an unknown and an invalid text', async () => {
      const { asset, file } = await assetWithFile();
      await ok('assets:addTag', { assetId: asset.id, name: 'Metal' });
      await ok('files:addTag', { fileId: file.id, name: 'metal' });
      const usage = await ok('tags:usage', { name: ' METAL ' });
      expect(ipcContract['tags:usage'].response.safeParse(usage).success).toBe(true);
      expect(usage).toEqual({ exists: true, name: 'metal', displayName: 'Metal', assets: 1, files: 1, prompts: 0 });
      expect(await ok('tags:usage', { name: 'wood' })).toEqual({ exists: false, name: 'wood', displayName: '', assets: 0, files: 0, prompts: 0 });
      expect(await ok('tags:usage', { name: '!!!' })).toEqual({ exists: false, name: '', displayName: '', assets: 0, files: 0, prompts: 0 });
    });

    it('tags:suggest rejects limit 0 and 51', async () => {
      await openWorkspace();
      for (const limit of [0, 51]) {
        expect(await call('tags:suggest', { prefix: '', limit })).toMatchObject({
          ok: false,
          error: { code: 'invalid_request' },
        });
      }
    });
  });

  it('maps an unknown asset to not_found', async () => {
    await openWorkspace();
    expect(await call('assets:get', { id: uuid })).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('maps a self-relation to invalid_operation', async () => {
    await openWorkspace();
    const [type] = await ok<{ id: string }[]>('assetTypes:list', {});
    const asset = await ok('assets:create', { name: 'A', typeId: type!.id });
    const result = await call('relations:add', { fromAssetId: asset.id, toAssetId: asset.id, kind: 'uses' });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_operation' } });
  });

  it('assigns a file to an asset and reports a failing move as invalid_operation without paths', async () => {
    await openWorkspace();
    const root = join(base, 'workspace');
    const [type] = await ok<{ id: string }[]>('assetTypes:list', {});
    const asset = await ok('assets:create', { name: 'A', typeId: type!.id });
    const sources = [join(base, 'a.png'), join(base, 'b.png')];
    await writeFile(sources[0]!, 'a');
    await writeFile(sources[1]!, 'b');
    const [first, second] = await ok<{ file: { id: string } }[]>('files:import', { sourcePaths: sources });

    const placed = await ok('files:assign', { fileId: first!.file.id, assetId: asset.id, role: 'reference' });
    expect(placed).toMatchObject({
      assetId: asset.id,
      role: 'reference',
      relativePath: assetFilePath(asset.id, 'reference', first!.file.id, 'a.png'),
    });

    const occupied = join(root, assetFilePath(asset.id, 'reference', second!.file.id, 'b.png'));
    await mkdir(join(occupied, '..'), { recursive: true });
    await writeFile(occupied, 'other');
    const result = await call('files:assign', { fileId: second!.file.id, assetId: asset.id, role: 'reference' });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_operation' } });
    const message = result.ok ? '' : result.error.message;
    expect(message).not.toContain(base);
    expect(message).not.toMatch(/[A-Za-z]:\\|\/|\\/);
  });

  describe('file batches', () => {
    async function inboxFiles(names: string[]) {
      await openWorkspace();
      const [type] = await ok<{ id: string }[]>('assetTypes:list', {});
      const asset = await ok('assets:create', { name: 'A', typeId: type!.id });
      const sources = names.map((n) => join(base, n));
      for (const source of sources) await writeFile(source, source);
      const imported = await ok<{ file: { id: string } }[]>('files:import', { sourcePaths: sources });
      return { assetId: asset.id as string, ids: imported.map((r) => r.file.id) };
    }

    async function insertPending() {
      return manager.exclusive(async (s) => {
        const storage = await s.database.storages.getPrimary();
        const fileId = s.newId();
        await s.database.files.insertPending({
          id: fileId,
          storageId: storage!.id,
          originalName: 'pending.png',
          relativePath: 'inbox/pending.png',
          mimeType: 'image/png',
          importedAt: s.now().toISOString(),
          kind: 'image',
        });
        return fileId;
      });
    }

    it('files:assignMany rejects 1001 ids and duplicate ids', async () => {
      await openWorkspace();
      const many = Array.from({ length: 1001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      const invalid = { ok: false, error: { code: 'invalid_request' } };
      expect(await call('files:assignMany', { fileIds: many, assetId: uuid, role: 'reference' })).toMatchObject(invalid);
      expect(await call('files:assignMany', { fileIds: [uuid, uuid], assetId: uuid, role: 'reference' })).toMatchObject(invalid);
      expect(await call('files:addTagMany', { fileIds: [uuid, uuid], name: 'oak' })).toMatchObject(invalid);
    });

    it('files:assignMany returns per-item results in request order with mapped errors', async () => {
      const { assetId, ids } = await inboxFiles(['a.png', 'b.png']);
      const [f1, f2] = ids as [string, string];
      const res = await ok('files:assignMany', { fileIds: [f1, uuid, f2], assetId, role: 'reference' });
      expect(ipcContract['files:assignMany'].response.safeParse(res).success).toBe(true);
      expect(res.items.map((i: any) => i.fileId)).toEqual([f1, uuid, f2]);
      expect(res.items.map((i: any) => i.error?.code ?? null)).toEqual([null, 'not_found', null]);
      expect(res.items[0].file).toMatchObject({ assetId, role: 'reference', relativePath: assetFilePath(assetId, 'reference', f1, 'a.png') });
      expect(res.items[1].file).toBeNull();
      expect(JSON.stringify(res)).not.toContain(base); // no absolute paths
    });

    it('files:assignMany maps an unexpected error to internal_error', async () => {
      const { assetId, ids } = await inboxFiles(['a.png']);
      const session = await manager.read(async (s) => s);
      vi.spyOn(session.database.files, 'get').mockRejectedValueOnce(new Error(`disk failure at ${base}`));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await ok('files:assignMany', { fileIds: ids, assetId, role: 'reference' });
      expect(res.items).toEqual([{ fileId: ids[0], file: null, error: { code: 'internal_error', message: 'Unexpected error' } }]);
    });

    it('files:addTagMany and files:removeTagMany tag and untag every file', async () => {
      const { ids } = await inboxFiles(['a.png', 'b.png']);
      const reversed = [...ids].reverse();
      const tagged = await ok('files:addTagMany', { fileIds: reversed, name: ' Oak ' });
      expect(ipcContract['files:addTagMany'].response.safeParse(tagged).success).toBe(true);
      expect(tagged.items.map((f: any) => f.id)).toEqual(reversed);
      expect(tagged.items.map((f: any) => f.tags)).toEqual([
        [{ name: 'oak', displayName: 'Oak', origin: 'manual' }],
        [{ name: 'oak', displayName: 'Oak', origin: 'manual' }],
      ]);
      const listed = await ok('files:list', { ...page, scope: { kind: 'inbox' }, tagNames: ['oak'] });
      expect(listed.total).toBe(2);

      const untagged = await ok('files:removeTagMany', { fileIds: ids, name: 'OAK' });
      expect(ipcContract['files:removeTagMany'].response.safeParse(untagged).success).toBe(true);
      expect(untagged.items.map((f: any) => f.tags)).toEqual([[], []]);
    });

    it('files:addTagMany with a pending file fails with validation_failed and tags nothing', async () => {
      const { ids } = await inboxFiles(['a.png']);
      const pending = await insertPending();
      expect(await call('files:addTagMany', { fileIds: [ids[0], pending], name: 'oak' })).toMatchObject({
        ok: false,
        error: { code: 'validation_failed' },
      });
      expect(await call('files:addTagMany', { fileIds: [ids[0], uuid], name: 'oak' })).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
      const files = await ok('files:list', { ...page, scope: { kind: 'all' } });
      expect(files.items.every((f: any) => f.tags.length === 0)).toBe(true);
      expect(await ok('tags:suggest', { prefix: '', limit: 10 })).toEqual([]);
    });
  });

  describe('trash', () => {
    const root = () => join(base, 'workspace');

    async function filesIn(names: string[], target?: { assetId: string; role: string }) {
      const sources = names.map((n) => join(base, n));
      for (const source of sources) await writeFile(source, source);
      const imported = await ok<{ file: { id: string } }[]>('files:import', { sourcePaths: sources, target });
      return imported.map((r) => r.file.id);
    }

    async function createAsset() {
      const [type] = await ok<{ id: string }[]>('assetTypes:list', {});
      return (await ok('assets:create', { name: 'A', typeId: type!.id })).id as string;
    }

    const listIds = async (scope: unknown) =>
      (await ok('files:list', { ...page, scope })).items.map((f: any) => f.id);

    it('the trash channels answer no_workspace_open without a workspace', async () => {
      const requests: [IpcChannel, unknown][] = [
        ['files:trashMany', { fileIds: [uuid] }],
        ['files:restoreMany', { fileIds: [uuid] }],
        ['files:purgeMany', { fileIds: [uuid] }],
        ['trash:empty', {}],
        ['trash:summary', {}],
      ];
      for (const [channel, request] of requests) {
        expect(await call(channel, request), channel).toMatchObject({ ok: false, error: { code: 'no_workspace_open' } });
      }
    });

    it('the batch trash channels answer invalid_request for 0, 1001 and duplicate ids', async () => {
      await openWorkspace();
      const many = Array.from({ length: 1001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      const invalid = { ok: false, error: { code: 'invalid_request' } };
      for (const channel of ['files:trashMany', 'files:restoreMany', 'files:purgeMany'] as const) {
        for (const fileIds of [[], many, [uuid, uuid]]) {
          expect(await call(channel, { fileIds }), channel).toMatchObject(invalid);
        }
      }
    });

    it('files:trashMany returns one item per file and keeps going after a failing one', async () => {
      await openWorkspace();
      const [a, b] = (await filesIn(['a.png', 'b.png'])) as [string, string];
      const exclusive = vi.spyOn(manager, 'exclusive');
      const res = await ok('files:trashMany', { fileIds: [a, uuid, b] });
      expect(exclusive).toHaveBeenCalled();
      expect(ipcContract['files:trashMany'].response.safeParse(res).success).toBe(true);
      expect(res.items.map((i: any) => i.fileId)).toEqual([a, uuid, b]);
      expect(res.items.map((i: any) => i.error?.code ?? null)).toEqual([null, 'not_found', null]);
      expect(res.items[0].file).toMatchObject({ id: a, assetId: null, role: null, relativePath: trashPath(a, 'a.png') });
      expect(res.items[0].file.deletedAt).not.toBeNull();
      expect(res.items[1].file).toBeNull();
      expect(JSON.stringify(res)).not.toContain(base);

      const again = await ok('files:trashMany', { fileIds: [a] });
      expect(again.items[0].error).toEqual({ code: 'invalid_operation', message: 'The file is already in the trash' });
    });

    it('files:restoreMany and files:purgeMany round trip on disk', async () => {
      await openWorkspace();
      const assetId = await createAsset();
      const [placed] = (await filesIn(['p.png'], { assetId, role: 'reference' })) as [string];
      const [loose, other] = (await filesIn(['l.png', 'o.png'])) as [string, string];
      const assetPath = assetFilePath(assetId, 'reference', placed, 'p.png');
      expect(existsSync(join(root(), assetPath))).toBe(true);

      await ok('files:trashMany', { fileIds: [placed, loose] });
      expect(existsSync(join(root(), assetPath))).toBe(false);
      expect(existsSync(join(root(), trashPath(placed, 'p.png')))).toBe(true);
      expect(existsSync(join(root(), TRASH_DIR, `${loose}_l.png`))).toBe(true);
      expect(await listIds({ kind: 'inbox' })).toEqual([other]);
      expect(await listIds({ kind: 'all' })).toEqual([other]);
      expect(await listIds({ kind: 'asset', assetId })).toEqual([]);
      expect((await listIds({ kind: 'trash' })).sort()).toEqual([placed, loose].sort());
      const trashed = (await ok('files:list', { ...page, scope: { kind: 'trash' } })).items.find((f: any) => f.id === placed);
      expect(trashed).toMatchObject({ trashedAssetId: assetId, trashedAssetName: 'A', trashedRole: 'reference' });

      const restored = await ok('files:restoreMany', { fileIds: [placed, other] });
      expect(ipcContract['files:restoreMany'].response.safeParse(restored).success).toBe(true);
      expect(restored.items[0].file).toMatchObject({ assetId, role: 'reference', relativePath: assetPath, deletedAt: null });
      expect(restored.items[1].error).toEqual({ code: 'invalid_operation', message: 'The file is not in the trash' });
      expect(existsSync(join(root(), assetPath))).toBe(true);
      expect(await listIds({ kind: 'asset', assetId })).toEqual([placed]);
      expect(await listIds({ kind: 'trash' })).toEqual([loose]);

      const purged = await ok('files:purgeMany', { fileIds: [loose, placed] });
      expect(ipcContract['files:purgeMany'].response.safeParse(purged).success).toBe(true);
      expect(purged.items).toEqual([
        { fileId: loose, file: null, error: null },
        { fileId: placed, file: null, error: { code: 'invalid_operation', message: 'The file is not in the trash' } },
      ]);
      expect(existsSync(join(root(), TRASH_DIR, `${loose}_l.png`))).toBe(false);
      expect(await listIds({ kind: 'trash' })).toEqual([]);
      expect(await call('files:measure', { fileId: loose })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    });

    it('trash:summary counts', async () => {
      await openWorkspace();
      const ids = await filesIn(['a.png', 'b.png', 'c.png']);
      expect(await ok('trash:summary', {})).toEqual({ count: 0 });
      await ok('files:trashMany', { fileIds: ids.slice(0, 2) });
      expect(await ok('trash:summary', {})).toEqual({ count: 2 });
    });

    it('trash:empty returns purged and failed', async () => {
      await openWorkspace();
      const ids = await filesIn(['a.png', 'b.png', 'c.png']);
      await ok('files:trashMany', { fileIds: ids });
      const session = await manager.read(async (s) => s);
      vi.spyOn(session.database.files, 'purge').mockRejectedValueOnce(new Error(`disk failure at ${base}`));
      const exclusive = vi.spyOn(manager, 'exclusive');
      expect(await ok('trash:empty', {})).toEqual({ purged: 2, failed: 1 });
      expect(exclusive).toHaveBeenCalled();
      expect(await ok('trash:summary', {})).toEqual({ count: 1 });
      expect(await ok('trash:empty', {})).toEqual({ purged: 1, failed: 0 });
      expect(await ok('trash:summary', {})).toEqual({ count: 0 });
    });

    it('files:addTag, files:assign and files:unassign answer invalid_operation for a trashed file', async () => {
      await openWorkspace();
      const assetId = await createAsset();
      const [id] = (await filesIn(['a.png'])) as [string];
      await ok('files:trashMany', { fileIds: [id] });
      const refused = { ok: false, error: { code: 'invalid_operation', message: 'The file is in the trash' } };
      expect(await call('files:addTag', { fileId: id, name: 'oak' })).toEqual(refused);
      expect(await call('files:removeTag', { fileId: id, name: 'oak' })).toEqual(refused);
      expect(await call('files:assign', { fileId: id, assetId, role: 'reference' })).toEqual(refused);
      expect(await call('files:unassign', { fileId: id })).toEqual(refused);
      expect(await call('assets:setCover', { assetId, fileId: id })).toEqual(refused);
      const many = await ok('files:assignMany', { fileIds: [id], assetId, role: 'reference' });
      expect(many.items[0].error).toEqual(refused.error);
      expect(await call('files:addTagMany', { fileIds: [id], name: 'oak' })).toEqual(refused);
    });

    it('files:measure still serves a trashed file', async () => {
      await openWorkspace();
      const [id] = (await filesIn(['a.png'])) as [string];
      await ok('files:trashMany', { fileIds: [id] });
      measure.mockResolvedValue({ width: 4, height: 3 });
      expect(await ok('files:measure', { fileId: id })).toMatchObject({ id, width: 4, height: 3 });
      expect(measure.mock.lastCall![0]).toBe(join(base, 'workspace', trashPath(id, 'a.png')));
    });
  });

  describe('sources', () => {
    async function twoAssets() {
      await openWorkspace();
      const [type] = await ok<{ id: string }[]>('assetTypes:list', {});
      const asset = await ok('assets:create', { name: 'Door', typeId: type!.id });
      const other = await ok('assets:create', { name: 'Window', typeId: type!.id });
      return { asset, other };
    }

    it('adds a source that assets:get shows and opens exactly the stored address', async () => {
      const { asset } = await twoAssets();
      const added = await ok('assets:addSource', { assetId: asset.id, url: '  https://Example.org/doors?x=1 ' });
      expect(ipcContract['assets:addSource'].response.safeParse(added).success).toBe(true);
      expect(added.sources).toMatchObject([{ url: 'https://example.org/doors?x=1' }]);
      const got = await ok('assets:get', { id: asset.id });
      expect(got.sources).toEqual(added.sources);

      expect(await ok('assets:openSource', { assetId: asset.id, sourceId: added.sources[0].id })).toBeNull();
      expect(openExternal).toHaveBeenCalledTimes(1);
      expect(openExternal).toHaveBeenCalledWith('https://example.org/doors?x=1');

      const removed = await ok('assets:removeSource', { assetId: asset.id, sourceId: added.sources[0].id });
      expect(ipcContract['assets:removeSource'].response.safeParse(removed).success).toBe(true);
      expect(removed.sources).toEqual([]);
    });

    it('refuses to open a source of another asset', async () => {
      const { asset, other } = await twoAssets();
      const foreign = await ok('assets:addSource', { assetId: other.id, url: 'https://example.org/' });
      expect(await call('assets:openSource', { assetId: asset.id, sourceId: foreign.sources[0].id })).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('answers a fixed message when the browser cannot be started', async () => {
      const { asset } = await twoAssets();
      const added = await ok('assets:addSource', { assetId: asset.id, url: 'https://example.org/' });
      openExternal.mockRejectedValue(new Error('C:\\secret'));
      expect(await call('assets:openSource', { assetId: asset.id, sourceId: added.sources[0].id })).toEqual({
        ok: false,
        error: { code: 'invalid_operation', message: 'This source could not be opened' },
      });
    });

    it('re-checks the stored address on open and never hands an unusable one to the host', async () => {
      const { asset } = await twoAssets();
      const added = await ok('assets:addSource', { assetId: asset.id, url: 'https://example.org/' });
      const workspaceId = (await ok<{ id: string }>('workspace:current', {})).id;
      const raw = new Database(join(base, 'userData', 'workspaces', workspaceId, 'assetforge.sqlite'));
      try {
        raw.prepare('UPDATE asset_source SET url = ? WHERE id = ?').run('file:///C:/Windows/System32/calc.exe', added.sources[0].id);
      } finally {
        raw.close();
      }
      expect(await call('assets:openSource', { assetId: asset.id, sourceId: added.sources[0].id })).toMatchObject({
        ok: false,
        error: { code: 'validation_failed' },
      });
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('refuses a file address and a non-string url', async () => {
      const { asset } = await twoAssets();
      expect(await call('assets:addSource', { assetId: asset.id, url: 'file:///x' })).toMatchObject({
        ok: false,
        error: { code: 'validation_failed', message: 'This is not a web address' },
      });
      expect(await call('assets:addSource', { assetId: asset.id, url: 42 })).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
    });
  });

  it('rejects a whitespace-only project name as invalid_request', async () => {
    await openWorkspace();
    expect(await call('projects:create', { name: '  ' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });
});

describe('workflow IPC', () => {
  async function createAsset(key: string) {
    const types = await ok<{ id: string; key: string }[]>('assetTypes:list', {});
    return ok<{ id: string; name: string }>('assets:create', {
      name: 'Hill',
      typeId: types.find((t) => t.key === key)!.id,
    });
  }

  it('returns no_workspace_open for the workflow channels', async () => {
    const requests: Partial<Record<IpcChannel, unknown>> = {
      'workflowTemplates:list': {},
      'workflows:get': { assetId: uuid },
      'workflows:start': { assetId: uuid },
      'workflows:updateStep': { stepId: uuid, patch: { state: 'done' } },
      'workflows:remove': { assetId: uuid },
    };
    for (const [channel, request] of Object.entries(requests)) {
      expect(ipcContract[channel as IpcChannel].request.safeParse(request).success, channel).toBe(true);
      expect(await call(channel as IpcChannel, request), channel).toMatchObject({
        ok: false,
        error: { code: 'no_workspace_open' },
      });
    }
  });

  it('skipping a mandatory step maps to invalid_operation', async () => {
    await openWorkspace();
    const asset = await createAsset('landscape');
    const workflow = await ok('workflows:get', { assetId: asset.id });
    const result = await call('workflows:updateStep', {
      stepId: workflow.steps[0].id,
      patch: { state: 'skipped' },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_operation' } });
  });

  it('workflows:remove does nothing when the dialog is declined', async () => {
    await openWorkspace();
    const asset = await createAsset('landscape');
    confirmWorkflow.mockResolvedValue(false);
    expect(await ok('workflows:remove', { assetId: asset.id })).toEqual({ removed: false });
    expect(confirmWorkflow).toHaveBeenCalledWith('Hill');
    expect(await ok('workflows:get', { assetId: asset.id })).not.toBeNull();
  });

  it('workflows:remove removes the workflow after confirmation', async () => {
    await openWorkspace();
    const asset = await createAsset('landscape');
    confirmWorkflow.mockResolvedValue(true);
    expect(await ok('workflows:remove', { assetId: asset.id })).toEqual({ removed: true });
    expect(await ok('workflows:get', { assetId: asset.id })).toBeNull();
  });

  it('workflows:remove does not ask when there is no workflow', async () => {
    await openWorkspace();
    const asset = await createAsset('landscape');
    confirmWorkflow.mockResolvedValue(true);
    await ok('workflows:remove', { assetId: asset.id });
    confirmWorkflow.mockClear();
    expect(await ok('workflows:remove', { assetId: asset.id })).toEqual({ removed: false });
    expect(confirmWorkflow).not.toHaveBeenCalled();
  });

  it('workflows:updateStep rejects unknown patch keys as invalid_request', async () => {
    await openWorkspace();
    const asset = await createAsset('landscape');
    const workflow = await ok('workflows:get', { assetId: asset.id });
    expect(
      await call('workflows:updateStep', { stepId: workflow.steps[0].id, patch: { mandatory: false } }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });
});

describe('URL import channels', () => {
  /** One imported file carrying `url` as its origin. */
  async function fileWithOrigin(url: string): Promise<{ fileId: string; originId: string }> {
    await openWorkspace();
    const path = join(base, 'origin.png');
    await writeFile(path, 'origin content');
    const [result] = await ok<{ file: { id: string } }[]>('files:import', { sourcePaths: [path] });
    const fileId = result!.file.id;
    const originId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    await manager.exclusive((s) =>
      s.database.fileOrigins.insert({ id: originId, fileId, url, createdAt: new Date().toISOString() }),
    );
    return { fileId, originId };
  }

  it('answers no_workspace_open without a workspace', async () => {
    const requests: [IpcChannel, unknown][] = [
      ['files:importUrls', { urls: ['https://example.org/a.png'] }],
      ['files:origins', { fileId: uuid }],
      ['files:openOrigin', { fileId: uuid, originId: uuid }],
    ];
    for (const [channel, request] of requests) {
      expect(await call(channel, request), channel).toMatchObject({ ok: false, error: { code: 'no_workspace_open' } });
    }
  });

  it('refuses 5001 lines and no line as an invalid request', async () => {
    await openWorkspace();
    const lines = Array.from({ length: 5001 }, (_, i) => `https://example.org/${i}.png`);
    expect(await call('files:importUrls', { urls: lines })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await call('files:importUrls', { urls: [] })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('queues the usable lines and reports the invalid ones', async () => {
    await openWorkspace();
    const result = await ok('files:importUrls', {
      urls: ['https://example.org/a.png', '', 'not a url', 'https://example.org/a.png#x', 'https://example.org/b.png'],
    });
    expect(result).toEqual({ queued: 2, alreadyImported: 0, alreadyQueued: 1, invalid: [{ line: 3, text: 'not a url' }] });
  });

  it('answers not_found for the origins of an unknown file and for an unknown origin', async () => {
    const { fileId } = await fileWithOrigin('https://example.org/a.png');
    expect(await call('files:origins', { fileId: uuid })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await call('files:openOrigin', { fileId: uuid, originId: uuid })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await call('files:openOrigin', { fileId, originId: uuid })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('lists the origins and opens exactly the stored address, never one the renderer sends', async () => {
    const { fileId, originId } = await fileWithOrigin('https://example.org/a.png?x=1');
    const origins = await ok('files:origins', { fileId });
    expect(ipcContract['files:origins'].response.safeParse(origins).success).toBe(true);
    expect(origins).toMatchObject([{ id: originId, url: 'https://example.org/a.png?x=1' }]);

    expect(await ok('files:openOrigin', { fileId, originId, url: 'https://evil.example/' })).toEqual({});
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://example.org/a.png?x=1');
  });

  it('refuses to open the origin of another file', async () => {
    const { originId } = await fileWithOrigin('https://example.org/a.png');
    const path = join(base, 'other.png');
    await writeFile(path, 'other content');
    const [other] = await ok<{ file: { id: string } }[]>('files:import', { sourcePaths: [path] });
    expect(await call('files:openOrigin', { fileId: other!.file.id, originId })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('answers a fixed message when the browser cannot be started', async () => {
    const { fileId, originId } = await fileWithOrigin('https://example.org/a.png');
    openExternal.mockRejectedValue(new Error('C:\secret https://example.org/a.png'));
    expect(await call('files:openOrigin', { fileId, originId })).toEqual({
      ok: false,
      error: { code: 'invalid_operation', message: 'This source could not be opened' },
    });
  });
});
