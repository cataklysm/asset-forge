import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_UNREADABLE_MESSAGE } from '@assetforge/contracts';
import { BackupError, InvalidOperationError, type BackupSource } from '@assetforge/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createDatabaseBackups, type DatabaseBackupsOptions } from '../src/database-backups.js';
import { LOCAL_TEMPORARY_PATTERN } from '../src/database-snapshot.js';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';
import { createWorkspaceDatabase, realChecker, shippedMigrationCount, WORKSPACE_ID } from './backup-fixtures.js';
import { migrationsUpTo } from './migrations-folder.js';

const NOW = new Date('2026-11-28T09:05:03Z');

let dir: string;
let databaseDirectory: string;
let live: string;
let regular: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-backups-'));
  databaseDirectory = join(dir, 'db');
  live = join(databaseDirectory, 'assetforge.sqlite');
  regular = join(dir, 'place');
  await mkdir(regular);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * The backups over the test directory; regular sources are copied from `join(source.directory, source.name)`.
 *
 * @param overrides options to replace
 * @returns the backups
 */
function backups(overrides: Partial<DatabaseBackupsOptions> = {}): ReturnType<typeof createDatabaseBackups> {
  return createDatabaseBackups({
    databaseFilePathOf: (workspaceId) => (workspaceId === WORKSPACE_ID ? live : join(dir, 'none', 'assetforge.sqlite')),
    check: realChecker(),
    copyIn: (source, destinationPath) => copyFile(join(source.directory!, source.name), destinationPath),
    now: () => NOW,
    ...overrides,
  });
}

/**
 * The SHA-256 of a file.
 *
 * @param path the file
 * @returns the hex digest
 */
async function checksum(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/** The temporary files left in the database directory. */
async function temporaryFiles(): Promise<string[]> {
  return (await readdir(databaseDirectory)).filter((name) => LOCAL_TEMPORARY_PATTERN.test(name));
}

const signal = (): AbortSignal => new AbortController().signal;

describe('stageRestore', () => {
  test('stageRestore of a damaged copy answers facts null and leaves the live file untouched', async () => {
    await createWorkspaceDatabase(databaseDirectory);
    const before = await checksum(live);
    await writeFile(join(regular, 'damaged.sqlite'), 'not a database at all '.repeat(100));
    const staged = await backups().stageRestore(
      WORKSPACE_ID,
      { origin: 'regular', directory: regular, name: 'damaged.sqlite' },
      signal(),
    );
    expect(staged.facts).toBeNull();
    expect(await checksum(live)).toBe(before);
    await staged.discard();
    expect(await temporaryFiles()).toEqual([]);
  });

  test('a good copy answers its facts and install puts it in place', async () => {
    const { lineageId } = await createWorkspaceDatabase(regular, 'good.sqlite');
    await createWorkspaceDatabase(databaseDirectory);
    const staged = await backups().stageRestore(
      WORKSPACE_ID,
      { origin: 'regular', directory: regular, name: 'good.sqlite' },
      signal(),
    );
    expect(staged.facts).toMatchObject({ workspaceId: WORKSPACE_ID, lineageId });
    await staged.install();
    expect(await backups().localLineage(WORKSPACE_ID)).toBe(lineageId);
    expect((await readdir(databaseDirectory)).sort()).toEqual([
      'assetforge.sqlite',
      'assetforge.sqlite.replaced-20261128T090503Z',
    ]);
  });

  test('discard removes the restore temp', async () => {
    await createWorkspaceDatabase(regular, 'good.sqlite');
    const staged = await backups().stageRestore(
      WORKSPACE_ID,
      { origin: 'regular', directory: regular, name: 'good.sqlite' },
      signal(),
    );
    expect(await temporaryFiles()).toHaveLength(1);
    await staged.discard();
    expect(await temporaryFiles()).toEqual([]);
  });

  test('a pre_migration source with a regular name is refused', async () => {
    await createWorkspaceDatabase(databaseDirectory);
    await copyFile(live, join(databaseDirectory, 'assetforge.sqlite.copy'));
    for (const source of [
      { origin: 'pre_migration', directory: null, name: 'assetforge.sqlite.copy' },
      { origin: 'pre_migration', directory: null, name: '../place/assetforge.sqlite.backup-3-20261128090503' },
      { origin: 'pre_migration', directory: regular, name: 'assetforge.sqlite.backup-3-20261128090503' },
    ] satisfies BackupSource[]) {
      const answer = backups().stageRestore(WORKSPACE_ID, source, signal());
      await expect(answer).rejects.toBeInstanceOf(InvalidOperationError);
      await expect(answer).rejects.toThrow(BACKUP_UNREADABLE_MESSAGE);
    }
    expect(await temporaryFiles()).toEqual([]);
  });

  test('a pre_migration source is copied from beside the database', async () => {
    const { lineageId } = await createWorkspaceDatabase(databaseDirectory);
    const name = 'assetforge.sqlite.backup-3-20261128090503';
    await copyFile(live, join(databaseDirectory, name));
    const staged = await backups().stageRestore(
      WORKSPACE_ID,
      { origin: 'pre_migration', directory: null, name },
      signal(),
    );
    expect(staged.facts).toMatchObject({ lineageId });
    await staged.discard();
  });

  test('a failing copy answers the unreadable message and leaves no temp file', async () => {
    await createWorkspaceDatabase(databaseDirectory);
    const failing = backups({
      copyIn: async (_source, destinationPath) => {
        await writeFile(destinationPath, 'partial');
        throw new Error('gone');
      },
    });
    await expect(
      failing.stageRestore(WORKSPACE_ID, { origin: 'regular', directory: regular, name: 'x' }, signal()),
    ).rejects.toThrow(BACKUP_UNREADABLE_MESSAGE);
    expect(await temporaryFiles()).toEqual([]);
  });

  test('install of a copy without facts is refused and the live file stays', async () => {
    await createWorkspaceDatabase(databaseDirectory);
    const before = await checksum(live);
    await writeFile(join(regular, 'damaged.sqlite'), 'not a database at all '.repeat(100));
    const staged = await backups().stageRestore(
      WORKSPACE_ID,
      { origin: 'regular', directory: regular, name: 'damaged.sqlite' },
      signal(),
    );
    await expect(staged.install()).rejects.toMatchObject({ code: 'backup_failed' });
    expect(await checksum(live)).toBe(before);
    await staged.discard();
    expect(await temporaryFiles()).toEqual([]);
  });

  test('an aborted stage answers backup_failed, during the copy and during the check', async () => {
    await createWorkspaceDatabase(regular, 'good.sqlite');
    const duringCopy = new AbortController();
    const copyAborted = backups({
      copyIn: async () => {
        duringCopy.abort();
        throw new Error('stopped');
      },
    }).stageRestore(WORKSPACE_ID, { origin: 'regular', directory: regular, name: 'good.sqlite' }, duringCopy.signal);
    await expect(copyAborted).rejects.toBeInstanceOf(BackupError);
    await expect(copyAborted).rejects.toMatchObject({ code: 'backup_failed' });
    const duringCheck = new AbortController();
    const checkAborted = backups({
      check: async () => {
        duringCheck.abort();
        return null;
      },
    }).stageRestore(WORKSPACE_ID, { origin: 'regular', directory: regular, name: 'good.sqlite' }, duringCheck.signal);
    await expect(checkAborted).rejects.toMatchObject({ code: 'backup_failed' });
    expect(await temporaryFiles()).toEqual([]);
  });

  test('a restored copy with an older schema opens migrated, with its lineage and in WAL mode', async () => {
    const { lineageId } = await createWorkspaceDatabase(regular, 'good.sqlite');
    await createWorkspaceDatabase(databaseDirectory);
    const newer = await migrationsUpTo(join(dir, 'newer'), await shippedMigrationCount(), [
      { tag: '9999_later', sql: 'CREATE TABLE later (id integer);' },
    ]);
    const staged = await backups({ check: realChecker(newer) }).stageRestore(
      WORKSPACE_ID,
      { origin: 'regular', directory: regular, name: 'good.sqlite' },
      signal(),
    );
    expect(staged.facts).toMatchObject({ lineageId, appliedMigrations: await shippedMigrationCount() });
    await staged.install();
    const database = await openWorkspaceDatabase(live, newer);
    try {
      expect((await database.meta.get())!.lineageId).toBe(lineageId);
    } finally {
      await database.close();
    }
    const sqlite = new Database(live);
    try {
      expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'later'").get()).toEqual({ name: 'later' });
    } finally {
      sqlite.close();
    }
    expect((await readdir(databaseDirectory)).some((name) => name.includes('.restore-'))).toBe(false);
  });

  test('stageRestore creates a missing database directory', async () => {
    await createWorkspaceDatabase(regular, 'good.sqlite');
    const staged = await backups().stageRestore(
      WORKSPACE_ID,
      { origin: 'regular', directory: regular, name: 'good.sqlite' },
      signal(),
    );
    expect(staged.facts).not.toBeNull();
    await staged.install();
    expect(await readdir(databaseDirectory)).toEqual(['assetforge.sqlite']);
  });
});

describe('local database', () => {
  test('localLineage of a missing file is null', async () => {
    expect(await backups().localLineage('22222222-2222-4222-8222-222222222222')).toBeNull();
    expect(await readdir(dir)).toEqual(['place']);
  });

  test('localLineage reads the lineage of a closed database without leaving side files', async () => {
    const { lineageId } = await createWorkspaceDatabase(databaseDirectory);
    expect(await backups().localLineage(WORKSPACE_ID)).toBe(lineageId);
    expect(await readdir(databaseDirectory)).toEqual(['assetforge.sqlite']);
  });

  test('localLineage of an unreadable file is null', async () => {
    await mkdir(databaseDirectory);
    await writeFile(live, 'not a database '.repeat(100));
    expect(await backups().localLineage(WORKSPACE_ID)).toBeNull();
  });

  test('listLocal lists the pre-migration copies with size, UTC stamp and applied count', async () => {
    await createWorkspaceDatabase(databaseDirectory);
    await writeFile(join(databaseDirectory, 'assetforge.sqlite.backup-3-20261128090503'), 'abc');
    await writeFile(join(databaseDirectory, 'assetforge.sqlite.backup-4-20261399000000'), 'bad stamp');
    await writeFile(join(databaseDirectory, 'assetforge.sqlite.backup-5-20261128090503.tmp'), 'temporary');
    expect(await backups().listLocal(WORKSPACE_ID)).toEqual([
      {
        name: 'assetforge.sqlite.backup-3-20261128090503',
        sizeBytes: 3,
        createdAt: '2026-11-28T09:05:03.000Z',
        appliedMigrations: 3,
      },
    ]);
    expect(await backups().listLocal('22222222-2222-4222-8222-222222222222')).toEqual([]);
  });

  test('snapshotClosed copies and checks the closed database', async () => {
    const { lineageId } = await createWorkspaceDatabase(databaseDirectory);
    const snapshot = await backups().snapshotClosed(WORKSPACE_ID, signal());
    expect(snapshot).toMatchObject({ lineageId, changeCount: 0, appliedMigrations: await shippedMigrationCount() });
    await snapshot.discard();
    expect(await temporaryFiles()).toEqual([]);
  });
});

describe('snapshot of an opened workspace database', () => {
  test('snapshot uses the check given to the open', async () => {
    const { lineageId } = await createWorkspaceDatabase(databaseDirectory);
    const database = await openWorkspaceDatabase(live, MIGRATIONS_FOLDER, { check: realChecker() });
    try {
      const snapshot = await database.snapshot({ signal: signal() });
      expect(snapshot.lineageId).toBe(lineageId);
      await snapshot.discard();
    } finally {
      await database.close();
    }
  });

  test('snapshot without a check answers backup_failed', async () => {
    await createWorkspaceDatabase(databaseDirectory);
    const database = await openWorkspaceDatabase(live, MIGRATIONS_FOLDER);
    try {
      await expect(database.snapshot({ signal: signal() })).rejects.toMatchObject({ code: 'backup_failed' });
    } finally {
      await database.close();
    }
  });

  test('the open sweeps leftover temporary files', async () => {
    await createWorkspaceDatabase(databaseDirectory);
    const leftover = join(databaseDirectory, 'assetforge.sqlite.snapshot-0123abcd-0123-4123-8123-0123456789ab.tmp');
    await writeFile(leftover, 'x');
    await writeFile(`${leftover}-wal`, 'x');
    const database = await openWorkspaceDatabase(live, MIGRATIONS_FOLDER);
    await database.close();
    expect(await temporaryFiles()).toEqual([]);
  });
});
