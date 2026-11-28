import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_FOLDER_NAME,
  LOCATION_IN_APP_DATA_MESSAGE,
  LOCATION_IN_WORKSPACE_MESSAGE,
  LOCATION_NOT_WRITABLE_MESSAGE,
} from '@assetforge/contracts';
import { resolveLocation, validateChosenDirectory } from '../src/main/backup-location.js';
import { JsonWorkspaceRegistry } from '../src/main/json-registry.js';

const ID = '11111111-1111-4111-8111-111111111111';

let base: string;
let own: string;
let other: string;
let userData: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'af-backup-location-'));
  own = join(base, 'own');
  other = join(base, 'other');
  userData = join(base, 'userData');
  for (const folder of [own, other, userData, join(other, 'sub'), join(base, 'sibling')]) {
    await mkdir(folder, { recursive: true });
  }
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/**
 * Validates a candidate against the two roots and the app data of the test.
 *
 * @param candidate the folder
 * @returns what the validation resolves to
 */
function validate(candidate: string): Promise<void> {
  return validateChosenDirectory(candidate, { workspaceRoots: [own, other], userDataPath: userData });
}

describe('validateChosenDirectory', () => {
  it('refuses own root, a subfolder of another root, userData and a path written with .. into a root', async () => {
    await expect(validate(own)).rejects.toMatchObject({ code: 'validation_failed', message: LOCATION_IN_WORKSPACE_MESSAGE });
    await expect(validate(join(other, 'sub'))).rejects.toMatchObject({ message: LOCATION_IN_WORKSPACE_MESSAGE });
    await expect(validate(join(base, 'sibling', '..', 'own'))).rejects.toMatchObject({
      message: LOCATION_IN_WORKSPACE_MESSAGE,
    });
    await expect(validate(userData)).rejects.toMatchObject({ message: LOCATION_IN_APP_DATA_MESSAGE });
  });

  it.runIf(process.platform === 'win32')('refuses case-changed root on win32', async () => {
    await expect(validate(own.toUpperCase())).rejects.toMatchObject({ message: LOCATION_IN_WORKSPACE_MESSAGE });
  });

  it.runIf(process.platform === 'win32')('refuses a junction into a root', async () => {
    const junction = join(base, 'junction');
    await symlink(join(other, 'sub'), junction, 'junction');
    await expect(validate(junction)).rejects.toMatchObject({ message: LOCATION_IN_WORKSPACE_MESSAGE });
  });

  it('refuses an unwritable or missing folder', async () => {
    await expect(validate(join(base, 'missing'))).rejects.toMatchObject({
      code: 'validation_failed',
      message: LOCATION_NOT_WRITABLE_MESSAGE,
    });
    // A file instead of a folder: the probe cannot be written below it.
    await writeFile(join(base, 'file'), 'x');
    await expect(validate(join(base, 'file'))).rejects.toMatchObject({ message: LOCATION_NOT_WRITABLE_MESSAGE });
  });

  it('accepts a sibling folder and leaves no probe behind', async () => {
    await expect(validate(join(base, 'sibling'))).resolves.toBeUndefined();
    expect(await readdir(join(base, 'sibling'))).toEqual([]);
  });

  it('a root whose prefix matches is not a parent', async () => {
    await mkdir(join(base, 'own-backups'));
    await expect(validate(join(base, 'own-backups'))).resolves.toBeUndefined();
  });

  it('messages never name the folder', async () => {
    const error = await validate(join(base, 'missing')).catch((caught: Error) => caught);
    expect((error as Error).message).not.toContain(base);
  });
});

describe('resolveLocation', () => {
  it('gives both shapes', () => {
    expect(resolveLocation({ id: ID, rootPath: own }, null)).toEqual({
      kind: 'workspace',
      directory: join(own, '.assetforge', 'backups'),
      chosenPath: null,
    });
    expect(resolveLocation({ id: ID, rootPath: own }, other)).toEqual({
      kind: 'chosen',
      directory: join(other, BACKUP_FOLDER_NAME, ID),
      chosenPath: other,
    });
  });
});

describe('JsonWorkspaceRegistry backupDirectory', () => {
  it('keeps backupDirectory across upsert and drops it on remove', async () => {
    const registry = new JsonWorkspaceRegistry(join(base, 'settings.json'));
    const entry = { id: ID, name: 'Own', rootPath: own, lastOpenedAt: '2026-11-28T00:00:00.000Z' };
    await registry.upsert(entry);
    expect(await registry.backupDirectory(ID)).toBeNull();
    await registry.setBackupDirectory(ID, other);
    await registry.upsert({ ...entry, lastOpenedAt: '2026-11-28T01:00:00.000Z' });
    expect(await registry.backupDirectory(ID)).toBe(other);
    await registry.setBackupDirectory(ID, null);
    expect(await registry.backupDirectory(ID)).toBeNull();
    await registry.setBackupDirectory(ID, other);
    await registry.remove(ID);
    await registry.upsert(entry);
    expect(await registry.backupDirectory(ID)).toBeNull();
  });

  it('an unknown id writes nothing', async () => {
    const registry = new JsonWorkspaceRegistry(join(base, 'settings.json'));
    await registry.setBackupDirectory(ID, other);
    expect(await registry.backupDirectory(ID)).toBeNull();
    expect(await readdir(base)).not.toContain('settings.json');
  });
});
