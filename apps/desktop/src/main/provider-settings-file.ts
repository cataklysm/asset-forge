import { copyFileSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_PROVIDER_OPTIONS,
  isVisionKind,
  MAX_PROVIDERS,
  ModelNameSchema,
  PARALLEL_REQUESTS_DEFAULT,
  ParallelRequestsSchema,
  ProviderKindSchema,
  ProviderNameSchema,
  ProviderOptionsSchema,
  VISION_TIMEOUT_MAX_SECONDS,
  VISION_TIMEOUT_MIN_SECONDS,
  type ProviderKind,
  type ProviderPurpose,
} from '@assetforge/contracts';
import { writeAtomic } from './atomic-file.js';
import { optionsFor, secureForImages, type ProviderEntry } from './provider-entry.js';
import { usableBaseUrl } from './vision-config.js';

// The settings file `userData/provider-settings.json` (version 4) as it lies on disk: its schemas for every version
// this app knows, the read entry by entry, and the write.
//
// A settings file is read entry by entry: a broken entry is left out and the others load. Whatever was left out is kept
// in a `.corrupt-<stamp>` copy beside the file.

/** The settings file under `userData`. */
export const PROVIDER_SETTINGS_FILE = 'provider-settings.json';

/** The entry used last, one slot per purpose. */
export type LastUsed = Record<ProviderPurpose, string | null>;

/** The content of the settings file as the store keeps it in memory. */
export interface StoredSettings {
  providers: ProviderEntry[];
  /** One slot per purpose: `vision` names an `ollama` or `openai` entry, `image` a `venice` entry. */
  lastUsed: LastUsed;
  /** Set by the upgrade until the legacy key file has been renamed to the entry's key file. */
  adoptLegacyKey: { id: string; origin: string } | null;
}

/** The settings without any entry. */
export const EMPTY_SETTINGS: StoredSettings = {
  providers: [],
  lastUsed: { vision: null, image: null },
  adoptLegacyKey: null,
};

const TimeoutSchema = z.number().int().min(VISION_TIMEOUT_MIN_SECONDS).max(VISION_TIMEOUT_MAX_SECONDS);
const StoredBaseUrlSchema = z.string().refine((url) => usableBaseUrl(url) === url);

const V1FileSchema = z.object({
  version: z.literal(1),
  vision: z.object({
    baseUrl: StoredBaseUrlSchema.nullable(),
    timeoutSeconds: TimeoutSchema,
    taggingModel: ModelNameSchema.nullable(),
    promptModel: ModelNameSchema.nullable(),
  }),
});

/** The single vision provider of a version 1 file. */
export type VersionOneVision = z.infer<typeof V1FileSchema>['vision'];

const V2EntrySchema = z.object({
  id: z.uuid(),
  name: ProviderNameSchema,
  baseUrl: StoredBaseUrlSchema,
  timeoutSeconds: TimeoutSchema,
  taggingModel: ModelNameSchema.nullable(),
  promptModel: ModelNameSchema.nullable(),
});

const V3EntryShape = {
  id: z.uuid(),
  kind: ProviderKindSchema,
  name: ProviderNameSchema,
  baseUrl: StoredBaseUrlSchema,
  timeoutSeconds: TimeoutSchema,
  taggingModel: ModelNameSchema.nullable(),
  promptModel: ModelNameSchema.nullable(),
  editModel: ModelNameSchema.nullable(),
};

/** The fields of a stored entry that `entryRules` checks. */
interface RuledEntry {
  kind: ProviderKind;
  baseUrl: string;
  taggingModel: string | null;
  promptModel: string | null;
  editModel: string | null;
}

/**
 * The rules every stored entry of version 3 and 4 obeys.
 *
 * @param entry the parsed entry
 * @returns true when the models fit the kind and an image entry has a secure URL
 */
const entryRules = (entry: RuledEntry) =>
  (isVisionKind(entry.kind) ? entry.editModel === null : entry.taggingModel === null && entry.promptModel === null) &&
  // The save rule holds on read too: a hand-edited file must not send a stored key over plain http.
  (isVisionKind(entry.kind) || secureForImages(entry.baseUrl));

const SlotSchema = z.uuid().nullable();
const MarkerSchema = z.object({ id: z.uuid(), origin: z.string() }).nullable();

const V3EntrySchema = z.object(V3EntryShape).refine(entryRules);

/**
 * Stored options: a missing or broken `parallelRequests` or `structuredOutput` (written before the field existed, or
 * edited by hand) reads as the default, so the entry is kept. The IPC schema has no such default.
 */
const StoredOptionsSchema = ProviderOptionsSchema.extend({
  parallelRequests: ParallelRequestsSchema.catch(PARALLEL_REQUESTS_DEFAULT),
  structuredOutput: z.boolean().catch(DEFAULT_PROVIDER_OPTIONS.structuredOutput),
});

const V4EntrySchema = z
  .object({ ...V3EntryShape, options: StoredOptionsSchema.nullable() })
  .refine(entryRules)
  // Options exactly on a vision entry. Stored extra parameters the save rule refuses do not make the entry
  // unreadable: the gateway sends none for that entry, and the next save refuses the text.
  .refine((entry) => (entry.options === null) === !isVisionKind(entry.kind));

/** Version 2 to 4: an object with an integer version; everything else is checked field by field and entry by entry. */
const VersionSchema = z.object({ version: z.int() });
const EnvelopeSchema = z.object({ providers: z.array(z.unknown()) });

/**
 * `degraded`: something was left out (a broken entry or field, an entry over the limit, a repeated id) or the file was
 * unreadable. A degraded load deletes no key file.
 */
export type SettingsReadResult =
  | { kind: 'v1'; vision: VersionOneVision }
  | { kind: 'stored'; stored: StoredSettings; degraded: boolean }
  | { kind: 'none'; degraded: boolean };

/**
 * Writes the settings as version 4.
 *
 * @param path the settings file
 * @param settings what to store
 */
export function writeStoredSettings(path: string, settings: StoredSettings): void {
  writeAtomic(path, `${JSON.stringify({ version: 4, ...settings }, null, 2)}\n`);
}

/**
 * The paths of the `.corrupt-<stamp>` copies beside the settings file.
 *
 * @param path the settings file
 * @returns every copy found; none when the directory cannot be read
 */
export function corruptCopies(path: string): string[] {
  const directory = dirname(path);
  const prefix = `${basename(path)}.corrupt-`;
  try {
    return readdirSync(directory)
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

/**
 * A new path for a `.corrupt-<stamp>` copy, stamped with the current time.
 *
 * @param path the settings file
 * @returns the copy's path
 */
function corruptCopyPath(path: string): string {
  return `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Whether a copy with the same content already lies beside the file.
 *
 * @param path the settings file
 * @param text the file's content
 * @returns true when one copy holds exactly this text
 */
function isAlreadyKept(path: string, text: string): boolean {
  return corruptCopies(path).some((copy) => {
    try {
      return readFileSync(copy, 'utf8') === text;
    } catch {
      return false;
    }
  });
}

/**
 * Same pattern as the workspace registry: keeps the unreadable file aside, so the store starts empty.
 *
 * @param path the settings file
 * @param text the file's content
 * @returns a degraded result without settings
 */
function setAside(path: string, text: string): SettingsReadResult {
  if (isAlreadyKept(path, text)) rmSync(path, { force: true });
  else renameSync(path, corruptCopyPath(path));
  return { kind: 'none', degraded: true };
}

/**
 * Reads the settings file of any known version.
 *
 * @param path the settings file
 * @returns the version 1 provider, the settings upgraded to version 4 in memory, or none
 * @throws whatever reading the file throws, except for a missing file
 */
export function readStoredSettings(path: string): SettingsReadResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none', degraded: false };
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const version = VersionSchema.safeParse(json);
  // Not JSON, no version, or a version this app does not know (also a newer one): unreadable as a whole.
  if (!version.success) return setAside(path, text);
  if (version.data.version === 1) {
    const v1 = V1FileSchema.safeParse(json);
    return v1.success ? { kind: 'v1', vision: v1.data.vision } : setAside(path, text);
  }
  if (version.data.version < 2 || version.data.version > 4) return setAside(path, text);
  const envelope = EnvelopeSchema.safeParse(json);
  if (!envelope.success) return setAside(path, text);
  return readEnvelope(path, text, version.data.version, json as Record<string, unknown>, envelope.data.providers);
}

/** Whether anything was left out so far while reading one file. */
interface ReadState {
  degraded: boolean;
}

/**
 * Reads the entries, slots and marker of a version 2 to 4 file and keeps a copy when anything was left out.
 *
 * @param path the settings file
 * @param text the file's content
 * @param version the file's version, 2 to 4
 * @param raw the parsed file
 * @param values the raw entries
 * @returns the settings that could be read
 */
function readEnvelope(
  path: string,
  text: string,
  version: number,
  raw: Record<string, unknown>,
  values: unknown[],
): SettingsReadResult {
  const read = readEntries(version, values);
  const state: ReadState = { degraded: read.degraded };
  let lastUsed: LastUsed;
  if (version === 2) {
    lastUsed = { vision: readSlot(raw.lastUsedId, read.providers, state), image: null };
  } else {
    const slots = (typeof raw.lastUsed === 'object' && raw.lastUsed !== null ? raw.lastUsed : {}) as Record<
      string,
      unknown
    >;
    lastUsed = {
      vision: readSlot(slots.vision, read.providers, state),
      image: readSlot(slots.image, read.providers, state),
    };
  }
  const marker = MarkerSchema.safeParse(raw.adoptLegacyKey);
  if (!marker.success) state.degraded = true;
  const stored: StoredSettings = {
    providers: read.providers,
    lastUsed,
    adoptLegacyKey: marker.success ? marker.data : null,
  };
  // The original stays in place and is only rewritten by the next save; the copy keeps what was left out. A failed
  // copy leaves the load degraded all the same, and the next start tries again.
  if (state.degraded && !isAlreadyKept(path, text)) {
    try {
      copyFileSync(path, corruptCopyPath(path));
    } catch {
      // Nothing is swept in this session either way.
    }
  }
  return { kind: 'stored', stored, degraded: state.degraded };
}

/**
 * Reads one slot of the entry used last; a broken slot marks the read as degraded.
 *
 * @param value the raw slot
 * @param providers the entries that were read
 * @param state the read's state, marked degraded for a broken slot
 * @returns the id, or null when the slot is empty, broken or names no entry that was read
 */
function readSlot(value: unknown, providers: ProviderEntry[], state: ReadState): string | null {
  const parsed = SlotSchema.safeParse(value);
  if (!parsed.success) state.degraded = true;
  // A slot naming an entry that was left out (or was never there) reads as nothing used last.
  return parsed.success && parsed.data !== null && providers.some((provider) => provider.id === parsed.data)
    ? parsed.data
    : null;
}

/**
 * Each entry on its own, upgraded to version 4 in memory (the first write stores version 4; until then a crash reads
 * the same again). Of a repeated id the first entry is kept, and only the first `MAX_PROVIDERS` entries.
 *
 * @param version the file's version, 2 to 4
 * @param values the raw entries
 * @returns the entries kept, and whether any was left out
 */
function readEntries(version: number, values: unknown[]): { providers: ProviderEntry[]; degraded: boolean } {
  const providers: ProviderEntry[] = [];
  let degraded = false;
  for (const value of values) {
    const entry = readEntry(version, value);
    if (entry === null || providers.some((provider) => provider.id === entry.id) || providers.length >= MAX_PROVIDERS) {
      degraded = true;
      continue;
    }
    providers.push(entry);
  }
  return { providers, degraded };
}

/**
 * Reads one entry of the given version as a version 4 entry.
 *
 * @param version the file's version, 2 to 4
 * @param value the raw entry
 * @returns the entry, or null when it breaks a rule
 */
function readEntry(version: number, value: unknown): ProviderEntry | null {
  if (version === 2) {
    const v2 = V2EntrySchema.safeParse(value);
    return v2.success ? { ...v2.data, kind: 'ollama', editModel: null, options: optionsFor('ollama') } : null;
  }
  if (version === 3) {
    const v3 = V3EntrySchema.safeParse(value);
    return v3.success ? { ...v3.data, options: optionsFor(v3.data.kind) } : null;
  }
  const v4 = V4EntrySchema.safeParse(value);
  return v4.success ? v4.data : null;
}
