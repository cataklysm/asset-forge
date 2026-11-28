import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_FOLDER_NAME, BACKUP_INFO_FILE } from '@assetforge/contracts';
import { backupFileName, type DatabaseSnapshot } from '@assetforge/core';
import { createBackupTarget, nearestFreeBytes, type BackupTarget } from '../src/main/backup-target.js';

const ID = '11111111-1111-4111-8111-111111111111';
const LINEAGE = 'abcdef012345-0000-4000-8000-000000000000';

let base: string;
let root: string;
let chosen: string | null;
let free: number | null;
let target: BackupTarget;
let snapshot: DatabaseSnapshot;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'af-backup-target-'));
  root = join(base, 'root');
  await mkdir(root);
  chosen = null;
  free = null;
  target = createBackupTarget({
    registry: { backupDirectory: async () => chosen },
    freeBytes: async () => free,
    forbiddenRoots: async () => ({ workspaceRoots: [root], userDataPath: join(base, 'userData') }),
  });
  const path = join(base, 'snapshot.tmp');
  await writeFile(path, Buffer.alloc(4096, 7));
  snapshot = {
    lineageId: LINEAGE,
    workspaceId: ID,
    formatVersion: 1,
    appliedMigrations: 19,
    newerThanApp: false,
    path,
    sizeBytes: 4096,
    changeCount: 0,
    discard: async () => undefined,
  };
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/**
 * @param at the time of the backup
 * @returns a backup name for the test lineage
 */
function nameAt(at: string): string {
  return backupFileName(LINEAGE, new Date(at), 19);
}

/**
 * @param path a file
 * @returns whether it exists
 */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** @returns the place of the test workspace */
function location() {
  return target.locationOf({ id: ID, name: 'Own', rootPath: root });
}

describe('backup target', () => {
  it('write streams to .tmp and renames; no file opened by SQLite at the target', async () => {
    const place = await location();
    const name = nameAt('2026-11-28T10:00:00Z');
    await target.write(snapshot, place, name, new AbortController().signal);
    expect(await readdir(place.directory)).toEqual([name]);
    expect((await readFile(join(place.directory, name))).length).toBe(4096);
    const listed = await target.list(place.directory);
    expect(listed).toEqual([expect.objectContaining({ name, sizeBytes: 4096 })]);
  });

  it('free space below size answers backup_no_space and writes nothing', async () => {
    free = 100;
    const place = await location();
    await expect(
      target.write(snapshot, place, nameAt('2026-11-28T10:00:00Z'), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'backup_no_space' });
    expect(await target.list(place.directory)).toEqual([]);
  });

  it('missing chosen folder answers backup_location_unreachable and lists as unreachable', async () => {
    chosen = join(base, 'gone');
    const place = await location();
    expect(place).toMatchObject({ kind: 'chosen', chosenPath: chosen });
    await expect(
      target.write(snapshot, place, nameAt('2026-11-28T10:00:00Z'), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'backup_location_unreachable' });
    await expect(target.list(place.directory)).rejects.toMatchObject({ code: 'backup_location_unreachable' });
  });

  it('a default place never written lists as empty', async () => {
    const place = await location();
    expect(await target.list(place.directory)).toEqual([]);
  });

  it('abort removes the .tmp', async () => {
    const place = await location();
    const controller = new AbortController();
    controller.abort();
    await expect(
      target.write(snapshot, place, nameAt('2026-11-28T10:00:00Z'), controller.signal),
    ).rejects.toMatchObject({ code: 'backup_failed' });
    expect(await readdir(place.directory)).toEqual([]);
  });

  it('stale .tmp of the pattern is swept, other files untouched', async () => {
    const place = await location();
    await mkdir(place.directory, { recursive: true });
    const stale = `${nameAt('2026-11-27T10:00:00Z')}.tmp`;
    const staleAttempt = `${nameAt('2026-11-27T11:00:00Z')}.0a1b2c3d-0000-4000-8000-000000000000.tmp`;
    await writeFile(join(place.directory, stale), 'x');
    await writeFile(join(place.directory, staleAttempt), 'x');
    await writeFile(join(place.directory, 'notes.tmp'), 'x');
    const name = nameAt('2026-11-28T10:00:00Z');
    await target.write(snapshot, place, name, new AbortController().signal);
    expect((await readdir(place.directory)).sort()).toEqual([name, 'notes.tmp'].sort());
  });

  it('two overlapping attempts never clobber each other', async () => {
    const place = await location();
    const first = nameAt('2026-11-28T10:00:00Z');
    const second = nameAt('2026-11-28T10:00:01Z');
    await Promise.all([
      target.write(snapshot, place, first, new AbortController().signal),
      target.write(snapshot, place, second, new AbortController().signal),
    ]);
    expect((await readdir(place.directory)).sort()).toEqual([first, second].sort());
  });

  it('backup-info.json written once for a chosen place, never for the default place', async () => {
    const place = await location();
    await target.write(snapshot, place, nameAt('2026-11-28T10:00:00Z'), new AbortController().signal);
    expect(await readdir(place.directory)).not.toContain(BACKUP_INFO_FILE);
    chosen = join(base, 'chosen');
    await mkdir(chosen);
    const chosenPlace = await location();
    expect(chosenPlace.directory).toBe(join(chosen, BACKUP_FOLDER_NAME, ID));
    await target.write(snapshot, chosenPlace, nameAt('2026-11-28T11:00:00Z'), new AbortController().signal);
    const info = JSON.parse(await readFile(join(chosenPlace.directory, BACKUP_INFO_FILE), 'utf8'));
    expect(info).toEqual({ v: 1, id: ID, name: 'Own' });
    await target.write(snapshot, chosenPlace, nameAt('2026-11-28T12:00:00Z'), new AbortController().signal);
    expect((await readdir(chosenPlace.directory)).filter((name) => name.startsWith('backup-info'))).toEqual([
      BACKUP_INFO_FILE,
    ]);
  });

  it('remove refuses ../x and a non-pattern name', async () => {
    const place = await location();
    await expect(target.remove(place.directory, '../x')).rejects.toMatchObject({ code: 'backup_failed' });
    await expect(target.remove(place.directory, 'notes.txt')).rejects.toMatchObject({ code: 'backup_failed' });
    await expect(target.remove(place.directory, `..\\${nameAt('2026-11-28T10:00:00Z')}`)).rejects.toMatchObject({
      code: 'backup_failed',
    });
  });

  it('remove deletes one backup', async () => {
    const place = await location();
    const name = nameAt('2026-11-28T10:00:00Z');
    await target.write(snapshot, place, name, new AbortController().signal);
    await target.remove(place.directory, name);
    expect(await readdir(place.directory)).toEqual([]);
  });

  it('copyIn refuses a non-pattern name and copies a backup', async () => {
    const place = await location();
    const destination = join(base, 'copy.sqlite');
    const signal = new AbortController().signal;
    await expect(
      target.copyIn({ origin: 'regular', directory: place.directory, name: 'settings.json' }, destination, signal),
    ).rejects.toMatchObject({ code: 'backup_failed' });
    const name = nameAt('2026-11-28T10:00:00Z');
    await target.write(snapshot, place, name, signal);
    await target.copyIn({ origin: 'regular', directory: place.directory, name }, destination, signal);
    expect((await readFile(destination)).length).toBe(4096);
  });

  it('no error message names a path', async () => {
    chosen = join(base, 'gone');
    const place = await location();
    const error = await target
      .write(snapshot, place, nameAt('2026-11-28T10:00:00Z'), new AbortController().signal)
      .catch((caught: Error) => caught);
    expect((error as Error).message).not.toContain(base);
  });

  it('a leftover .tmp is swept before the free space is measured', async () => {
    const place = await location();
    await mkdir(place.directory, { recursive: true });
    const leftover = join(place.directory, `${nameAt('2026-11-27T10:00:00Z')}.tmp`);
    await writeFile(leftover, Buffer.alloc(4096));
    // Free space plus the leftover covers the backup; the free space alone does not.
    target = createBackupTarget({
      registry: { backupDirectory: async () => chosen },
      freeBytes: async () => ((await exists(leftover)) ? 4095 : 8191),
    });
    const name = nameAt('2026-11-28T10:00:00Z');
    await target.write(snapshot, await location(), name, new AbortController().signal);
    expect(await readdir(place.directory)).toEqual([name]);
  });

  it('a second write under the same name keeps the first backup', async () => {
    const place = await location();
    const name = nameAt('2026-11-28T10:00:00Z');
    await target.write(snapshot, place, name, new AbortController().signal);
    const other = join(base, 'other.tmp');
    await writeFile(other, Buffer.alloc(2048, 9));
    await target.write({ ...snapshot, path: other, sizeBytes: 2048 }, place, name, new AbortController().signal);
    expect(await readdir(place.directory)).toEqual([name]);
    expect(await readFile(join(place.directory, name))).toEqual(Buffer.alloc(4096, 7));
  });

  describe('a place whose folders lead elsewhere', () => {
    it('a chosen place linked into a workspace folder is refused and gets nothing', async () => {
      chosen = join(base, 'chosen');
      const inside = join(root, 'inside');
      await mkdir(join(chosen, BACKUP_FOLDER_NAME), { recursive: true });
      await mkdir(inside);
      await symlink(inside, join(chosen, BACKUP_FOLDER_NAME, ID), 'junction');
      const place = await location();
      await expect(
        target.write(snapshot, place, nameAt('2026-11-28T10:00:00Z'), new AbortController().signal),
      ).rejects.toMatchObject({ code: 'backup_location_unreachable' });
      expect(await readdir(inside)).toEqual([]);
    });

    it('a default place linked into the app data is refused', async () => {
      const userData = join(base, 'userData');
      await mkdir(userData);
      await mkdir(join(root, '.assetforge'));
      await symlink(userData, join(root, '.assetforge', 'backups'), 'junction');
      const place = await location();
      await expect(
        target.write(snapshot, place, nameAt('2026-11-28T10:00:00Z'), new AbortController().signal),
      ).rejects.toMatchObject({ code: 'backup_location_unreachable' });
      expect(await readdir(userData)).toEqual([]);
    });

    it('a delete through such a link is refused and the file stays', async () => {
      chosen = join(base, 'chosen');
      const inside = join(root, 'inside');
      await mkdir(join(chosen, BACKUP_FOLDER_NAME), { recursive: true });
      await mkdir(inside);
      await symlink(inside, join(chosen, BACKUP_FOLDER_NAME, ID), 'junction');
      const name = nameAt('2026-11-28T10:00:00Z');
      await writeFile(join(inside, name), 'x');
      const place = await location();
      await expect(target.remove(place.directory, name)).rejects.toMatchObject({
        code: 'backup_location_unreachable',
      });
      expect(await readdir(inside)).toEqual([name]);
    });
  });

  it('nearestFreeBytes measures the nearest existing ancestor', async () => {
    const measured = await nearestFreeBytes(join(base, 'a', 'b', 'c'));
    expect(typeof measured).toBe('number');
    expect(measured).toBeGreaterThan(0);
  });
});
