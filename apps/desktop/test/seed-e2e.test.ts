import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createAsset } from '@assetforge/core';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { createWorkspaceManager } from '../src/main/composition.js';

const userDataPath = process.env.ASSETFORGE_SEED_USER_DATA;
const seedRoot = process.env.ASSETFORGE_SEED_ROOT;

const ASSET_COUNT = 2000;
const IMAGE_EVERY = 50;

/** Seeds a large workspace for the end-to-end smoke of the gallery; not part of `pnpm test`. */
describe.skipIf(!userDataPath)('seed workspace for end-to-end runs', () => {
  it(`creates "Seed" with ${ASSET_COUNT} assets and an image on every ${IMAGE_EVERY}th`, async () => {
    if (!userDataPath || !seedRoot) throw new Error('ASSETFORGE_SEED_USER_DATA and ASSETFORGE_SEED_ROOT are required');
    const sources = await mkdtemp(join(tmpdir(), 'af-seed-'));
    const manager = createWorkspaceManager({ userDataPath, migrationsFolder: MIGRATIONS_FOLDER });
    try {
      await mkdir(seedRoot, { recursive: true });
      await manager.create({ name: 'Seed', rootPath: seedRoot });
      const ids = await manager.exclusive(async (s) => {
        const typeIds = (await s.database.assetTypes.list()).map((t) => t.id);
        const created: string[] = [];
        for (let n = 1; n <= ASSET_COUNT; n += 1) {
          const name = `Asset ${String(n).padStart(4, '0')}`;
          const asset = await createAsset(s, { name, typeId: typeIds[(n - 1) % typeIds.length]! });
          created.push(asset.id);
        }
        return created;
      });

      let images = 0;
      for (let n = IMAGE_EVERY; n <= ASSET_COUNT; n += IMAGE_EVERY) {
        const source = join(sources, `seed-${n}.png`);
        const hue = (n / IMAGE_EVERY) * 37;
        await sharp({
          create: {
            width: 64,
            height: 64,
            channels: 3,
            background: {
              r: Math.round(127 + 127 * Math.cos((hue * Math.PI) / 180)),
              g: Math.round(127 + 127 * Math.cos(((hue + 120) * Math.PI) / 180)),
              b: Math.round(127 + 127 * Math.cos(((hue + 240) * Math.PI) / 180)),
            },
          },
        })
          .png()
          .toFile(source);
        const [result] = await manager.importFiles([source], { assetId: ids[n - 1]!, role: 'reference' });
        expect(result?.error).toBeNull();
        images += 1;
      }
      expect(images).toBe(ASSET_COUNT / IMAGE_EVERY);
    } finally {
      await manager.close();
      await rm(sources, { recursive: true, force: true });
    }
  }, 300_000);
});
