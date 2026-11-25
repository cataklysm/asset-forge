import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assetFilePath,
  assignAsset,
  createAsset,
  createProject,
  inboxPath,
  listAssets,
  relocateFile,
  removeAssignment,
} from '@assetforge/core';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { createWorkspaceHost, createWorkspaceManager } from '../src/main/composition.js';

let base: string;
let userDataPath: string;
let workspaceRoot: string;
let pngPath: string;
let blendPath: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'af-accept-'));
  userDataPath = join(base, 'userData');
  workspaceRoot = join(base, 'workspace');
  const sources = join(base, 'sources');
  pngPath = join(sources, 'a.png');
  blendPath = join(sources, 'scene.blend');
  await mkdir(sources, { recursive: true });
  await writeFile(pngPath, 'hello');
  await writeFile(blendPath, randomBytes(1024 * 1024));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function createAndImport() {
  const first = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
  const ws = await first.create({ name: 'Gilded Hour', rootPath: workspaceRoot });
  const results = await first.importFiles([pngPath, blendPath]);
  expect(results.map((r) => r.file?.status)).toEqual(['complete', 'complete']);
  await first.close();
  return ws;
}

describe('phase 1 acceptance', () => {
  it('survives a restart with files intact and consistent', async () => {
    const ws = await createAndImport();

    const second = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    expect(await second.list()).toMatchObject([{ id: ws.id, name: 'Gilded Hour', rootPath: workspaceRoot }]);
    const reopened = await second.open({ rootPath: workspaceRoot });
    expect(reopened.id).toBe(ws.id);
    const { items, total } = await second.listFiles({ limit: 50, offset: 0, scope: { kind: 'all' } });
    expect(total).toBe(2);
    for (const item of items) {
      const onDisk = await readFile(join(workspaceRoot, item.relativePath));
      expect(createHash('sha256').update(onDisk).digest('hex')).toBe(item.sha256);
      expect(isAbsolute(item.relativePath)).toBe(false);
    }
    expect(await readFile(pngPath, 'utf8')).toBe('hello');
    expect(existsSync(join(workspaceRoot, 'assetforge.sqlite'))).toBe(false);
    expect(existsSync(join(userDataPath, 'workspaces', ws.id, 'assetforge.sqlite'))).toBe(true);
    expect(await readdir(join(workspaceRoot, '.assetforge', 'staging'))).toEqual([]);
    await second.close();
  });

  it('opens a moved workspace directory with the same id and files', async () => {
    const ws = await createAndImport();
    const moved = join(base, 'moved');
    await rename(workspaceRoot, moved);

    const manager = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    try {
      const reopened = await manager.open({ rootPath: moved });
      expect(reopened.id).toBe(ws.id);
      expect((await manager.listFiles({ limit: 50, offset: 0, scope: { kind: 'all' } })).total).toBe(2);
      const listed = await manager.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: ws.id, rootPath: moved });
    } finally {
      await manager.close();
    }
  });

  it('rejects a copied workspace directory while the original still exists', async () => {
    const ws = await createAndImport();
    const copy = join(base, 'copy');
    await cp(workspaceRoot, copy, { recursive: true });

    const manager = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    try {
      await expect(manager.open({ rootPath: copy })).rejects.toMatchObject({ code: 'workspace_duplicate' });
      expect(manager.current()).toBeNull();
      expect(await manager.list()).toMatchObject([{ id: ws.id, rootPath: workspaceRoot }]);

      const original = await manager.open({ rootPath: workspaceRoot });
      expect(original.id).toBe(ws.id);
      expect((await manager.listFiles({ limit: 50, offset: 0, scope: { kind: 'all' } })).total).toBe(2);
    } finally {
      await manager.close();
    }
  });

  it('initialises a fresh database when the userData workspace directory is gone', async () => {
    const ws = await createAndImport();
    await rm(join(userDataPath, 'workspaces', ws.id), { recursive: true, force: true });

    const manager = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    try {
      const reopened = await manager.open({ rootPath: workspaceRoot });
      expect(reopened.id).toBe(ws.id);
      expect((await manager.listFiles({ limit: 50, offset: 0, scope: { kind: 'all' } })).total).toBe(0);
    } finally {
      await manager.close();
    }
  });

  it('places a file in an asset; removing a project assignment leaves the file untouched', async () => {
    const manager = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    try {
      await manager.create({ name: 'Gilded Hour', rootPath: workspaceRoot });
      const { asset, project } = await manager.exclusive(async (s) => {
        const typeId = (await s.database.assetTypes.list())[0]!.id;
        return {
          asset: await createAsset(s, { name: 'Pump', typeId }),
          project: await createProject(s, { name: 'Game' }),
        };
      });
      const [result] = await manager.importFiles([pngPath], { assetId: asset.id, role: 'reference' });
      const placed = result!.file!;
      expect(result!.error).toBeNull();
      expect(placed).toMatchObject({ assetId: asset.id, role: 'reference' });
      expect(placed.relativePath).toBe(assetFilePath(asset.id, 'reference', placed.id, 'a.png'));
      expect(await readFile(join(workspaceRoot, placed.relativePath), 'utf8')).toBe('hello');
      expect(await readdir(join(workspaceRoot, 'inbox'))).toEqual([]);

      const key = { projectId: project.id, assetId: asset.id };
      await manager.exclusive((s) => assignAsset(s, key));
      await manager.exclusive((s) => removeAssignment(s, key));

      const files = await manager.listFiles({ limit: 10, offset: 0, scope: { kind: 'asset', assetId: asset.id } });
      expect(files.items).toEqual([placed]);
      expect(await readFile(join(workspaceRoot, placed.relativePath), 'utf8')).toBe('hello');
      const assets = await manager.read((s) => listAssets(s, { limit: 10, offset: 0 }));
      expect(assets.items).toMatchObject([{ id: asset.id, fileCount: 1, projectCount: 0 }]);

      const detached = await manager.exclusive((s) => relocateFile(s, placed.id, null));
      expect(detached).toMatchObject({ assetId: null, role: null, relativePath: inboxPath(placed.id, 'a.png') });
      expect(existsSync(join(workspaceRoot, placed.relativePath))).toBe(false);
      expect(await readFile(join(workspaceRoot, detached.relativePath), 'utf8')).toBe('hello');
    } finally {
      await manager.close();
    }
  });

  it('refuses to open a database for an id that is not a UUID', async () => {
    const host = createWorkspaceHost({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    for (const bad of ['../../evil', '..', '', 'abc', 'C:\\evil']) {
      await expect(host.openDatabase(bad)).rejects.toThrow(/workspace id/i);
    }
    expect(existsSync(join(base, 'evil'))).toBe(false);
    expect(existsSync(join(userDataPath, 'workspaces'))).toBe(false);
  });

  it('requires an explicit migrations folder (a package-relative default breaks in the bundle)', () => {
    // Never called: this only fails typecheck if the option becomes optional again.
    const withoutFolder = () =>
      // @ts-expect-error migrationsFolder is required
      createWorkspaceHost({ userDataPath });
    expect(typeof withoutFolder).toBe('function');
  });
});
