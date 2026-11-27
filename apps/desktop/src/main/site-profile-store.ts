import { randomUUID } from 'node:crypto';
import { copyFileSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import {
  MAX_SITE_PROFILES,
  SaveSiteProfileSchema,
  SiteProfileSchema,
  siteOf,
  type SaveSiteProfile,
  type SiteProfile,
} from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError, normalizeSourceUrl, ValidationFailedError } from '@assetforge/core';
import { writeAtomic } from './atomic-file.js';

// App-level site profiles in `userData/site-profiles.json` (`{ v: 1, profiles }`), written through `writeAtomic` and
// read entry by entry like the provider settings: a broken entry, a repeated id or name and anything over the limit
// are left out, and the file as it was is kept in a `.corrupt-<stamp>` copy beside it. Kept free of Electron imports.
// The store holds no cookie; the logins live in the Electron session of each profile.

export const SITE_PROFILES_FILE = 'site-profiles.json';

export const SITE_PROFILE_NOT_FOUND = 'This profile does not exist';
const DUPLICATE_NAME = 'A profile with this name already exists';
const TOO_MANY = 'There cannot be more profiles';
const NOT_A_WEB_ADDRESS = 'This is not a web address';
const INVALID = 'The profile is not valid';

export interface SiteProfileStore {
  list(): SiteProfile[];
  get(id: string): SiteProfile | null;
  /** Creates a profile (its site from `url`) or replaces one (its site stays). */
  save(input: SaveSiteProfile): SiteProfile;
  delete(id: string): void;
}

const EnvelopeSchema = z.object({ v: z.literal(1), profiles: z.array(z.unknown()) });

const nameKey = (name: string) => name.toLowerCase();

export function createSiteProfileStore(o: { userData: string; newId?: () => string }): SiteProfileStore {
  const path = join(o.userData, SITE_PROFILES_FILE);
  const newId = o.newId ?? randomUUID;
  let state: SiteProfile[] | null = null;

  const load = (): SiteProfile[] => {
    state ??= readProfiles(path);
    return state;
  };
  /** Writes `next` and only then makes it the state, so a failed write changes nothing. */
  const commit = (next: SiteProfile[]): void => {
    writeAtomic(path, `${JSON.stringify({ v: 1, profiles: next }, null, 2)}\n`);
    state = next;
  };

  return {
    list: () => [...load()],
    get: (id) => load().find((p) => p.id === id) ?? null,
    save(input) {
      const parsed = SaveSiteProfileSchema.safeParse(input);
      if (!parsed.success) {
        throw new ValidationFailedError(parsed.error.issues.some((i) => i.path[0] === 'url') ? NOT_A_WEB_ADDRESS : INVALID);
      }
      const { id, url, ...fields } = parsed.data;
      const current = load();
      const previous = id === undefined ? null : (current.find((p) => p.id === id) ?? null);
      if (id !== undefined && previous === null) throw new NotFoundError(SITE_PROFILE_NOT_FOUND);
      let site: string;
      if (previous !== null) {
        site = previous.site;
      } else {
        const found = siteOfTyped(url ?? '');
        if (found === null) throw new ValidationFailedError(NOT_A_WEB_ADDRESS);
        site = found;
      }
      const others = current.filter((p) => p.id !== id);
      if (others.some((p) => nameKey(p.name) === nameKey(fields.name))) throw new ValidationFailedError(DUPLICATE_NAME);
      if (previous === null && current.length >= MAX_SITE_PROFILES) throw new InvalidOperationError(TOO_MANY);
      const profile = SiteProfileSchema.parse({ id: previous?.id ?? newId(), site, ...fields });
      commit(previous === null ? [...current, profile] : current.map((p) => (p.id === profile.id ? profile : p)));
      return profile;
    },
    delete(id) {
      const current = load();
      if (!current.some((p) => p.id === id)) throw new NotFoundError(SITE_PROFILE_NOT_FOUND);
      commit(current.filter((p) => p.id !== id));
    },
  };
}

/** The site of a typed URL: the URL rule of the sources first, then `siteOf`; null when either refuses it. */
function siteOfTyped(url: string): string | null {
  let normalized: string;
  try {
    normalized = normalizeSourceUrl(url);
  } catch {
    return null;
  }
  return siteOf(normalized);
}

function readProfiles(path: string): SiteProfile[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const stamp = () => `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const alreadyKept = (): boolean => {
    const dir = dirname(path);
    const prefix = `${basename(path)}.corrupt-`;
    try {
      return readdirSync(dir)
        .filter((name) => name.startsWith(prefix))
        .some((name) => readFileSync(join(dir, name), 'utf8') === text);
    } catch {
      return false;
    }
  };

  const envelope = EnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    // Unreadable as a whole: kept aside once, the store starts empty.
    if (alreadyKept()) rmSync(path, { force: true });
    else renameSync(path, stamp());
    return [];
  }
  const profiles: SiteProfile[] = [];
  let degraded = false;
  for (const value of envelope.data.profiles) {
    const parsed = SiteProfileSchema.safeParse(value);
    const usable =
      parsed.success &&
      profiles.length < MAX_SITE_PROFILES &&
      !profiles.some((p) => p.id === parsed.data.id || nameKey(p.name) === nameKey(parsed.data.name));
    if (!usable) {
      degraded = true;
      continue;
    }
    profiles.push(parsed.data);
  }
  // The original stays until the next save rewrites it; the copy keeps what was left out.
  if (degraded && !alreadyKept()) {
    try {
      copyFileSync(path, stamp());
    } catch {
      // Nothing else depends on the copy.
    }
  }
  return profiles;
}
