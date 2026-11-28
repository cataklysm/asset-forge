import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
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
import type { HostActions } from '../src/main/host-actions.js';
import { dispatch } from '../src/main/ipc.js';
import { createWorkspaceHandlers } from '../src/main/workspace-handlers.js';
import { idleJobHost, idleServices, noopHost } from './idle-job-host.js';

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

/**
 * The channels as the app wires them, with an idle job host and dialogs that refuse.
 *
 * @param manager the workspace manager
 * @returns `raw` answering the result as sent, and `call` answering the value or throwing on a failure
 */
function channelsFor(manager: WorkspaceManager) {
  const handlers = createWorkspaceHandlers(
    manager,
    {
      pickDirectory: async () => null,
      pickFiles: async () => [],
      confirmRemoveWorkspace: async () => 'cancel',
      confirmRemoveWithoutBackup: async () => false,
      confirmRemoveWorkflow: async () => false,
    },
    noopHost,
    idleJobHost,
    idleServices,
  );
  const raw = <C extends IpcChannel>(channel: C, request: IpcRequest<C>) => dispatch(handlers, channel, request);
  const call = async <C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> => {
    const result = await raw(channel, request);
    if (!result.ok) throw new Error(`${channel} failed: ${result.error.code}`);
    return result.value as IpcResponse<C>;
  };
  return { call, raw };
}

/**
 * @param manager the workspace manager
 * @returns a call that answers the value or throws on a failure
 */
function handlersFor(manager: WorkspaceManager) {
  return channelsFor(manager).call;
}

describe('phase 2a acceptance', () => {
  const page = { limit: 50, offset: 0 };

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
          kind: 'relocate',
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
    const workspace = current.prepare('SELECT id, format_version, name, created_at FROM workspace').all() as Record<
      string,
      unknown
    >[];
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

describe('file trash acceptance', () => {
  const page = { limit: 50, offset: 0 };

  async function sources(...names: string[]): Promise<string[]> {
    const dir = join(base, 'sources');
    const paths: string[] = [];
    for (const name of names) {
      const path = join(dir, name);
      await writeFile(path, `content of ${name}`);
      paths.push(path);
    }
    return paths;
  }

  it('a deleted file leaves every view and comes back intact', async () => {
    const [keptPath, doomedPath] = await sources('alpha.png', 'zephyr.png');
    const first = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    let ids: { assetId: string; keptId: string; doomedId: string };
    try {
      const call = handlersFor(first);
      await call('workspace:create', { name: 'Gilded Hour', rootPath: workspaceRoot });
      const typeId = (await call('assetTypes:list', {}))[0]!.id;
      const asset = await call('assets:create', { name: 'Pump', typeId });
      const results = await call('files:import', {
        sourcePaths: [keptPath!, doomedPath!],
        target: { assetId: asset.id, role: 'reference' },
      });
      expect(results.map((r) => r.file?.status)).toEqual(['complete', 'complete']);
      const [kept, doomed] = results.map((r) => r.file!);
      ids = { assetId: asset.id, keptId: kept!.id, doomedId: doomed!.id };
      await call('files:addTag', { fileId: doomed!.id, name: 'brass' });
      const chosen = await call('assets:setCover', { assetId: asset.id, fileId: doomed!.id });
      expect(chosen).toMatchObject({ coverFileId: doomed!.id, coverIsChosen: true });
      expect(await call('tags:suggest', { prefix: 'bra', limit: 10 })).toEqual([
        { name: 'brass', displayName: 'brass' },
      ]);

      const trashed = await call('files:trashMany', { fileIds: [doomed!.id] });
      expect(trashed.items).toMatchObject([{ fileId: doomed!.id, error: null }]);
      const record = trashed.items[0]!.file!;
      expect(record).toMatchObject({ assetId: null, role: null, trashedAssetId: asset.id, trashedRole: 'reference' });
      expect(record.deletedAt).toEqual(expect.any(String));
      expect(record.relativePath.startsWith('.assetforge/trash/')).toBe(true);
      expect(existsSync(join(workspaceRoot, doomed!.relativePath))).toBe(false);
      expect(existsSync(join(workspaceRoot, record.relativePath))).toBe(true);

      const files = await call('files:list', { ...page, scope: { kind: 'asset', assetId: asset.id } });
      expect(files.items.map((f) => f.id)).toEqual([kept!.id]);
      expect(await call('assets:get', { id: asset.id })).toMatchObject({ coverFileId: kept!.id, coverIsChosen: false });
      const gallery = await call('assets:list', { ...page, query: 'zephyr' });
      expect(gallery.items).toEqual([]);
      const listed = await call('assets:list', page);
      expect(listed.items).toMatchObject([{ id: asset.id, fileCount: 1, coverFileId: kept!.id }]);
      expect(await call('tags:suggest', { prefix: 'bra', limit: 10 })).toEqual([]);
      expect(await call('trash:summary', {})).toEqual({ count: 1 });
      expect((await call('files:list', { ...page, scope: { kind: 'inbox' } })).items).toEqual([]);
    } finally {
      await first.close();
    }

    const second = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    try {
      const call = handlersFor(second);
      await call('workspace:open', { rootPath: workspaceRoot });
      expect(await call('trash:summary', {})).toEqual({ count: 1 });
      const trash = await call('files:list', { ...page, scope: { kind: 'trash' } });
      expect(trash.items).toMatchObject([{ id: ids.doomedId, trashedAssetId: ids.assetId, trashedAssetName: 'Pump' }]);
      expect(existsSync(join(workspaceRoot, trash.items[0]!.relativePath))).toBe(true);

      const restored = await call('files:restoreMany', { fileIds: [ids.doomedId] });
      expect(restored.items).toMatchObject([{ fileId: ids.doomedId, error: null }]);
      const back = restored.items[0]!.file!;
      expect(back).toMatchObject({
        assetId: ids.assetId,
        role: 'reference',
        deletedAt: null,
        trashedAssetId: null,
        trashedRole: null,
        relativePath: assetFilePath(ids.assetId, 'reference', ids.doomedId, 'zephyr.png'),
      });
      expect(back.tags.map((t) => t.name)).toEqual(['brass']);
      expect(await readFile(join(workspaceRoot, back.relativePath), 'utf8')).toBe('content of zephyr.png');
      const files = await call('files:list', { ...page, scope: { kind: 'asset', assetId: ids.assetId } });
      expect(files.items.map((f) => f.id).sort()).toEqual([ids.keptId, ids.doomedId].sort());
      expect(await call('assets:get', { id: ids.assetId })).toMatchObject({
        coverFileId: ids.keptId,
        coverIsChosen: false,
      });
      expect((await call('assets:list', { ...page, query: 'zephyr' })).items.map((a) => a.id)).toEqual([ids.assetId]);
      expect(await call('tags:suggest', { prefix: 'bra', limit: 10 })).toEqual([
        { name: 'brass', displayName: 'brass' },
      ]);
      expect(await call('trash:summary', {})).toEqual({ count: 0 });

      const again = await call('files:trashMany', { fileIds: [ids.doomedId] });
      const trashPath = again.items[0]!.file!.relativePath;
      expect(existsSync(join(workspaceRoot, trashPath))).toBe(true);
      const purged = await call('files:purgeMany', { fileIds: [ids.doomedId] });
      expect(purged.items).toEqual([{ fileId: ids.doomedId, file: null, error: null }]);
      expect(existsSync(join(workspaceRoot, trashPath))).toBe(false);
      expect(await second.read((s) => s.database.files.get(ids.doomedId))).toBeNull();
      expect((await call('files:list', { ...page, scope: { kind: 'all' } })).items.map((f) => f.id)).toEqual([
        ids.keptId,
      ]);
      expect(await call('trash:summary', {})).toEqual({ count: 0 });
      expect(await call('tags:suggest', { prefix: 'bra', limit: 10 })).toEqual([]);
    } finally {
      await second.close();
    }
  });

  it('a purge interrupted before the binary is removed is finished by the next open', async () => {
    const [firstPath, secondPath] = await sources('one.png', 'two.png');
    const first = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    let interrupted: { id: string; path: string };
    let survivor: { id: string; path: string };
    try {
      const call = handlersFor(first);
      await call('workspace:create', { name: 'Gilded Hour', rootPath: workspaceRoot });
      const imported = await call('files:import', { sourcePaths: [firstPath!, secondPath!] });
      const fileIds = imported.map((r) => r.file!.id);
      const trashed = await call('files:trashMany', { fileIds });
      expect(trashed.items.map((i) => i.error)).toEqual([null, null]);
      const [a, b] = trashed.items.map((i) => ({ id: i.fileId, path: i.file!.relativePath }));
      interrupted = a!;
      survivor = b!;

      // The rows go, the process dies before the binary is removed.
      expect(await first.exclusive((s) => s.database.files.purge(interrupted.id, '2026-01-01T00:00:00.000Z'))).toBe(
        true,
      );
      expect(existsSync(join(workspaceRoot, interrupted.path))).toBe(true);
    } finally {
      await first.close();
    }

    const second = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    try {
      const call = handlersFor(second);
      await call('workspace:open', { rootPath: workspaceRoot });
      expect(existsSync(join(workspaceRoot, interrupted.path))).toBe(false);
      expect(await readFile(join(workspaceRoot, survivor.path), 'utf8')).toBe('content of two.png');
      const trashDir = await readdir(join(workspaceRoot, '.assetforge', 'trash'));
      expect(trashDir).toEqual([survivor.path.split('/').pop()]);
      expect(await call('trash:summary', {})).toEqual({ count: 1 });
      const trash = await call('files:list', { ...page, scope: { kind: 'trash' } });
      expect(trash.items.map((f) => f.id)).toEqual([survivor.id]);
    } finally {
      await second.close();
    }
  });
});

describe('tag rename and merge acceptance', () => {
  const page = { limit: 50, offset: 0 };

  it('merges a file tag into an asset tag everywhere, proposals included', async () => {
    const sources = join(base, 'sources');
    const leftPath = join(sources, 'left.png');
    const rightPath = join(sources, 'right.png');
    await writeFile(leftPath, 'left');
    await writeFile(rightPath, 'right');

    const manager = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    try {
      const { call, raw } = channelsFor(manager);
      await call('workspace:create', { name: 'Gilded Hour', rootPath: workspaceRoot });
      const typeId = (await call('assetTypes:list', {}))[0]!.id;
      const asset = await call('assets:create', { name: 'Lantern', typeId });
      const results = await call('files:import', {
        sourcePaths: [leftPath, rightPath],
        target: { assetId: asset.id, role: 'reference' },
      });
      expect(results.map((r) => r.file?.status)).toEqual(['complete', 'complete']);
      const [tagged, proposed] = results.map((r) => r.file!);

      await call('assets:addTag', { assetId: asset.id, name: 'Front' });
      await call('files:addTag', { fileId: tagged!.id, name: 'front view' });
      const stored = await manager.exclusive((s) =>
        s.database.analyses.propose({
          fileId: proposed!.id,
          sha256: proposed!.sha256!,
          provider: 'ollama',
          model: 'qwen',
          promptVersion: 1,
          tags: [{ name: 'front view', displayName: 'front view' }],
          promptName: 'Default',
          createdAt: new Date().toISOString(),
        }),
      );
      expect(stored).toBe(true);

      expect(await call('tags:usage', { name: 'front' })).toEqual({
        exists: true,
        name: 'front',
        displayName: 'Front',
        assets: 1,
        files: 0,
        prompts: 0,
      });
      expect(await call('tags:usage', { name: 'front view' })).toEqual({
        exists: true,
        name: 'front view',
        displayName: 'front view',
        assets: 0,
        files: 1,
        prompts: 0,
      });

      expect(await raw('tags:rename', { from: 'front view', to: 'front', merge: false })).toMatchObject({
        ok: false,
        error: { code: 'invalid_operation', message: 'A tag with this name already exists' },
      });
      expect(await call('tags:rename', { from: 'front view', to: 'front', merge: true })).toEqual({
        name: 'front',
        displayName: 'front',
        merged: true,
      });

      const detail = await call('assets:get', { id: asset.id });
      expect(detail.tags).toEqual([{ name: 'front', displayName: 'front', origin: 'manual' }]);
      const files = await call('files:list', { ...page, scope: { kind: 'asset', assetId: asset.id } });
      expect(files.items.find((f) => f.id === tagged!.id)!.tags).toEqual([
        { name: 'front', displayName: 'front', origin: 'manual' },
      ]);
      expect((await call('assets:list', { ...page, query: 'view' })).items).toEqual([]);
      expect((await call('assets:list', { ...page, tagNames: ['front'] })).items.map((a) => a.id)).toEqual([asset.id]);
      expect(await call('tags:suggest', { prefix: 'front', limit: 10 })).toEqual([
        { name: 'front', displayName: 'front' },
      ]);
      const { proposal } = await call('analysis:getProposal', { fileId: proposed!.id });
      expect(proposal!.tags).toEqual([{ name: 'front', displayName: 'front' }]);

      expect(await raw('tags:rename', { from: 'front view', to: 'front', merge: true })).toMatchObject({
        ok: false,
        error: { code: 'not_found', message: 'Tag does not exist' },
      });
    } finally {
      await manager.close();
    }
  });
});

describe('ZIP import acceptance', () => {
  const page = { limit: 50, offset: 0 };

  async function buildArchive(path: string): Promise<void> {
    const zip = new yazl.ZipFile();
    zip.addEmptyDirectory('textures/');
    zip.addBuffer(Buffer.from('wood pixels'), 'textures/wood.png');
    zip.addBuffer(Buffer.from('stone pixels'), 'stone.png', { compress: false });
    zip.addBuffer(Buffer.from('MZ'), 'tools/setup.exe');
    zip.addBuffer(Buffer.from('resource fork'), '__MACOSX/._stone.png');
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(path));
  }

  it('unpacks an archive into an asset, imports it as a file, and reports duplicates on a repeat', async () => {
    const archivePath = join(base, 'sources', 'pack.zip');
    await buildArchive(archivePath);

    const manager = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    try {
      const call = handlersFor(manager);
      await call('workspace:create', { name: 'Gilded Hour', rootPath: workspaceRoot });
      const typeId = (await call('assetTypes:list', {}))[0]!.id;
      const asset = await call('assets:create', { name: 'Quarry', typeId });

      const unpacked = await call('files:import', {
        sourcePaths: [archivePath],
        target: { assetId: asset.id, role: 'texture' },
        unpackArchives: true,
      });
      expect(unpacked.map((r) => [r.sourcePath, r.entryName, r.error])).toEqual([
        [archivePath, 'textures/wood.png', null],
        [archivePath, 'stone.png', null],
        [archivePath, 'tools/setup.exe', 'This file type cannot be imported'],
      ]);
      const [wood, stone] = unpacked.map((r) => r.file);
      expect(wood).toMatchObject({
        status: 'complete',
        originalName: 'wood.png',
        assetId: asset.id,
        role: 'texture',
        kind: 'image',
      });
      expect(stone).toMatchObject({
        status: 'complete',
        originalName: 'stone.png',
        assetId: asset.id,
        role: 'texture',
        kind: 'image',
      });
      expect(unpacked[2]!.file).toBeNull();
      expect(unpacked.map((r) => r.duplicateOf)).toEqual([[], [], []]);
      expect(wood!.relativePath).toBe(assetFilePath(asset.id, 'texture', wood!.id, 'wood.png'));
      expect(await readFile(join(workspaceRoot, wood!.relativePath), 'utf8')).toBe('wood pixels');
      expect(await readFile(join(workspaceRoot, stone!.relativePath), 'utf8')).toBe('stone pixels');
      expect(createHash('sha256').update('stone pixels').digest('hex')).toBe(stone!.sha256);

      const inAsset = await call('files:list', { ...page, scope: { kind: 'asset', assetId: asset.id } });
      expect(inAsset.items.map((f) => f.id).sort()).toEqual([wood!.id, stone!.id].sort());
      expect(
        (await call('files:list', { ...page, scope: { kind: 'all' }, query: 'wood' })).items.map((f) => f.id),
      ).toEqual([wood!.id]);
      expect(
        (await call('files:list', { ...page, scope: { kind: 'all' }, query: 'stone' })).items.map((f) => f.id),
      ).toEqual([stone!.id]);
      expect((await call('files:list', { ...page, scope: { kind: 'all' }, query: 'setup' })).items).toEqual([]);
      expect(await readdir(join(workspaceRoot, '.assetforge', 'staging'))).toEqual([]);

      const [asFile] = await call('files:import', { sourcePaths: [archivePath], unpackArchives: false });
      expect(asFile).toMatchObject({
        sourcePath: archivePath,
        entryName: null,
        error: null,
        duplicateOf: [],
        file: { status: 'complete', originalName: 'pack.zip', kind: 'other', assetId: null },
      });

      const again = await call('files:import', { sourcePaths: [archivePath], unpackArchives: true });
      expect(again.map((r) => r.entryName)).toEqual(['textures/wood.png', 'stone.png', 'tools/setup.exe']);
      expect(again.map((r) => r.duplicateOf)).toEqual([[wood!.id], [stone!.id], []]);
      expect(again.slice(0, 2).map((r) => r.file?.status)).toEqual(['complete', 'complete']);
      expect((await call('files:list', { ...page, scope: { kind: 'inbox' } })).total).toBe(3);
    } finally {
      await manager.close();
    }
  });

  /** Offsets of the central and local header of every entry of a (non-ZIP64) archive. */
  function zipHeaders(buf: Buffer): { central: number; local: number }[] {
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('no end of central directory');
    let cursor = buf.readUInt32LE(eocd + 16);
    const out: { central: number; local: number }[] = [];
    for (let n = 0; n < buf.readUInt16LE(eocd + 10); n++) {
      out.push({ central: cursor, local: buf.readUInt32LE(cursor + 42) });
      cursor += 46 + buf.readUInt16LE(cursor + 28) + buf.readUInt16LE(cursor + 30) + buf.readUInt16LE(cursor + 32);
    }
    return out;
  }

  it('a deflated entry with a lying declared size fails alone; the next entry is imported', async () => {
    const archivePath = join(base, 'sources', 'liar.zip');
    const content = Buffer.from('deflated content '.repeat(200));
    const zip = new yazl.ZipFile();
    zip.addBuffer(content, 'liar.png', { compress: true });
    zip.addBuffer(Buffer.from('honest pixels'), 'honest.png', { compress: true });
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(archivePath));
    const buf = await readFile(archivePath);
    const [liar] = zipHeaders(buf);
    buf.writeUInt32LE(content.length + 1, liar!.central + 24);
    buf.writeUInt32LE(content.length + 1, liar!.local + 22);
    await writeFile(archivePath, buf);

    const manager = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    try {
      const call = handlersFor(manager);
      await call('workspace:create', { name: 'Gilded Hour', rootPath: workspaceRoot });

      const results = await call('files:import', { sourcePaths: [archivePath], unpackArchives: true });

      expect(results.map((r) => [r.entryName, r.file?.status ?? null])).toEqual([
        ['liar.png', 'failed'],
        ['honest.png', 'complete'],
      ]);
      // The size check fails while the entry is streamed, which the import answers with its generic fixed text.
      expect(results[0]!.error).toBe('Import failed');
      expect(results[0]!.error).not.toContain(base);
      expect(results[1]!.error).toBeNull();
      expect(await readFile(join(workspaceRoot, results[1]!.file!.relativePath), 'utf8')).toBe('honest pixels');
      expect(await readdir(join(workspaceRoot, '.assetforge', 'staging'))).toEqual([]);
    } finally {
      await manager.close();
    }
  });
});

describe('Asset sources acceptance', () => {
  it('adds, refuses a duplicate, opens, removes and keeps sources across a reopen', async () => {
    const opened: string[] = [];
    const host: HostActions = { ...noopHost, openExternal: async (url) => void opened.push(url) };
    const manager = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    try {
      const handlers = createWorkspaceHandlers(
        manager,
        {
          pickDirectory: async () => null,
          pickFiles: async () => [],
          confirmRemoveWorkspace: async () => 'cancel',
          confirmRemoveWithoutBackup: async () => false,
          confirmRemoveWorkflow: async () => false,
        },
        host,
        idleJobHost,
        idleServices,
      );
      const raw = <C extends IpcChannel>(channel: C, request: IpcRequest<C>) => dispatch(handlers, channel, request);
      const call = async <C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> => {
        const result = await raw(channel, request);
        if (!result.ok) throw new Error(`${channel} failed: ${result.error.code}`);
        return result.value as IpcResponse<C>;
      };

      await call('workspace:create', { name: 'Gilded Hour', rootPath: workspaceRoot });
      const typeId = (await call('assetTypes:list', {}))[0]!.id;
      const asset = await call('assets:create', { name: 'Quarry', typeId });

      await call('assets:addSource', { assetId: asset.id, url: 'https://example.org/a' });
      await call('assets:addSource', { assetId: asset.id, url: 'https://example.org/b' });
      const both = await call('assets:get', { id: asset.id });
      expect(both.sources.map((s) => s.url)).toEqual(['https://example.org/a', 'https://example.org/b']);

      expect(await raw('assets:addSource', { assetId: asset.id, url: 'HTTPS://EXAMPLE.ORG/a' })).toMatchObject({
        ok: false,
        error: { code: 'invalid_operation', message: 'This source already exists' },
      });

      const [first, second] = both.sources;
      await call('assets:openSource', { assetId: asset.id, sourceId: second!.id });
      expect(opened).toEqual(['https://example.org/b']);

      await call('assets:removeSource', { assetId: asset.id, sourceId: first!.id });

      await manager.close();
      await call('workspace:open', { rootPath: workspaceRoot });
      expect((await call('assets:get', { id: asset.id })).sources.map((s) => s.url)).toEqual(['https://example.org/b']);
    } finally {
      await manager.close();
    }
  });
});
