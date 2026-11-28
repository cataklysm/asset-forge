import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupError, type SnapshotFacts } from '@assetforge/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { checkExited, createBackupChecker, isCheckRunning, type BackupChecker } from '../src/backup-check.js';
import { MIGRATIONS_FOLDER } from '../src/index.js';
import {
  LOCAL_TEMPORARY_PATTERN,
  snapshotClosedDatabase,
  snapshotOpenDatabase,
  sweepLocalTemporary,
} from '../src/database-snapshot.js';
import { createWorkspaceDatabase, realChecker, shippedMigrationCount, WORKSPACE_ID } from './backup-fixtures.js';

const LINEAGE = 'a'.repeat(32);
const FACTS: SnapshotFacts = {
  workspaceId: WORKSPACE_ID,
  lineageId: LINEAGE,
  formatVersion: 1,
  appliedMigrations: 1,
  newerThanApp: false,
};
const fakeChecker: BackupChecker = async () => FACTS;
const BUSY_WORKER_URL = new URL('./busy-check-worker.mjs', import.meta.url);

let dir: string;
let open: Database.Database[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-snapshot-'));
});

afterEach(async () => {
  for (const sqlite of open) if (sqlite.open) sqlite.close();
  open = [];
  await rm(dir, { recursive: true, force: true });
});

/**
 * A connection kept open until the test ends.
 *
 * @param path the database file
 * @returns the connection
 */
function connect(path: string): Database.Database {
  const sqlite = new Database(path);
  open.push(sqlite);
  return sqlite;
}

/**
 * A database of about 1000 pages: rows in `item` and their count in `counter`, always written together.
 *
 * @returns the connection
 */
function largeDatabase(): Database.Database {
  const sqlite = connect(join(dir, 'assetforge.sqlite'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, pad BLOB); CREATE TABLE counter (total INTEGER);');
  sqlite.prepare('INSERT INTO counter (total) VALUES (0)').run();
  for (let i = 0; i < 2000; i++) addItem(sqlite);
  return sqlite;
}

/**
 * Inserts one row and raises the counter in one transaction.
 *
 * @param sqlite the connection
 */
function addItem(sqlite: Database.Database): void {
  sqlite.transaction(() => {
    sqlite.prepare('INSERT INTO item (pad) VALUES (?)').run(Buffer.alloc(2000, 7));
    sqlite.prepare('UPDATE counter SET total = total + 1').run();
  })();
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

/** The temporary files left in the test directory. */
async function temporaryFiles(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => LOCAL_TEMPORARY_PATTERN.test(name));
}

describe('snapshot of the open database', () => {
  test('snapshot of an open database while writes go on holds a consistent row count', async () => {
    const sqlite = largeDatabase();
    let writes = 0;
    let running = true;
    const writer = (): void => {
      if (!running) return;
      addItem(sqlite);
      writes++;
      setImmediate(writer);
    };
    setImmediate(writer);
    const snapshot = await snapshotOpenDatabase(
      sqlite,
      join(dir, 'assetforge.sqlite'),
      fakeChecker,
      new AbortController().signal,
    );
    running = false;
    expect(writes).toBeGreaterThan(0);
    const copy = connect(snapshot.path);
    const items = (copy.prepare('SELECT count(*) AS n FROM item').get() as { n: number }).n;
    const counted = (copy.prepare('SELECT total FROM counter').get() as { total: number }).total;
    expect(items).toBe(counted);
    expect(items).toBeGreaterThanOrEqual(2000);
    expect(copy.pragma('quick_check', { simple: true })).toBe('ok');
    copy.close();
    await snapshot.discard();
    expect(await temporaryFiles()).toEqual([]);
  });

  test('aborted snapshot leaves no temp file', async () => {
    const sqlite = largeDatabase();
    const controller = new AbortController();
    const snapshot = snapshotOpenDatabase(sqlite, join(dir, 'assetforge.sqlite'), fakeChecker, controller.signal);
    setImmediate(() => controller.abort());
    await expect(snapshot).rejects.toMatchObject({ code: 'backup_failed' });
    expect(await temporaryFiles()).toEqual([]);
  });

  test('a snapshot aborted during the check leaves no temp file once the worker has exited', async () => {
    const { path } = await createWorkspaceDatabase(dir);
    const sqlite = connect(path);
    const controller = new AbortController();
    const check: BackupChecker = (copy, signal) => {
      const answer = realChecker()(copy, signal);
      controller.abort();
      return answer;
    };
    await expect(snapshotOpenDatabase(sqlite, path, check, controller.signal)).rejects.toBeInstanceOf(BackupError);
    await vi.waitFor(async () => expect(await temporaryFiles()).toEqual([]));
  });

  test('an abort during a busy check frees the caller at once and removes the copy after the worker exited', async () => {
    const { path } = await createWorkspaceDatabase(dir);
    const sqlite = connect(path);
    const busy = createBackupChecker({ workerUrl: BUSY_WORKER_URL, migrationsFolder: MIGRATIONS_FOLDER });
    const controller = new AbortController();
    let checked = '';
    const check: BackupChecker = (copy, signal) => {
      checked = copy;
      setTimeout(() => controller.abort(), 300);
      return busy(copy, signal);
    };
    const snapshot = snapshotOpenDatabase(sqlite, path, check, controller.signal);
    await expect(snapshot).rejects.toMatchObject({ code: 'backup_failed' });
    expect(isCheckRunning(checked)).toBe(true);
    await checkExited(checked);
    await vi.waitFor(async () => expect(await temporaryFiles()).toEqual([]));
  }, 60_000);

  test('a copy that fails its check is refused and removed', async () => {
    const sqlite = largeDatabase();
    const noFacts: BackupChecker = async () => null;
    const noLineage: BackupChecker = async () => ({ ...FACTS, lineageId: null });
    for (const check of [noFacts, noLineage]) {
      await expect(
        snapshotOpenDatabase(sqlite, join(dir, 'assetforge.sqlite'), check, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'backup_failed' });
    }
    expect(await temporaryFiles()).toEqual([]);
  });

  test('snapshot facts carry id, lineage and applied count', async () => {
    const { path, lineageId } = await createWorkspaceDatabase(dir);
    const sqlite = connect(path);
    sqlite.prepare("UPDATE workspace SET name = 'Changed'").run();
    const snapshot = await snapshotOpenDatabase(sqlite, path, realChecker(), new AbortController().signal);
    expect(snapshot).toMatchObject({
      workspaceId: WORKSPACE_ID,
      lineageId,
      formatVersion: 1,
      appliedMigrations: await shippedMigrationCount(),
      newerThanApp: false,
      changeCount: 1,
    });
    expect(snapshot.path.startsWith(dir)).toBe(true);
    expect(snapshot.sizeBytes).toBeGreaterThan(0);
    await snapshot.discard();
    expect(await temporaryFiles()).toEqual([]);
  });
});

describe('snapshot of a closed database', () => {
  /**
   * A closed database whose last write is still in its `-wal`: the files of a live connection copied aside.
   *
   * @returns the path of the copied database
   */
  async function closedWithWal(): Promise<string> {
    const { path } = await createWorkspaceDatabase(dir, 'live.sqlite');
    const sqlite = connect(path);
    sqlite.pragma('wal_autocheckpoint = 0');
    sqlite.prepare("UPDATE workspace SET name = 'In the WAL'").run();
    const closed = join(dir, 'closed');
    await mkdir(closed);
    await copyFile(path, join(closed, 'assetforge.sqlite'));
    await copyFile(`${path}-wal`, join(closed, 'assetforge.sqlite-wal'));
    sqlite.close();
    return join(closed, 'assetforge.sqlite');
  }

  test('closed snapshot includes rows still in the WAL', async () => {
    const path = await closedWithWal();
    const snapshot = await snapshotClosedDatabase(path, realChecker(), new AbortController().signal);
    expect(snapshot.changeCount).toBe(0);
    const copy = new Database(snapshot.path, { readonly: true });
    try {
      expect(copy.prepare('SELECT name FROM workspace').get()).toEqual({ name: 'In the WAL' });
    } finally {
      copy.close();
    }
    await snapshot.discard();
    expect((await readdir(join(dir, 'closed'))).sort()).toEqual(['assetforge.sqlite', 'assetforge.sqlite-wal']);
  });

  test('the live file and its -wal are unchanged by a closed snapshot', async () => {
    const path = await closedWithWal();
    const before = [await checksum(path), await checksum(`${path}-wal`)];
    const snapshot = await snapshotClosedDatabase(path, realChecker(), new AbortController().signal);
    await snapshot.discard();
    expect([await checksum(path), await checksum(`${path}-wal`)]).toEqual(before);
  });

  test('a closed snapshot copies a -journal beside the copy for the check to roll back', async () => {
    const { path } = await createWorkspaceDatabase(dir);
    await writeFile(`${path}-journal`, 'journal');
    let journal: string | null = null;
    const check: BackupChecker = async (copy) => {
      journal = await readFile(`${copy}-journal`, 'utf8');
      return FACTS;
    };
    const snapshot = await snapshotClosedDatabase(path, check, new AbortController().signal);
    expect(journal).toBe('journal');
    await snapshot.discard();
    expect(await temporaryFiles()).toEqual([]);
    expect(await readFile(`${path}-journal`, 'utf8')).toBe('journal');
  });

  test('a closed snapshot aborted during a busy check rejects at once and its copy goes after the worker exited', async () => {
    const { path } = await createWorkspaceDatabase(dir);
    const busy = createBackupChecker({ workerUrl: BUSY_WORKER_URL, migrationsFolder: MIGRATIONS_FOLDER });
    const controller = new AbortController();
    let checked = '';
    let abortedAt = 0;
    const check: BackupChecker = (copy, checkSignal) => {
      checked = copy;
      setTimeout(() => {
        abortedAt = Date.now();
        controller.abort();
      }, 300);
      return busy(copy, checkSignal);
    };
    await expect(snapshotClosedDatabase(path, check, controller.signal)).rejects.toMatchObject({
      code: 'backup_failed',
    });
    expect(Date.now() - abortedAt).toBeLessThan(200);
    expect(isCheckRunning(checked)).toBe(true);
    await checkExited(checked);
    await vi.waitFor(async () => expect(await temporaryFiles()).toEqual([]));
  }, 60_000);

  test('a missing database answers backup_failed', async () => {
    await expect(
      snapshotClosedDatabase(join(dir, 'assetforge.sqlite'), realChecker(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'backup_failed' });
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('sweep of temporary files', () => {
  test('sweep removes snapshot/restore temps with side files and nothing else', async () => {
    const uuid = '0123abcd-0123-4123-8123-0123456789ab';
    const removed = [
      `assetforge.sqlite.snapshot-${uuid}.tmp`,
      `assetforge.sqlite.snapshot-${uuid}.tmp-wal`,
      `assetforge.sqlite.restore-${uuid}.tmp`,
      `assetforge.sqlite.restore-${uuid}.tmp-journal`,
      `assetforge.sqlite.restore-${uuid}.tmp-shm`,
    ];
    const kept = [
      'assetforge.sqlite',
      'assetforge.sqlite-wal',
      'assetforge.sqlite.backup-3-20261128090503',
      'assetforge.sqlite.replaced-20261128T090503Z',
      `assetforge.sqlite.snapshot-${uuid}.tmp.old`,
      `other.sqlite.snapshot-${uuid}.tmp`,
    ];
    for (const name of [...removed, ...kept]) await writeFile(join(dir, name), 'x');
    await sweepLocalTemporary(dir);
    expect((await readdir(dir)).sort()).toEqual([...kept].sort());
  });

  test('sweep of a missing directory does nothing', async () => {
    await expect(sweepLocalTemporary(join(dir, 'missing'))).resolves.toBeUndefined();
  });
});
