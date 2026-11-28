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

/** The file name of the site profiles under `userData`. */
export const SITE_PROFILES_FILE = 'site-profiles.json';

/** The message for an id that names no profile. */
export const SITE_PROFILE_NOT_FOUND = 'This profile does not exist';
const DUPLICATE_NAME = 'A profile with this name already exists';
const TOO_MANY = 'There cannot be more profiles';
const NOT_A_WEB_ADDRESS = 'This is not a web address';
const INVALID = 'The profile is not valid';

/** The site profiles of the app. */
export interface SiteProfileStore {
  /** @returns every profile */
  list(): SiteProfile[];
  /**
   * @param id the profile
   * @returns the profile, or null
   */
  get(id: string): SiteProfile | null;
  /**
   * Creates a profile (its site from `url`) or replaces one (its site stays).
   *
   * @param input the profile
   * @returns the stored profile
   */
  save(input: SaveSiteProfile): SiteProfile;
  /**
   * Deletes a profile.
   *
   * @param id the profile
   */
  delete(id: string): void;
}

/** What the site profile store is built with. */
export interface SiteProfileStoreOptions {
  /** The app's `userData` directory. */
  userData: string;
  /** Makes the id of a new profile; `randomUUID` without it. */
  newId?: () => string;
}

const EnvelopeSchema = z.object({ v: z.literal(1), profiles: z.array(z.unknown()) });

/**
 * The key two names are compared by.
 *
 * @param name the name
 * @returns the key
 */
const nameKey = (name: string) => name.toLowerCase();

/**
 * Creates the store of the site profiles; the file is read on first use.
 *
 * @param options what the store is built with
 * @returns the store
 */
export function createSiteProfileStore(options: SiteProfileStoreOptions): SiteProfileStore {
  const profiles = new SiteProfiles(join(options.userData, SITE_PROFILES_FILE), options.newId ?? randomUUID);
  return {
    list: () => [...profiles.load()],
    get: (id) => profiles.load().find((profile) => profile.id === id) ?? null,
    save: (input) => profiles.save(input),
    delete: (id) => profiles.delete(id),
  };
}

/** The site profiles with their file and the state read from it. */
class SiteProfiles {
  /** What was read or written last; null before the first read. */
  private state: SiteProfile[] | null = null;

  /**
   * @param path the file
   * @param newId makes the id of a new profile
   */
  constructor(
    private readonly path: string,
    private readonly newId: () => string,
  ) {}

  /** @returns the profiles, read on first use */
  load(): SiteProfile[] {
    this.state ??= readProfiles(this.path);
    return this.state;
  }

  /**
   * Creates a profile (its site from `url`) or replaces one (its site stays).
   *
   * @param input the profile
   * @returns the stored profile
   */
  save(input: SaveSiteProfile): SiteProfile {
    const parsed = SaveSiteProfileSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationFailedError(
        parsed.error.issues.some((issue) => issue.path[0] === 'url') ? NOT_A_WEB_ADDRESS : INVALID,
      );
    }
    const { id, url, ...fields } = parsed.data;
    const current = this.load();
    const previous = id === undefined ? null : (current.find((profile) => profile.id === id) ?? null);
    if (id !== undefined && previous === null) throw new NotFoundError(SITE_PROFILE_NOT_FOUND);
    let site: string;
    if (previous !== null) {
      site = previous.site;
    } else {
      const found = siteOfTyped(url ?? '');
      if (found === null) throw new ValidationFailedError(NOT_A_WEB_ADDRESS);
      site = found;
    }
    const others = current.filter((profile) => profile.id !== id);
    if (others.some((profile) => nameKey(profile.name) === nameKey(fields.name)))
      throw new ValidationFailedError(DUPLICATE_NAME);
    if (previous === null && current.length >= MAX_SITE_PROFILES) throw new InvalidOperationError(TOO_MANY);
    const saved = SiteProfileSchema.parse({ id: previous?.id ?? this.newId(), site, ...fields });
    this.commit(
      previous === null ? [...current, saved] : current.map((profile) => (profile.id === saved.id ? saved : profile)),
    );
    return saved;
  }

  /**
   * Deletes a profile.
   *
   * @param id the profile
   */
  delete(id: string): void {
    const current = this.load();
    if (!current.some((profile) => profile.id === id)) throw new NotFoundError(SITE_PROFILE_NOT_FOUND);
    this.commit(current.filter((profile) => profile.id !== id));
  }

  /**
   * Writes `next` and only then makes it the state, so a failed write changes nothing.
   *
   * @param next the new profiles
   */
  private commit(next: SiteProfile[]): void {
    writeAtomic(this.path, `${JSON.stringify({ v: 1, profiles: next }, null, 2)}\n`);
    this.state = next;
  }
}

/**
 * The site of a typed URL: the URL rule of the sources first, then `siteOf`; null when either refuses it.
 *
 * @param url the typed URL
 * @returns the site, or null
 */
function siteOfTyped(url: string): string | null {
  let normalized: string;
  try {
    normalized = normalizeSourceUrl(url);
  } catch {
    return null;
  }
  return siteOf(normalized);
}

/**
 * Reads the stored profiles entry by entry; a missing file reads as none.
 *
 * @param path the file
 * @returns the usable profiles
 */
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

  const envelope = EnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    // Unreadable as a whole: kept aside once, the store starts empty.
    if (alreadyKept(path, text)) rmSync(path, { force: true });
    else renameSync(path, corruptCopyPath(path));
    return [];
  }
  const { profiles, degraded } = usableProfiles(envelope.data.profiles);
  // The original stays until the next save rewrites it; the copy keeps what was left out.
  if (degraded && !alreadyKept(path, text)) {
    try {
      copyFileSync(path, corruptCopyPath(path));
    } catch {
      // Nothing else depends on the copy.
    }
  }
  return profiles;
}

/**
 * The profiles that parse, are not repeated by id or name and fit the limit.
 *
 * @param values the stored entries
 * @returns the usable profiles, and whether anything was left out
 */
function usableProfiles(values: readonly unknown[]): { profiles: SiteProfile[]; degraded: boolean } {
  const profiles: SiteProfile[] = [];
  let degraded = false;
  for (const value of values) {
    const parsed = SiteProfileSchema.safeParse(value);
    const usable =
      parsed.success &&
      profiles.length < MAX_SITE_PROFILES &&
      !profiles.some((profile) => profile.id === parsed.data.id || nameKey(profile.name) === nameKey(parsed.data.name));
    if (!usable) {
      degraded = true;
      continue;
    }
    profiles.push(parsed.data);
  }
  return { profiles, degraded };
}

/**
 * The path of a new copy of the file, stamped with the current time.
 *
 * @param path the file
 * @returns the copy's path
 */
function corruptCopyPath(path: string): string {
  return `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Whether a copy beside the file already holds exactly this text.
 *
 * @param path the file
 * @param text its text
 * @returns true when one does; false also when the directory cannot be read
 */
function alreadyKept(path: string, text: string): boolean {
  const directory = dirname(path);
  const prefix = `${basename(path)}.corrupt-`;
  try {
    return readdirSync(directory)
      .filter((name) => name.startsWith(prefix))
      .some((name) => readFileSync(join(directory, name), 'utf8') === text);
  } catch {
    return false;
  }
}
