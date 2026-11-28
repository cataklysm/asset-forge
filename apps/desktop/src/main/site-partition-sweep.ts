import { existsSync, readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SITE_PROFILES_FILE, type SiteProfileStore } from './site-profile-store.js';
import type { SiteSessions } from './site-sessions.js';

// At app start, the browser sessions (`persist:site-<id>`) that belong to no stored profile are cleared like a deleted
// profile's: storage, cache and auth cache. A profile deleted while its clear failed, or one whose file entry was lost,
// would otherwise keep its login cookies on disk. Nothing is cleared unless the profiles file exists, was read as a
// whole and no `.corrupt-*` copy lies beside it: then the list may lack profiles whose logins are still wanted.
// Chromium keeps the directory itself, so an ownerless partition is cleared again on every start.

/** The directory Electron keeps its persistent partitions in, under `userData`. */
export const PARTITIONS_DIRECTORY = 'Partitions';

/** The on-disk name of a site partition: `site-` and the profile's UUID. */
const SITE_PARTITION_NAME = /^site-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The one line logged when the sweep failed somewhere; never a path, URL or cookie. */
const SWEEP_FAILED = 'site partitions: sweep_failed';

/** Lists the site partitions there are. */
export interface SitePartitionDirectory {
  /** @returns the profile ids that have a site partition */
  profileIds(): Promise<string[]>;
}

/** What the sweep works with. */
export interface SitePartitionSweepDependencies {
  /** The app's `userData` directory, where the profiles file lies. */
  userData: string;
  /** The site profiles. */
  store: Pick<SiteProfileStore, 'list'>;
  /** The site partitions there are. */
  partitions: SitePartitionDirectory;
  /** Clears a profile's session. */
  sessions: Pick<SiteSessions, 'clear'>;
  /** One line when something failed. */
  log: (line: string) => void;
}

/**
 * The site partitions in `userData/Partitions`, read by directory name.
 *
 * @param userData the app's `userData` directory
 * @returns the partition directory
 */
export function createSitePartitionDirectory(userData: string): SitePartitionDirectory {
  return { profileIds: () => readSitePartitionIds(join(userData, PARTITIONS_DIRECTORY)) };
}

/**
 * The profile ids of the site partition directories; none when the directory does not exist.
 *
 * @param directory the partitions directory
 * @returns the profile ids
 */
async function readSitePartitionIds(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const ids: string[] = [];
  for (const entry of entries) {
    const match = entry.isDirectory() ? SITE_PARTITION_NAME.exec(entry.name) : null;
    if (match !== null) ids.push(match[1]!);
  }
  return ids;
}

/**
 * Clears the site partitions that belong to no stored profile. Never rejects; a failure logs one fixed line.
 *
 * @param dependencies what the sweep works with
 * @returns resolves when every ownerless partition was tried
 */
export async function sweepOwnerlessSitePartitions(dependencies: SitePartitionSweepDependencies): Promise<void> {
  let isFailed = false;
  try {
    const owners = completeProfileIds(dependencies);
    if (owners === null) return;
    for (const id of await dependencies.partitions.profileIds()) {
      if (owners.has(id.toLowerCase())) continue;
      try {
        await dependencies.sessions.clear(id);
      } catch {
        isFailed = true;
      }
    }
  } catch {
    isFailed = true;
  }
  if (isFailed) dependencies.log(SWEEP_FAILED);
}

/**
 * The ids of the stored profiles in lower case, or null when the list may be incomplete: no profiles file after
 * reading it (none, or set aside as unreadable) or a `.corrupt-*` copy beside it (also one made by this read).
 *
 * @param dependencies what the sweep works with
 * @returns the ids, or null
 * @throws whatever reading the profiles or the directory throws
 */
function completeProfileIds(dependencies: SitePartitionSweepDependencies): Set<string> | null {
  const profiles = dependencies.store.list();
  if (!existsSync(join(dependencies.userData, SITE_PROFILES_FILE))) return null;
  const prefix = `${SITE_PROFILES_FILE}.corrupt-`;
  if (readdirSync(dependencies.userData).some((name) => name.startsWith(prefix))) return null;
  return new Set(profiles.map((profile) => profile.id.toLowerCase()));
}
