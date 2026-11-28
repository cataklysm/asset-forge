import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSitePartitionDirectory,
  sweepOwnerlessSitePartitions,
  type SitePartitionDirectory,
} from '../src/main/site-partition-sweep.js';
import { createSiteProfileStore, SITE_PROFILES_FILE } from '../src/main/site-profile-store.js';

const KEPT = '11111111-1111-4111-8111-111111111111';
const OWNERLESS = '22222222-2222-4222-8222-222222222222';
const SECOND_OWNERLESS = '33333333-3333-4333-8333-333333333333';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-site-sweep-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Writes a profiles file holding one profile with the given id.
 *
 * @param id the profile id
 */
function writeProfiles(id: string): void {
  const profile = {
    id,
    name: 'Example',
    site: 'example.com',
    thumbnails: '//a',
    pagination: '',
    file: '',
    kinds: ['image'],
    minBytes: 0,
    urlContains: '',
    maxPages: 20,
    maxFiles: 1000,
  };
  writeFileSync(join(dir, SITE_PROFILES_FILE), JSON.stringify({ v: 1, profiles: [profile] }));
}

/**
 * A partition directory that answers fixed ids.
 *
 * @param ids the ids it answers
 * @returns the directory
 */
function fixedPartitions(ids: string[]): SitePartitionDirectory {
  return { profileIds: async () => ids };
}

/**
 * Runs the sweep with a recording clear.
 *
 * @param partitions the partition directory
 * @returns the cleared ids and the log lines
 */
async function sweep(partitions: SitePartitionDirectory): Promise<{ cleared: string[]; lines: string[] }> {
  const cleared: string[] = [];
  const lines: string[] = [];
  await sweepOwnerlessSitePartitions({
    userData: dir,
    store: createSiteProfileStore({ userData: dir }),
    partitions,
    sessions: {
      clear: async (id) => {
        cleared.push(id);
      },
    },
    log: (line) => lines.push(line),
  });
  return { cleared, lines };
}

describe('ownerless site partitions', () => {
  it('clears every partition that belongs to no stored profile and keeps the others', async () => {
    writeProfiles(KEPT);
    const { cleared } = await sweep(fixedPartitions([KEPT, OWNERLESS, SECOND_OWNERLESS]));
    expect(cleared).toEqual([OWNERLESS, SECOND_OWNERLESS]);
  });

  it('compares the ids regardless of case', async () => {
    writeProfiles(KEPT);
    const { cleared } = await sweep(fixedPartitions([KEPT.toUpperCase()]));
    expect(cleared).toEqual([]);
  });

  it('clears nothing while no profiles file exists', async () => {
    const { cleared } = await sweep(fixedPartitions([OWNERLESS]));
    expect(cleared).toEqual([]);
  });

  it('clears nothing while a corrupt copy lies beside the profiles file', async () => {
    writeProfiles(KEPT);
    writeFileSync(join(dir, `${SITE_PROFILES_FILE}.corrupt-2026-11-28T00-00-00-000Z`), '{}');
    const { cleared } = await sweep(fixedPartitions([OWNERLESS]));
    expect(cleared).toEqual([]);
  });

  it('clears nothing when reading the profiles file left an entry out', async () => {
    writeFileSync(join(dir, SITE_PROFILES_FILE), JSON.stringify({ v: 1, profiles: [{ id: KEPT }] }));
    const { cleared } = await sweep(fixedPartitions([OWNERLESS]));
    expect(cleared).toEqual([]);
  });

  it('clears nothing when the profiles file is unreadable as a whole', async () => {
    writeFileSync(join(dir, SITE_PROFILES_FILE), 'not json');
    const { cleared } = await sweep(fixedPartitions([OWNERLESS]));
    expect(cleared).toEqual([]);
  });

  it('logs one fixed line and never rejects when the partitions cannot be listed', async () => {
    writeProfiles(KEPT);
    const { cleared, lines } = await sweep({
      profileIds: async () => {
        throw new Error(`cannot read ${dir}`);
      },
    });
    expect(cleared).toEqual([]);
    expect(lines).toEqual(['site partitions: sweep_failed']);
  });

  it('goes on with the next partition after a clear that throws', async () => {
    writeProfiles(KEPT);
    const cleared: string[] = [];
    const lines: string[] = [];
    await sweepOwnerlessSitePartitions({
      userData: dir,
      store: createSiteProfileStore({ userData: dir }),
      partitions: fixedPartitions([OWNERLESS, SECOND_OWNERLESS]),
      sessions: {
        clear: async (id) => {
          if (id === OWNERLESS) throw new Error('boom');
          cleared.push(id);
        },
      },
      log: (line) => lines.push(line),
    });
    expect(cleared).toEqual([SECOND_OWNERLESS]);
    expect(lines).toEqual(['site partitions: sweep_failed']);
  });
});

describe('site partition directory', () => {
  it('answers the profile ids of the site partitions under userData/Partitions', async () => {
    const partitions = join(dir, 'Partitions');
    for (const name of [`site-${KEPT}`, `site-${OWNERLESS.toUpperCase()}`, 'other', 'site-', 'site-not-an-id']) {
      mkdirSync(join(partitions, name), { recursive: true });
    }
    writeFileSync(join(partitions, `site-${SECOND_OWNERLESS}`), 'a file, not a partition');
    const ids = await createSitePartitionDirectory(dir).profileIds();
    expect(ids.sort()).toEqual([KEPT, OWNERLESS.toUpperCase()].sort());
  });

  it('answers none when there is no Partitions directory', async () => {
    expect(await createSitePartitionDirectory(dir).profileIds()).toEqual([]);
  });
});
