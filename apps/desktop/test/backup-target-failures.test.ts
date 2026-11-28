import { Writable } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupFileName, type DatabaseSnapshot } from '@assetforge/core';
import { createBackupTarget, type BackupTarget } from '../src/main/backup-target.js';

// The write stream of a backup is replaced by one that fails, so a full disk and a place that vanishes mid-copy can
// be shown without filling a disk or unplugging a share.

const hooks = vi.hoisted(() => ({
  /** Runs on the first chunk of a backup write and answers the error it fails with; null writes normally. */
  failure: null as null | (() => Promise<Error>),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
      const failure = hooks.failure;
      if (failure === null) return actual.createWriteStream(...args);
      return new Writable({
        write: (_chunk, _encoding, callback) => void failure().then(callback),
      });
    },
  };
});

const ID = '11111111-1111-4111-8111-111111111111';
const LINEAGE = 'abcdef012345-0000-4000-8000-000000000000';

let base: string;
let chosen: string;
let target: BackupTarget;
let snapshot: DatabaseSnapshot;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'af-backup-failures-'));
  chosen = join(base, 'chosen');
  await mkdir(chosen);
  target = createBackupTarget({ registry: { backupDirectory: async () => chosen }, freeBytes: async () => null });
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
  hooks.failure = null;
  await rm(base, { recursive: true, force: true });
});

/**
 * An error with a system code.
 *
 * @param code the code
 * @returns the error
 */
function systemError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/**
 * Writes one backup of the test workspace into the chosen place.
 *
 * @returns resolves once written
 */
async function write(): Promise<void> {
  const place = await target.locationOf({ id: ID, name: 'Own', rootPath: join(base, 'root') });
  await target.write(
    snapshot,
    place,
    backupFileName(LINEAGE, new Date('2026-11-28T10:00:00Z'), 19),
    new AbortController().signal,
  );
}

describe('a backup write that fails during the copy', () => {
  it('a full disk answers backup_no_space', async () => {
    hooks.failure = async () => systemError('ENOSPC');
    await expect(write()).rejects.toMatchObject({ code: 'backup_no_space' });
  });

  it('an exceeded quota answers backup_no_space', async () => {
    hooks.failure = async () => systemError('EDQUOT');
    await expect(write()).rejects.toMatchObject({ code: 'backup_no_space' });
  });

  it('a place that vanished answers backup_location_unreachable', async () => {
    hooks.failure = async () => {
      await rm(chosen, { recursive: true, force: true });
      return systemError('EIO');
    };
    await expect(write()).rejects.toMatchObject({ code: 'backup_location_unreachable' });
  });

  it('any other failure answers backup_failed', async () => {
    hooks.failure = async () => systemError('EIO');
    await expect(write()).rejects.toMatchObject({ code: 'backup_failed' });
  });
});
