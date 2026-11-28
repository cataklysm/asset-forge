import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_DAMAGED_MESSAGE,
  BACKUP_FOREIGN_MESSAGE,
  BACKUP_NEWER_MESSAGE,
  DATABASE_MISSING_MESSAGE,
  RESTORE_OPEN_MESSAGE,
} from '@assetforge/contracts';
import {
  InvalidOperationError,
  WorkspaceDuplicateError,
  WorkspaceManager,
  WorkspaceNotFoundError,
} from '../src/index.js';
import { backupFileName } from '../src/backup-names.js';
import type { BackupSource, SnapshotFacts } from '../src/ports/workspace-backups.js';
import { createFakeHost, InMemoryStorage } from './fakes.js';

const ROOT = '/ws/a';
const OTHER_ROOT = '/ws/b';
const NOW = new Date('2026-11-28T10:00:00.000Z');
const DIRECTORY = `${ROOT}/assetforge-backups`;
const FOREIGN_LINEAGE = 'fedcba9876543210fedcba9876543210';

function setup() {
  const fake = createFakeHost();
  fake.host.now = () => NOW;
  const lines: string[] = [];
  fake.host.log = (line) => lines.push(line);
  let databaseOpens = 0;
  const openDatabase = fake.host.openDatabase.bind(fake.host);
  fake.host.openDatabase = (id) => {
    databaseOpens++;
    return openDatabase(id);
  };
  return { ...fake, lines, manager: new WorkspaceManager(fake.host), databaseOpens: () => databaseOpens };
}

/** A workspace created and closed again (its closing backup is in the place). */
async function closedWorkspace() {
  const context = setup();
  const summary = await context.manager.create({ name: 'Demo', rootPath: ROOT });
  const lineageId = context.databases.get(summary.id)!.meta.current!.lineageId;
  await context.manager.close();
  // The closed file answers the lineage the database carries.
  context.backups.lineages.set(summary.id, lineageId);
  return { ...context, summary, lineageId };
}

function regular(name: string, directory = DIRECTORY): BackupSource {
  return { origin: 'regular', directory, name };
}

function facts(overrides: Partial<SnapshotFacts>): SnapshotFacts {
  return {
    workspaceId: '',
    lineageId: null,
    formatVersion: 1,
    appliedMigrations: 3,
    newerThanApp: false,
    ...overrides,
  };
}

describe('missing database', () => {
  it('open of a folder without its database answers workspace_database_missing and writes nothing', async () => {
    const { manager, host, summary, missingDatabases, databaseOpens } = await closedWorkspace();
    missingDatabases.add(summary.id);
    const before = await host.registry.list();
    const opensBefore = databaseOpens();

    await expect(manager.open({ rootPath: ROOT })).rejects.toMatchObject({
      code: 'workspace_database_missing',
      message: DATABASE_MISSING_MESSAGE,
    });
    expect(databaseOpens()).toBe(opensBefore);
    expect(await host.registry.list()).toEqual(before);
    expect(manager.current()).toBeNull();
  });

  it('open with startEmpty creates the database as before', async () => {
    const { manager, summary, missingDatabases, databases } = await closedWorkspace();
    databases.delete(summary.id);
    missingDatabases.add(summary.id);
    const opened = await manager.open({ rootPath: ROOT, startEmpty: true });
    expect(opened.id).toBe(summary.id);
    expect(databases.get(summary.id)!.meta.current!.id).toBe(summary.id);
  });

  it('create is unchanged', async () => {
    const { manager, host } = setup();
    host.databaseExists = async () => false;
    await expect(manager.create({ name: 'Demo', rootPath: ROOT })).resolves.toMatchObject({ rootPath: ROOT });
  });

  it('rejectCopy still wins over the missing database', async () => {
    const { manager, summary, storages, missingDatabases } = await closedWorkspace();
    const copy = new InMemoryStorage();
    for (const [path, content] of storages.get(ROOT)!.files) copy.files.set(path, content);
    storages.set(OTHER_ROOT, copy);
    missingDatabases.add(summary.id);
    await expect(manager.open({ rootPath: OTHER_ROOT })).rejects.toBeInstanceOf(WorkspaceDuplicateError);
  });
});

describe('restore', () => {
  it('damaged, foreign and newer backups are refused with their codes and messages, discard called, install never called', async () => {
    const { manager, backups, summary } = await closedWorkspace();
    backups.stagedFacts.set('foreign', facts({ workspaceId: crypto.randomUUID() }));
    backups.stagedFacts.set('newer-format', facts({ workspaceId: summary.id, formatVersion: 2 }));
    backups.stagedFacts.set('newer-migrations', facts({ workspaceId: summary.id, newerThanApp: true }));
    const cases = [
      ['damaged', 'validation_failed', BACKUP_DAMAGED_MESSAGE],
      ['foreign', 'workspace_mismatch', BACKUP_FOREIGN_MESSAGE],
      ['newer-format', 'unsupported_format_version', BACKUP_NEWER_MESSAGE],
      ['newer-migrations', 'unsupported_format_version', BACKUP_NEWER_MESSAGE],
    ] as const;
    for (const [name, code, message] of cases) {
      const discarded = backups.discarded;
      await expect(manager.restore({ rootPath: ROOT, source: regular(name) })).rejects.toMatchObject({ code, message });
      expect(backups.discarded).toBe(discarded + 1);
    }
    expect(backups.installed).toEqual([]);
    expect(manager.current()).toBeNull();
  });

  it('restore installs, then opens, migrates and recovers; summary returned', async () => {
    const { manager, backups, summary, databases, lineageId } = await closedWorkspace();
    backups.stagedFacts.set('good', facts({ workspaceId: summary.id, lineageId }));
    const derivedBefore = databases.get(summary.id)!.derivedDataCalls;
    const writesBefore = backups.calls.filter((call) => call.method === 'write').length;

    const restored = await manager.restore({ rootPath: ROOT, source: regular('good') });
    expect(restored).toMatchObject({ id: summary.id, rootPath: ROOT });
    expect(manager.current()?.id).toBe(summary.id);
    expect(backups.installed).toEqual([{ workspaceId: summary.id, source: regular('good') }]);
    expect(databases.get(summary.id)!.derivedDataCalls).toBe(derivedBefore + 1);

    // The restored state is not copied again until it changes.
    await manager.close();
    expect(backups.calls.filter((call) => call.method === 'write')).toHaveLength(writesBefore);
  });

  it('restores a workspace whose database is missing', async () => {
    const { manager, backups, summary, missingDatabases } = await closedWorkspace();
    missingDatabases.add(summary.id);
    backups.stagedFacts.set('good', facts({ workspaceId: summary.id }));
    await expect(manager.restore({ rootPath: ROOT, source: regular('good') })).resolves.toMatchObject({
      id: summary.id,
    });
  });

  it('an open that fails after the install reverts it and rethrows the error of the open', async () => {
    const { manager, backups, summary, missingDatabases, lines } = await closedWorkspace();
    backups.stagedFacts.set('good', facts({ workspaceId: summary.id }));
    // The installed copy goes missing before the open: the open answers the missing database, never an empty one.
    backups.onInstall = (workspaceId) => missingDatabases.add(workspaceId);
    backups.onRevert = (workspaceId) => missingDatabases.delete(workspaceId);

    await expect(manager.restore({ rootPath: ROOT, source: regular('good') })).rejects.toMatchObject({
      code: 'workspace_database_missing',
    });
    expect(backups.reverted).toEqual([summary.id]);
    expect(manager.current()).toBeNull();
    expect(lines).toEqual([]);
    // The original database is back.
    await expect(manager.open({ rootPath: ROOT })).resolves.toMatchObject({ id: summary.id });
  });

  it('a failing revert is swallowed and logged once; the error of the open is rethrown', async () => {
    const { manager, backups, summary, missingDatabases, lines } = await closedWorkspace();
    backups.stagedFacts.set('good', facts({ workspaceId: summary.id }));
    backups.onInstall = (workspaceId) => missingDatabases.add(workspaceId);
    backups.revertFailure = new Error(`EBUSY ${ROOT}`);

    await expect(manager.restore({ rootPath: ROOT, source: regular('good') })).rejects.toMatchObject({
      code: 'workspace_database_missing',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Restore could not be undone');
    expect(lines[0]).not.toContain(ROOT);
  });

  it('a failing install discards the stage and neither opens nor reverts', async () => {
    const { manager, backups, summary, databaseOpens } = await closedWorkspace();
    backups.stagedFacts.set('good', facts({ workspaceId: summary.id }));
    backups.installFailure = new Error('swap failed');
    const opensBefore = databaseOpens();
    const discarded = backups.discarded;

    await expect(manager.restore({ rootPath: ROOT, source: regular('good') })).rejects.toThrow();
    expect(backups.discarded).toBe(discarded + 1);
    expect(backups.reverted).toEqual([]);
    expect(databaseOpens()).toBe(opensBefore);
  });

  it('hands the abort signal of the request to the stage', async () => {
    const { manager, backups, summary } = await closedWorkspace();
    backups.stagedFacts.set('good', facts({ workspaceId: summary.id }));
    const controller = new AbortController();
    const stageRestore = backups.stageRestore.bind(backups);
    let seen: AbortSignal | null = null;
    backups.stageRestore = async (workspaceId, source, signal) => {
      seen = signal;
      return stageRestore(workspaceId, source, signal);
    };
    await manager.restore({ rootPath: ROOT, source: regular('good'), signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });

  it('an aborted restore throws what the stage threw and installs nothing', async () => {
    const { manager, backups, summary } = await closedWorkspace();
    backups.stagedFacts.set('good', facts({ workspaceId: summary.id }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      manager.restore({ rootPath: ROOT, source: regular('good'), signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'backup_failed' });
    expect(backups.installed).toEqual([]);
  });

  it('a stage that resolves after the abort is discarded and never installed', async () => {
    const { manager, backups, summary } = await closedWorkspace();
    backups.stagedFacts.set('good', facts({ workspaceId: summary.id }));
    const controller = new AbortController();
    const stageRestore = backups.stageRestore.bind(backups);
    backups.stageRestore = async (workspaceId, source, signal) => {
      const staged = await stageRestore(workspaceId, source, signal);
      controller.abort();
      return staged;
    };
    const discarded = backups.discarded;
    await expect(
      manager.restore({ rootPath: ROOT, source: regular('good'), signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'backup_failed' });
    expect(backups.discarded).toBe(discarded + 1);
    expect(backups.installed).toEqual([]);
  });

  it('restore of the open workspace is refused', async () => {
    const { manager, backups, summary } = await closedWorkspace();
    await manager.open({ rootPath: ROOT });
    backups.stagedFacts.set('good', facts({ workspaceId: summary.id }));
    const error = await manager.restore({ rootPath: `${ROOT}/`, source: regular('good') }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidOperationError);
    expect((error as Error).message).toBe(RESTORE_OPEN_MESSAGE);
    expect(backups.calls.some((call) => call.method === 'stageRestore')).toBe(false);
    expect(manager.current()?.id).toBe(summary.id);
  });

  it('restore while another workspace is open closes it first', async () => {
    const { manager, backups, summary, databases } = await closedWorkspace();
    const other = await manager.create({ name: 'Other', rootPath: OTHER_ROOT });
    backups.stagedFacts.set('good', facts({ workspaceId: summary.id }));
    await manager.restore({ rootPath: ROOT, source: regular('good') });
    expect(databases.get(other.id)!.closed).toBe(true);
    expect(manager.current()?.id).toBe(summary.id);
  });
});

describe('listBackups', () => {
  it('listing merges local, location and picked folder (both shapes), drops unreadable places, newest first, sameLineage per rule', async () => {
    const { manager, backups, summary, lineageId } = await closedWorkspace();
    const own = backupFileName(lineageId, NOW, 0);
    const foreign = backupFileName(FOREIGN_LINEAGE, new Date('2026-11-27T10:00:00.000Z'), 5);
    backups.addFile(DIRECTORY, foreign);
    backups.addFile(DIRECTORY, 'backup-info.json');
    backups.addFile(DIRECTORY, `${own}.tmp`);
    const picked = '/picked';
    const nested = join(picked, 'assetforge-backups', summary.id);
    const pickedName = backupFileName(lineageId, new Date('2026-11-26T10:00:00.000Z'), 2);
    const nestedName = backupFileName(lineageId, new Date('2026-11-25T10:00:00.000Z'), 2);
    backups.addFile(picked, pickedName);
    backups.addFile(nested, nestedName);
    backups.localFiles.set(summary.id, [
      { name: 'local-copy', sizeBytes: 10, createdAt: '2026-11-24T10:00:00.000Z', appliedMigrations: 1 },
    ]);
    backups.failures.set('listLocal', new Error('nope'));
    expect((await manager.listBackups({ workspace: { id: summary.id }, extraDirectory: null })).backups).toHaveLength(
      2,
    );
    backups.failures.clear();

    const listing = await manager.listBackups({ workspace: { id: summary.id }, extraDirectory: picked });
    expect(listing.workspaceId).toBe(summary.id);
    expect(listing.unreachable).toBe(false);
    expect(listing.backups.map((backup) => [backup.source, backup.origin, backup.sameLineage])).toEqual([
      [regular(own), 'regular', true],
      [regular(foreign), 'regular', false],
      [regular(pickedName, picked), 'regular', true],
      [regular(nestedName, nested), 'regular', true],
      [{ origin: 'pre_migration', directory: null, name: 'local-copy' }, 'pre_migration', true],
    ]);

    backups.unreachable.add(nested);
    backups.unreachable.add(DIRECTORY);
    const offline = await manager.listBackups({ workspace: { rootPath: ROOT }, extraDirectory: picked });
    expect(offline.workspaceId).toBe(summary.id);
    expect(offline.unreachable).toBe(true);
    expect(offline.backups.map((backup) => backup.source.name)).toEqual([pickedName, 'local-copy']);
  });

  it('with the database missing every entry has sameLineage false', async () => {
    const { manager, backups, summary, missingDatabases } = await closedWorkspace();
    backups.localFiles.set(summary.id, [
      { name: 'local-copy', sizeBytes: 10, createdAt: '2026-11-24T10:00:00.000Z', appliedMigrations: 1 },
    ]);
    missingDatabases.add(summary.id);
    const listing = await manager.listBackups({ workspace: { id: summary.id }, extraDirectory: null });
    expect(listing.backups).toHaveLength(2);
    expect(listing.backups.every((backup) => !backup.sameLineage)).toBe(true);
    expect(backups.calls.some((call) => call.method === 'localLineage')).toBe(false);
  });

  it('takes the lineage of the open session and of the closed file', async () => {
    const { manager, backups, summary, lineageId } = await closedWorkspace();
    backups.lineages.set(summary.id, FOREIGN_LINEAGE);
    const closed = await manager.listBackups({ workspace: { id: summary.id }, extraDirectory: null });
    expect(closed.backups.map((backup) => backup.sameLineage)).toEqual([false]);

    await manager.open({ rootPath: ROOT });
    const open = await manager.listBackups({ workspace: { id: summary.id }, extraDirectory: null });
    expect(open.backups.map((backup) => backup.sameLineage)).toEqual([true]);
    expect(open.backups[0]!.source.name).toBe(backupFileName(lineageId, NOW, 0));
  });

  it('a failing lineage read counts as unknown and a failing place as unreachable', async () => {
    const { manager, backups, summary } = await closedWorkspace();
    backups.failures.set('localLineage', new Error('locked'));
    const unknown = await manager.listBackups({ workspace: { id: summary.id }, extraDirectory: null });
    expect(unknown.backups).toHaveLength(1);
    expect(unknown.backups[0]!.sameLineage).toBe(false);
    backups.failures.clear();

    backups.failures.set('locationOf', new Error('settings gone'));
    const offline = await manager.listBackups({ workspace: { id: summary.id }, extraDirectory: null });
    expect(offline).toMatchObject({ unreachable: true, backups: [] });
  });

  it('a failing lineage read of the open database counts as unknown', async () => {
    const { manager, databases, summary } = await closedWorkspace();
    await manager.open({ rootPath: ROOT });
    databases.get(summary.id)!.meta.get = async () => {
      throw new Error('closed');
    };
    const listing = await manager.listBackups({ workspace: { id: summary.id }, extraDirectory: null });
    expect(listing.backups.every((backup) => !backup.sameLineage)).toBe(true);
  });

  it('a picked folder that is the place itself, with a trailing separator, lists each backup once', async () => {
    const { manager, backups, summary } = await closedWorkspace();
    // The picked spelling lists the same files as the place.
    backups.directories.set(`${DIRECTORY}/`, backups.directories.get(DIRECTORY)!);
    const listing = await manager.listBackups({ workspace: { id: summary.id }, extraDirectory: `${DIRECTORY}/` });
    expect(listing.backups).toHaveLength(1);
  });

  it('an unknown id is refused', async () => {
    const { manager } = setup();
    await expect(
      manager.listBackups({ workspace: { id: crypto.randomUUID() }, extraDirectory: null }),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });
});
