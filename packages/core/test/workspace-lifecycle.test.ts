import { describe, expect, it } from 'vitest';
import { WorkspaceManifestSchema } from '@assetforge/contracts';
import {
  DirectoryNotEmptyError,
  InvalidManifestError,
  LAYOUT_DIRS,
  MANIFEST_PATH,
  NoWorkspaceOpenError,
  StorageUnreachableError,
  UnsupportedFormatVersionError,
  WorkspaceManager,
  WorkspaceMismatchError,
  WorkspaceNotFoundError,
} from '../src/index.js';
import { createFakeHost } from './fakes.js';

const ROOT = '/ws/a';

function setup() {
  const fake = createFakeHost();
  return { ...fake, manager: new WorkspaceManager(fake.host) };
}

describe('WorkspaceManager lifecycle', () => {
  it('create writes a valid manifest, the layout, sets current and registers once', async () => {
    const { manager, storages, host } = setup();
    const summary = await manager.create({ name: 'Demo', rootPath: ROOT });
    const storage = storages.get(ROOT)!;

    const manifest = WorkspaceManifestSchema.parse(JSON.parse((await storage.readText(MANIFEST_PATH))!));
    expect(manifest.id).toBe(summary.id);
    expect(manifest.name).toBe('Demo');
    expect(manifest.formatVersion).toBe(1);
    for (const dir of LAYOUT_DIRS) expect(storage.dirs.has(dir)).toBe(true);
    expect(manager.current()).toEqual(summary);
    expect(summary.rootPath).toBe(ROOT);
    expect(await host.registry.list()).toEqual([summary]);
  });

  it('create on a non-empty root throws and writes nothing', async () => {
    const { manager, host, storages } = setup();
    host.createStorage(ROOT);
    storages.get(ROOT)!.files.set('stray.txt', Buffer.from('x'));
    await expect(manager.create({ name: 'Demo', rootPath: ROOT })).rejects.toBeInstanceOf(DirectoryNotEmptyError);
    expect([...storages.get(ROOT)!.files.keys()]).toEqual(['stray.txt']);
    expect(storages.get(ROOT)!.dirs.size).toBe(0);
    expect(await host.registry.list()).toEqual([]);
    expect(manager.current()).toBeNull();
  });

  it('create on an unreachable storage throws StorageUnreachableError', async () => {
    const { manager, host, storages } = setup();
    host.createStorage(ROOT);
    storages.get(ROOT)!.reachable = false;
    await expect(manager.create({ name: 'Demo', rootPath: ROOT })).rejects.toBeInstanceOf(StorageUnreachableError);
  });

  it('create, close, open returns the same id and name', async () => {
    const { manager } = setup();
    const created = await manager.create({ name: 'Demo', rootPath: ROOT });
    await manager.close();
    expect(manager.current()).toBeNull();
    const opened = await manager.open({ rootPath: ROOT });
    expect(opened.id).toBe(created.id);
    expect(opened.name).toBe('Demo');
    expect(manager.current()).toEqual(opened);
  });

  it('close is a no-op when nothing is open', async () => {
    const { manager } = setup();
    await expect(manager.close()).resolves.toBeUndefined();
  });

  it('open without manifest throws WorkspaceNotFoundError', async () => {
    const { manager } = setup();
    await expect(manager.open({ rootPath: '/ws/none' })).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    expect(manager.current()).toBeNull();
  });

  it('open on unreachable storage throws and keeps the registry entry', async () => {
    const { manager, host, storages } = setup();
    await manager.create({ name: 'Demo', rootPath: ROOT });
    await manager.close();
    storages.get(ROOT)!.reachable = false;
    await expect(manager.open({ rootPath: ROOT })).rejects.toBeInstanceOf(StorageUnreachableError);
    expect(await manager.list()).toHaveLength(1);
    expect((await host.registry.list())[0]!.rootPath).toBe(ROOT);
  });

  it('open rejects a newer formatVersion', async () => {
    const { manager, storages } = setup();
    await manager.create({ name: 'Demo', rootPath: ROOT });
    await manager.close();
    const storage = storages.get(ROOT)!;
    const manifest = JSON.parse((await storage.readText(MANIFEST_PATH))!);
    storage.files.set(MANIFEST_PATH, Buffer.from(JSON.stringify({ ...manifest, formatVersion: 2 })));
    await expect(manager.open({ rootPath: ROOT })).rejects.toBeInstanceOf(UnsupportedFormatVersionError);
  });

  it('open rejects invalid JSON and schema-invalid manifests', async () => {
    const { manager, storages, host } = setup();
    await manager.create({ name: 'Demo', rootPath: ROOT });
    await manager.close();
    const storage = storages.get(ROOT)!;
    storage.files.set(MANIFEST_PATH, Buffer.from('{not json'));
    await expect(manager.open({ rootPath: ROOT })).rejects.toBeInstanceOf(InvalidManifestError);
    storage.files.set(MANIFEST_PATH, Buffer.from('{"id":"x"}'));
    await expect(manager.open({ rootPath: ROOT })).rejects.toBeInstanceOf(InvalidManifestError);
    expect(await host.registry.list()).toHaveLength(1);
  });

  it('a moved workspace keeps its id and gets the new rootPath', async () => {
    const { manager, storages, host } = setup();
    const created = await manager.create({ name: 'Demo', rootPath: '/ws/a' });
    await manager.close();
    const a = storages.get('/ws/a')!;
    host.createStorage('/ws/b');
    const b = storages.get('/ws/b')!;
    for (const [k, v] of a.files) b.files.set(k, Buffer.from(v));
    for (const d of a.dirs) b.dirs.add(d);

    const opened = await manager.open({ rootPath: '/ws/b' });
    expect(opened.id).toBe(created.id);
    const entries = await host.registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.rootPath).toBe('/ws/b');
  });

  it('a database with a different meta id causes WorkspaceMismatchError and is closed', async () => {
    const { manager, host, databases } = setup();
    const created = await manager.create({ name: 'Demo', rootPath: ROOT });
    await manager.close();
    const db = databases.get(created.id)!;
    db.meta.current = { id: crypto.randomUUID(), formatVersion: 1, name: 'Other', createdAt: new Date().toISOString() };
    db.closed = false;
    await expect(manager.open({ rootPath: ROOT })).rejects.toBeInstanceOf(WorkspaceMismatchError);
    expect(manager.current()).toBeNull();
    expect(db.closed).toBe(true);
    expect(await host.registry.list()).toHaveLength(1);
  });

  it('open closes the database of the previously open workspace', async () => {
    const { manager, databases } = setup();
    const first = await manager.create({ name: 'One', rootPath: '/ws/one' });
    const second = await manager.create({ name: 'Two', rootPath: '/ws/two' });
    expect(databases.get(first.id)!.closed).toBe(true);
    expect(databases.get(second.id)!.closed).toBe(false);
    expect(manager.current()!.id).toBe(second.id);
  });

  it('open failing after the database was opened closes it and leaves nothing open', async () => {
    const { manager, storages, databases } = setup();
    const created = await manager.create({ name: 'Demo', rootPath: ROOT });
    await manager.close();
    storages.get(ROOT)!.failNext('ensureLayout', new Error('disk full'));
    await expect(manager.open({ rootPath: ROOT })).rejects.toThrow('disk full');
    expect(databases.get(created.id)!.closed).toBe(true);
    expect(manager.current()).toBeNull();
  });

  it('listFiles and importFiles without an open workspace throw NoWorkspaceOpenError', async () => {
    const { manager } = setup();
    await expect(manager.listFiles({ limit: 10, offset: 0 })).rejects.toBeInstanceOf(NoWorkspaceOpenError);
    await expect(manager.importFiles(['/x'])).rejects.toBeInstanceOf(NoWorkspaceOpenError);
  });

  it('listFiles delegates to the open database', async () => {
    const { manager } = setup();
    await manager.create({ name: 'Demo', rootPath: ROOT });
    await expect(manager.listFiles({ limit: 10, offset: 0 })).resolves.toEqual({ items: [], total: 0 });
  });
});
