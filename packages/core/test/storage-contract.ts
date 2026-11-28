import { describe, expect, it } from 'vitest';
import type { Storage } from '../src/index.js';

/** One storage under test, reachable or not. */
export interface StorageUnderTest {
  storage: Storage;
}

/** Makes the storages the contract runs against. */
export interface StorageContractFactory {
  /** A storage whose root can be reached. */
  reachable(): Promise<StorageUnderTest>;
  /** A storage whose root cannot be reached. */
  unreachable(): Promise<StorageUnderTest>;
}

/**
 * The behaviour every `Storage` shares, so the in-memory fake answers what the real adapter answers. Run by the
 * fake's own test in core and by the local adapter's test in the storage package.
 *
 * @param name the adapter's name in the test titles
 * @param factory makes the storages
 */
export function describeStorageContract(name: string, factory: StorageContractFactory): void {
  describe(`${name} (storage contract)`, () => {
    it('answers the absolute path of a workspace path', async () => {
      const { storage } = await factory.reachable();
      expect(normalised(await storage.absolutePath('inbox/a.png'))).toMatch(/\/inbox\/a\.png$/);
    });

    it('answers the absolute path while the storage cannot be reached, without checking reachability', async () => {
      const { storage } = await factory.unreachable();
      expect(await storage.isReachable()).toBe(false);
      expect(normalised(await storage.absolutePath('inbox/a.png'))).toMatch(/\/inbox\/a\.png$/);
    });
  });
}

/**
 * A path with forward slashes, so both platforms compare alike.
 *
 * @param absolutePath the path
 * @returns the path with `/` separators
 */
function normalised(absolutePath: string): string {
  return absolutePath.replaceAll('\\', '/');
}
