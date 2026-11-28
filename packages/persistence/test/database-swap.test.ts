import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupError } from '@assetforge/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { isPreMigrationBackupName } from '../src/database-backup.js';
import { LOCAL_TEMPORARY_PATTERN } from '../src/database-snapshot.js';
import { installDatabase, replacedName, revertInstall, type SwapFileSystem } from '../src/database-swap.js';

const NOW = new Date('2026-11-28T09:05:03.456Z');
const STAMP = 'assetforge.sqlite.replaced-20261128T090503Z';

let dir: string;
let live: string;
let staged: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-swap-'));
  live = join(dir, 'assetforge.sqlite');
  staged = join(dir, 'assetforge.sqlite.restore-0123abcd-0123-4123-8123-0123456789ab.tmp');
  await writeFile(staged, 'staged');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Writes the live database with its side files.
 *
 * @returns resolves once written
 */
async function writeLive(): Promise<void> {
  await writeFile(live, 'live');
  await writeFile(`${live}-wal`, 'wal');
  await writeFile(`${live}-shm`, 'shm');
}

/** The sorted names in the test directory. */
async function names(): Promise<string[]> {
  return (await readdir(dir)).sort();
}

describe('installDatabase', () => {
  test('replacedName names the database with a UTC stamp', () => {
    expect(replacedName(NOW)).toBe(STAMP);
    expect(replacedName(NOW, 'other.sqlite')).toBe('other.sqlite.replaced-20261128T090503Z');
  });

  test('install moves db, -wal and -shm aside under one stamp', async () => {
    await writeLive();
    await installDatabase(live, staged, NOW);
    expect(await names()).toEqual(['assetforge.sqlite', STAMP, `${STAMP}-shm`, `${STAMP}-wal`]);
    expect(await readFile(live, 'utf8')).toBe('staged');
    expect(await readFile(join(dir, STAMP), 'utf8')).toBe('live');
    expect(await readFile(join(dir, `${STAMP}-wal`), 'utf8')).toBe('wal');
  });

  test('install without a live database just places the copy', async () => {
    await installDatabase(live, staged, NOW);
    expect(await names()).toEqual(['assetforge.sqlite']);
    expect(await readFile(live, 'utf8')).toBe('staged');
  });

  test('side files without a main file are moved aside too', async () => {
    await writeFile(`${live}-wal`, 'foreign wal');
    await installDatabase(live, staged, NOW);
    expect(await names()).toEqual(['assetforge.sqlite', `${STAMP}-wal`]);
  });

  test('a failing rename of the main file restores -wal and -shm', async () => {
    await writeLive();
    const failing: SwapFileSystem = {
      rename: async (from, to) => {
        if (from === live) throw new Error('locked');
        await rename(from, to);
      },
    };
    await expect(installDatabase(live, staged, NOW, failing)).rejects.toBeInstanceOf(BackupError);
    expect(await names()).toEqual([
      'assetforge.sqlite',
      'assetforge.sqlite-shm',
      'assetforge.sqlite-wal',
      'assetforge.sqlite.restore-0123abcd-0123-4123-8123-0123456789ab.tmp',
    ]);
    expect(await readFile(live, 'utf8')).toBe('live');
    expect(await readFile(`${live}-wal`, 'utf8')).toBe('wal');
  });

  test('a failing rename of the staged copy puts the original back', async () => {
    await writeLive();
    const failing: SwapFileSystem = {
      rename: async (from, to) => {
        if (from === staged) throw new Error('locked');
        await rename(from, to);
      },
    };
    await expect(installDatabase(live, staged, NOW, failing)).rejects.toMatchObject({ code: 'backup_failed' });
    expect(await readFile(live, 'utf8')).toBe('live');
    expect(await readFile(`${live}-shm`, 'utf8')).toBe('shm');
    expect((await names()).some((name) => name.includes('.replaced-'))).toBe(false);
  });

  test('equal stamps get a counter', async () => {
    await writeFile(live, 'first');
    await installDatabase(live, staged, NOW);
    await writeFile(staged, 'second');
    await installDatabase(live, staged, NOW);
    expect(await names()).toEqual(['assetforge.sqlite', STAMP, `${STAMP}-2`]);
    expect(await readFile(join(dir, `${STAMP}-2`), 'utf8')).toBe('staged');
  });

  test('only the newest 2 replaced sets are kept', async () => {
    for (const minute of [1, 2, 3, 4]) {
      await writeLive();
      await writeFile(staged, `copy ${minute}`);
      await installDatabase(live, staged, new Date(`2026-11-28T09:0${minute}:00Z`));
    }
    expect(await names()).toEqual([
      'assetforge.sqlite',
      'assetforge.sqlite.replaced-20261128T090300Z',
      'assetforge.sqlite.replaced-20261128T090300Z-shm',
      'assetforge.sqlite.replaced-20261128T090300Z-wal',
      'assetforge.sqlite.replaced-20261128T090400Z',
      'assetforge.sqlite.replaced-20261128T090400Z-shm',
      'assetforge.sqlite.replaced-20261128T090400Z-wal',
    ]);
  });

  test('a -journal is moved aside with the database and back on a failure', async () => {
    await writeFile(live, 'live');
    await writeFile(`${live}-journal`, 'journal');
    const failing: SwapFileSystem = {
      rename: async (from, to) => {
        if (from === staged) throw new Error('locked');
        await rename(from, to);
      },
    };
    await expect(installDatabase(live, staged, NOW, failing)).rejects.toBeInstanceOf(BackupError);
    expect(await readFile(`${live}-journal`, 'utf8')).toBe('journal');
    await installDatabase(live, staged, NOW);
    expect(await names()).toEqual(['assetforge.sqlite', STAMP, `${STAMP}-journal`]);
  });

  test('the set just moved aside survives two sets stamped in the future', async () => {
    const future = ['assetforge.sqlite.replaced-20991231T000000Z', 'assetforge.sqlite.replaced-20991231T000001Z'];
    for (const name of future) {
      await writeFile(join(dir, name), 'future');
      await writeFile(join(dir, `${name}-wal`), 'future wal');
    }
    await writeLive();
    await installDatabase(live, staged, NOW);
    expect(await names()).toEqual([
      'assetforge.sqlite',
      STAMP,
      `${STAMP}-shm`,
      `${STAMP}-wal`,
      future[1],
      `${future[1]}-wal`,
    ]);
    expect(await readFile(join(dir, STAMP), 'utf8')).toBe('live');
  });

  test('install answers the name of the set it created, or null when it replaced nothing', async () => {
    expect(await installDatabase(live, staged, NOW)).toBeNull();
    await writeFile(staged, 'second');
    expect(await installDatabase(live, staged, NOW)).toBe(STAMP);
  });

  test('revertInstall puts the set back and leaves other sets alone', async () => {
    await writeLive();
    await writeFile(join(dir, `${STAMP}-2`), 'other set');
    const created = await installDatabase(live, staged, NOW);
    expect(created).toBe(STAMP);
    await writeFile(`${live}-journal`, 'journal of the failed open');
    await revertInstall(live, created);
    expect(await names()).toEqual([
      'assetforge.sqlite',
      'assetforge.sqlite-shm',
      'assetforge.sqlite-wal',
      `${STAMP}-2`,
    ]);
    expect(await readFile(live, 'utf8')).toBe('live');
  });

  test('revertInstall without a set removes the installed database only', async () => {
    await installDatabase(live, staged, NOW);
    await writeFile(`${live}-wal`, 'wal');
    await revertInstall(live, null);
    expect(await names()).toEqual([]);
    await expect(revertInstall(live, `${STAMP}-9`)).resolves.toBeUndefined();
  });

  test('replaced files are never matched by the pre-migration or temp patterns', () => {
    for (const suffix of ['', '-2', '-wal', '-2-shm', '-journal']) {
      const name = STAMP + suffix;
      expect(isPreMigrationBackupName('assetforge.sqlite', name)).toBe(false);
      expect(LOCAL_TEMPORARY_PATTERN.test(name)).toBe(false);
    }
  });
});
