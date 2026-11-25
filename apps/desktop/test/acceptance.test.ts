import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IpcChannel, IpcRequest, IpcResponse } from '@assetforge/contracts';
import {
  assetFilePath,
  assignAsset,
  createAsset,
  createProject,
  inboxPath,
  listAssets,
  relocateFile,
  removeAssignment,
  type WorkspaceManager,
} from '@assetforge/core';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { createWorkspaceHost, createWorkspaceManager } from '../src/main/composition.js';
import { createWorkspaceHandlers, dispatch } from '../src/main/ipc.js';

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

// The desktop package has no type declarations for better-sqlite3; this is the used subset.
interface RawDatabase {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}
const Database = createRequire(import.meta.url)('better-sqlite3') as new (
  path: string,
  options: { readonly: boolean },
) => RawDatabase;
interface WritableRawDatabase {
  prepare(sql: string): { all(): unknown[]; run(...params: unknown[]): unknown };
  exec(sql: string): void;
  close(): void;
}
const WritableDatabase = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => WritableRawDatabase;

const noopHost = { openPath: async () => '', showItemInFolder: () => {}, workspaceOpened: () => {} };

describe('phase 2a acceptance', () => {
  const page = { limit: 50, offset: 0 };

  function handlersFor(manager: WorkspaceManager) {
    const handlers = createWorkspaceHandlers(manager, {
      pickDirectory: async () => null,
      pickFiles: async () => [],
      confirmRemoveWorkspace: async () => 'cancel',
      confirmRemoveWorkflow: async () => false,
    }, noopHost);
    return async <C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> => {
      const result = await dispatch(handlers, channel, request);
      if (!result.ok) throw new Error(`${channel} failed: ${result.error.code}`);
      return result.value as IpcResponse<C>;
    };
  }

  async function sha256Of(path: string): Promise<string> {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  }

  /** Asset of type `character` in two projects with `a.png` placed as a reference. */
  async function scenario(manager: WorkspaceManager) {
    const call = handlersFor(manager);
    await call('workspace:create', { name: 'Gilded Hour', rootPath: workspaceRoot });
    const types = await call('assetTypes:list', {});
    const typeId = types.find((t) => t.key === 'character')!.id;
    const asset = await call('assets:create', { name: 'Pump', typeId });
    const first = await call('projects:create', { name: 'Game' });
    const second = await call('projects:create', { name: 'Trailer' });
    await call('assignments:assign', { projectId: first.id, assetId: asset.id });
    await call('assignments:assign', { projectId: second.id, assetId: asset.id });
    const [result] = await call('files:import', {
      sourcePaths: [pngPath],
      target: { assetId: asset.id, role: 'reference' },
    });
    return { call, typeId, asset, first, second, file: result!.file!, result: result! };
  }

  it('uses one asset in two projects and removes an assignment without losing anything', async () => {
    const manager = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    try {
      const { call, asset, first, second, file, result } = await scenario(manager);
      expect(result.error).toBeNull();
      expect(file.relativePath).toBe(`assets/${asset.id}/references/${file.id}_a.png`);
      expect(existsSync(join(workspaceRoot, file.relativePath))).toBe(true);
      expect(await readdir(join(workspaceRoot, 'inbox'))).toEqual([]);
      const checksum = await sha256Of(join(workspaceRoot, file.relativePath));

      await call('assignments:remove', { projectId: first.id, assetId: asset.id });

      expect(await call('assets:get', { id: asset.id })).toMatchObject({ id: asset.id });
      const assignments = await call('assignments:listByAsset', { assetId: asset.id });
      expect(assignments.map((a) => a.projectId)).toEqual([second.id]);
      const files = await call('files:list', { ...page, scope: { kind: 'asset', assetId: asset.id } });
      expect(files.items).toEqual([file]);
      expect(await sha256Of(join(workspaceRoot, file.relativePath))).toBe(checksum);
      expect(checksum).toBe(file.sha256);
    } finally {
      await manager.close();
    }
  });

  it('keeps assets, assignments, relations, placement and status across a restart', async () => {
    const collect = async (call: ReturnType<typeof handlersFor>, assetId: string, otherId: string) => ({
      asset: await call('assets:get', { id: assetId }),
      assignments: await call('assignments:listByAsset', { assetId }),
      relations: await call('relations:list', { assetId }),
      incoming: await call('relations:list', { assetId: otherId }),
      files: await call('files:list', { ...page, scope: { kind: 'asset', assetId } }),
    });
    const first = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    let before: Awaited<ReturnType<typeof collect>>;
    let typeIds: string[];
    let ids: { assetId: string; otherId: string };
    try {
      const { call, typeId, asset } = await scenario(first);
      const other = await call('assets:create', { name: 'Valve', typeId });
      await call('assets:update', { id: asset.id, patch: { status: 'in_review' } });
      await call('relations:add', { fromAssetId: asset.id, toAssetId: other.id, kind: 'uses' });
      ids = { assetId: asset.id, otherId: other.id };
      before = await collect(call, ids.assetId, ids.otherId);
      typeIds = (await call('assetTypes:list', {})).map((t) => t.id);
      expect(typeIds).toHaveLength(8);
    } finally {
      await first.close();
    }

    const second = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    try {
      await second.open({ rootPath: workspaceRoot });
      const call = handlersFor(second);
      const after = await collect(call, ids.assetId, ids.otherId);
      expect(after).toEqual(before);
      expect(after.asset.status).toBe('in_review');
      expect(after.relations).toHaveLength(1);
      expect(after.files.items).toHaveLength(1);
      expect((await call('assetTypes:list', {})).map((t) => t.id)).toEqual(typeIds);
    } finally {
      await second.close();
    }
  });

  async function interruptedMove(state: 'moved' | 'not-moved' | 'both-exist') {
    const performMove = state === 'moved';
    const first = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    let setup: { assetId: string; fileId: string; inboxFile: string; newPath: string; before: unknown };
    try {
      const call = handlersFor(first);
      await call('workspace:create', { name: 'Gilded Hour', rootPath: workspaceRoot });
      const typeId = (await call('assetTypes:list', {}))[0]!.id;
      const asset = await call('assets:create', { name: 'Pump', typeId });
      const [imported] = await call('files:import', { sourcePaths: [pngPath] });
      const file = imported!.file!;
      const newPath = assetFilePath(asset.id, 'reference', file.id, 'a.png');
      await first.exclusive(async (s) => {
        await s.database.fileMoves.begin({
          fileId: file.id,
          targetRelativePath: newPath,
          targetAssetId: asset.id,
          targetRole: 'reference',
          createdAt: s.now().toISOString(),
        });
        if (performMove) await s.storage.move(file.relativePath, newPath);
      });
      if (state === 'both-exist') {
        const occupied = join(workspaceRoot, newPath);
        await mkdir(join(occupied, '..'), { recursive: true });
        await writeFile(occupied, 'other');
      }
      setup = { assetId: asset.id, fileId: file.id, inboxFile: file.relativePath, newPath, before: file };
    } finally {
      await first.close();
    }

    const second = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    try {
      await second.open({ rootPath: workspaceRoot });
      const listed = await handlersFor(second)('files:list', { ...page, scope: { kind: 'all' } });
      const record = listed.items.find((f) => f.id === setup.fileId);
      const pending = await second.read((s) => s.database.fileMoves.list());
      return { ...setup, record, pending };
    } finally {
      await second.close();
    }
  }

  it('completes an interrupted move on the next open', async () => {
    const r = await interruptedMove('moved');
    expect(r.record).toMatchObject({ assetId: r.assetId, role: 'reference', relativePath: r.newPath });
    expect(r.pending).toEqual([]);
    expect(existsSync(join(workspaceRoot, r.newPath))).toBe(true);
    expect(existsSync(join(workspaceRoot, r.inboxFile))).toBe(false);
  });

  it('discards a move that never happened', async () => {
    const r = await interruptedMove('not-moved');
    expect(r.record).toEqual(r.before);
    expect(r.pending).toEqual([]);
    expect(existsSync(join(workspaceRoot, r.inboxFile))).toBe(true);
  });

  it('discards a move when both source and target exist and touches neither file', async () => {
    const r = await interruptedMove('both-exist');
    expect(r.record).toEqual(r.before);
    expect(r.pending).toEqual([]);
    expect(existsSync(join(workspaceRoot, r.inboxFile))).toBe(true);
    expect(await readFile(join(workspaceRoot, r.newPath), 'utf8')).toBe('other');
  });

  it('no absolute path is stored', async () => {
    const manager = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    let workspaceId: string;
    try {
      const { call, asset, first } = await scenario(manager);
      await call('assignments:update', {
        projectId: first.id,
        assetId: asset.id,
        patch: { intendedUse: 'hero', notes: 'n' },
      });
      workspaceId = (await call('workspace:current', {}))!.id;
    } finally {
      await manager.close();
    }

    const raw = new Database(join(userDataPath, 'workspaces', workspaceId, 'assetforge.sqlite'), {
      readonly: true,
    });
    try {
      const tables = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      expect(tables.length).toBeGreaterThan(5);
      for (const { name } of tables) {
        const columns = raw.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; type: string }[];
        for (const column of columns.filter((c) => c.type.toLowerCase().includes('text'))) {
          const rows = raw.prepare(`SELECT "${column.name}" AS v FROM "${name}"`).all() as { v: unknown }[];
          for (const { v } of rows) {
            if (typeof v !== 'string') continue;
            expect(v.includes(workspaceRoot), `${name}.${column.name}`).toBe(false);
            expect(v.includes(userDataPath), `${name}.${column.name}`).toBe(false);
          }
        }
      }
    } finally {
      raw.close();
    }
  });
});

describe('phase 2b acceptance', () => {
  function handlersFor(manager: WorkspaceManager) {
    const handlers = createWorkspaceHandlers(manager, {
      pickDirectory: async () => null,
      pickFiles: async () => [],
      confirmRemoveWorkspace: async () => 'cancel',
      confirmRemoveWorkflow: async () => false,
    }, noopHost);
    return async <C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> => {
      const result = await dispatch(handlers, channel, request);
      if (!result.ok) throw new Error(`${channel} failed: ${result.error.code}`);
      return result.value as IpcResponse<C>;
    };
  }

  it('traces production progress across a restart', async () => {
    const first = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    let before: IpcResponse<'workflows:get'>;
    let assetId: string;
    try {
      const call = handlersFor(first);
      await call('workspace:create', { name: 'Gilded Hour', rootPath: workspaceRoot });
      const types = await call('assetTypes:list', {});
      const asset = await call('assets:create', {
        name: 'Hill',
        typeId: types.find((t) => t.key === 'landscape')!.id,
      });
      assetId = asset.id;

      const initial = (await call('workflows:get', { assetId }))!;
      expect(initial).toMatchObject({ templateName: 'Landscape', templateVersion: 1 });
      expect(initial.steps).toHaveLength(6);
      const mandatory = initial.steps.filter((s) => s.mandatory);
      const optional = initial.steps.find((s) => !s.mandatory)!;
      await call('workflows:updateStep', { stepId: mandatory[0]!.id, patch: { state: 'done' } });
      await call('workflows:updateStep', { stepId: mandatory[1]!.id, patch: { state: 'done' } });
      await call('workflows:updateStep', {
        stepId: mandatory[2]!.id,
        patch: { state: 'in_progress', notes: 'blocking out terrain' },
      });
      await call('workflows:updateStep', { stepId: optional.id, patch: { state: 'skipped' } });

      before = (await call('workflows:get', { assetId }))!;
      expect(before!.progress).toEqual({ done: 2, total: 5 });
      const listed = await call('assets:list', { limit: 50, offset: 0 });
      expect(listed.items.find((a) => a.id === assetId)!.workflowProgress).toEqual({ done: 2, total: 5 });
    } finally {
      await first.close();
    }

    const second = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    try {
      const call = handlersFor(second);
      await call('workspace:open', { rootPath: workspaceRoot });
      expect(await call('workflows:get', { assetId })).toEqual(before);
      expect(await call('workflowTemplates:list', {})).toHaveLength(5);
    } finally {
      await second.close();
    }
  });

  /**
   * Replaces the workspace database with one a phase 2a build left behind: only migrations 0000
   * and 0001 applied, one landscape asset. The current core cannot create such a workspace itself
   * (it seeds the column added by 0002), so the schema is built from the migration files.
   */
  async function downgradeToPhase2a(workspaceId: string, assetId: string): Promise<void> {
    const dbPath = join(userDataPath, 'workspaces', workspaceId, 'assetforge.sqlite');
    const current = new WritableDatabase(dbPath);
    const workspace = current.prepare('SELECT id, format_version, name, created_at FROM workspace').all() as Record<string, unknown>[];
    const storage = current.prepare('SELECT * FROM storage').all() as Record<string, unknown>[];
    current.close();
    for (const suffix of ['', '-wal', '-shm']) await rm(`${dbPath}${suffix}`, { force: true });

    const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string; when: number }[];
    };
    const old = new WritableDatabase(dbPath);
    try {
      old.exec(
        'CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)',
      );
      for (const entry of journal.entries.slice(0, 2)) {
        const sql = await readFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), 'utf8');
        for (const statement of sql.split('--> statement-breakpoint')) old.exec(statement);
        old
          .prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)')
          .run(createHash('sha256').update(sql).digest('hex'), entry.when);
      }
      const insert = (table: string, row: Record<string, unknown>) => {
        const columns = Object.keys(row);
        old
          .prepare(
            `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
          )
          .run(...Object.values(row));
      };
      for (const row of storage) insert('storage', row);
      for (const row of workspace) insert('workspace', row);
      const typeId = randomUUID();
      const now = new Date().toISOString();
      old
        .prepare('INSERT INTO asset_type (id, key, name, sort_order, built_in) VALUES (?, ?, ?, ?, 1)')
        .run(typeId, 'landscape', 'Landscape', 0);
      old
        .prepare(
          `INSERT INTO asset (id, name, type_id, description, status, created_at, updated_at)
           VALUES (?, 'Hill', ?, '', 'draft', ?, ?)`,
        )
        .run(assetId, typeId, now, now);
    } finally {
      old.close();
    }
  }

  it('upgrades a workspace created before workflows existed', async () => {
    const assetId = randomUUID();
    const creator = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    const ws = await creator.create({ name: 'Old', rootPath: workspaceRoot });
    await creator.close();
    await downgradeToPhase2a(ws.id, assetId);

    const upgraded = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    try {
      const call = handlersFor(upgraded);
      await call('workspace:open', { rootPath: workspaceRoot });
      expect(await call('workflows:get', { assetId })).toBeNull();
      const listed = await call('assets:list', { limit: 50, offset: 0 });
      expect(listed.items.find((a) => a.id === assetId)!.workflowProgress).toBeNull();
      const started = await call('workflows:start', { assetId });
      expect(started).toMatchObject({ assetId, templateName: 'Landscape', templateVersion: 1 });
    } finally {
      await upgraded.close();
    }
  });
});

describe('phase 3b acceptance', () => {
  const page = { limit: 50, offset: 0 };

  function handlersFor(manager: WorkspaceManager) {
    const handlers = createWorkspaceHandlers(manager, {
      pickDirectory: async () => null,
      pickFiles: async () => [],
      confirmRemoveWorkspace: async () => 'cancel',
      confirmRemoveWorkflow: async () => false,
    }, noopHost);
    return async <C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> => {
      const result = await dispatch(handlers, channel, request);
      if (!result.ok) throw new Error(`${channel} failed: ${result.error.code}`);
      return result.value as IpcResponse<C>;
    };
  }

  it('finds an asset by name, file name, tags and file kind, also after a restart', async () => {
    const sources = join(base, 'sources');
    const swordPath = join(sources, 'sword.png');
    const notesPath = join(sources, 'notes.txt');
    const exePath = join(sources, 'Setup.exe');
    await writeFile(swordPath, 'sword');
    await writeFile(notesPath, 'notes');
    await writeFile(exePath, 'MZ');

    const first = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    let assetId: string;
    try {
      const call = handlersFor(first);
      await call('workspace:create', { name: 'Gilded Hour', rootPath: workspaceRoot });
      const types = await call('assetTypes:list', {});
      const typeId = types.find((t) => t.key === 'prop')?.id ?? types[0]!.id;
      const asset = await call('assets:create', { name: 'Rusty blade', typeId });
      assetId = asset.id;
      const results = await call('files:import', {
        sourcePaths: [swordPath, notesPath],
        target: { assetId, role: 'reference' },
      });
      expect(results.map((r) => r.file?.status)).toEqual(['complete', 'complete']);
      const sword = results[0]!.file!;

      await call('assets:addTag', { assetId, name: 'metal' });
      await call('files:addTag', { fileId: sword.id, name: 'sci-fi' });

      const ids = async (r: Partial<IpcRequest<'assets:list'>>) =>
        (await call('assets:list', { ...page, ...r })).items.map((a) => a.id);
      expect(await ids({ query: 'rust' })).toEqual([assetId]);
      expect(await ids({ query: 'sword' })).toEqual([assetId]);
      expect(await ids({ query: 'sci' })).toEqual([assetId]);
      expect(await ids({ tagNames: ['metal', 'sci-fi'] })).toEqual([assetId]);
      expect(await ids({ tagNames: ['metal', 'sci-fi'], fileKind: 'image', typeId })).toEqual([assetId]);
      expect(await ids({ fileKind: 'model' })).toEqual([]);

      await call('assets:update', { id: assetId, patch: { name: 'Old axe' } });
      expect(await ids({ query: 'axe' })).toEqual([assetId]);
      expect(await ids({ query: 'rusty' })).toEqual([]);

      const [refused] = await call('files:import', { sourcePaths: [exePath] });
      expect(refused!.file).toBeNull();
      expect(refused!.error).toEqual(expect.any(String));
      expect(refused!.error).not.toContain(base);
    } finally {
      await first.close();
    }

    const second = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    try {
      const call = handlersFor(second);
      await call('workspace:open', { rootPath: workspaceRoot });
      const ids = async (r: Partial<IpcRequest<'assets:list'>>) =>
        (await call('assets:list', { ...page, ...r })).items.map((a) => a.id);
      expect(await ids({ query: 'axe' })).toEqual([assetId]);
      expect(await ids({ tagNames: ['metal'] })).toEqual([assetId]);
    } finally {
      await second.close();
    }
  });
});
