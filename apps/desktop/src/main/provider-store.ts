import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_PROVIDER_OPTIONS,
  ENVIRONMENT_PROVIDER_ID,
  extraParametersMessage,
  isVisionKind,
  MAX_PROVIDERS,
  ModelNameSchema,
  PARALLEL_REQUESTS_DEFAULT,
  ParallelRequestsSchema,
  parseExtraParameters,
  ProviderKindSchema,
  ProviderNameSchema,
  ProviderOptionsSchema,
  purposeOf,
  SaveProviderSchema,
  VISION_TIMEOUT_DEFAULT_SECONDS,
  VISION_TIMEOUT_MAX_SECONDS,
  VISION_TIMEOUT_MIN_SECONDS,
  type ProviderKind,
  type ProviderList,
  type ProviderOptions,
  type ProviderPurpose,
  type ProviderView,
  type SaveProvider,
} from '@assetforge/contracts';
import {
  CredentialStoreUnavailableError,
  InvalidOperationError,
  NotFoundError,
  ValidationFailedError,
} from '@assetforge/core';
import { writeAtomic } from './atomic-file.js';
import type { SecretCodec } from './secret-codec.js';
import { usableBaseUrl } from './vision-config.js';

// App-level provider entries (`ollama` and `openai` for vision, `venice` for images) in `userData/provider-settings.json`
// (version 4) and one API key per entry, encrypted by the OS credential store, in
// `userData/credentials/vision-api-key-<id>` (the name predates the kinds and is kept for every kind).
// Kept free of Electron imports. A key is decrypted only when asked for and is never cached.
//
// A key file holds the encrypted key payload (see `encodeKeyPayload`): the key together with the origin it was
// entered for, so a hand-edited settings file cannot redirect a stored key to another origin. A file written before
// the payload existed holds the bare key; it is bound to the entry's origin when the settings are loaded.
//
// A settings file is read entry by entry: a broken entry is left out and the others load. Whatever was left out is kept
// in a `.corrupt-<stamp>` copy beside the file. No key file is deleted while no settings file exists or such a copy lies
// beside it, on this start and every later one: a key of an entry that was left out stays until the copy is removed.

export const PROVIDER_SETTINGS_FILE = 'provider-settings.json';
const CREDENTIALS_DIR = 'credentials';
/** The single key file of version 1; adopted by the upgrade, deleted otherwise. */
const LEGACY_KEY_NAME = 'vision-api-key';
const KEY_PREFIX = `${LEGACY_KEY_NAME}-`;

const ENV_BASE_URL = 'ASSETFORGE_VISION_BASE_URL';
const ENV_MODEL = 'ASSETFORGE_VISION_MODEL';
const ENVIRONMENT_NAME = 'Environment';
const UPGRADED_NAME = 'Ollama';

const INVALID_SETTINGS = 'The provider settings are not valid';
const INVALID_BASE_URL = 'The base URL must be an http or https URL without user info, query or fragment';
export const UNUSABLE_ENV_BASE_URL = `${ENV_BASE_URL} is not a usable http(s) URL; the vision provider is not configured`;
const FROM_ENVIRONMENT = 'The provider settings are set by the environment and cannot be changed';
const INVALID_NAME = 'The provider name must have 1 to 60 characters';
const DUPLICATE_NAME = 'A provider with this name already exists';
const TOO_MANY = `No more than ${MAX_PROVIDERS} providers`;
export const PROVIDER_NOT_FOUND = 'This provider does not exist';
export const KIND_CHANGED = 'The kind of a provider cannot be changed';
export const CANNOT_GENERATE = 'This provider cannot generate images';
export const CANNOT_ANALYSE = 'This provider cannot analyse images';
const IMAGE_URL_NOT_SECURE = 'An image provider needs an https URL, or http on a loopback address';

/**
 * Starts every key payload. A bare key is any text a user typed into a text field; the NUL characters make the marker
 * one that a typed key does not start with, and the test is a plain prefix test: with the marker the text is a
 * payload, without it a bare key.
 */
const KEY_PAYLOAD_MARKER = '\u0000assetforge-key\u0000';
const KeyPayloadSchema = z.object({ v: z.literal(1), origin: z.string().min(1), key: z.string().min(1) });

/** The text that is encrypted into a key file: the marker, then `{ v: 1, origin, key }` as JSON. */
export function encodeKeyPayload(origin: string, key: string): string {
  return `${KEY_PAYLOAD_MARKER}${JSON.stringify({ v: 1, origin, key })}`;
}

type DecodedKey = { form: 'bound'; origin: string; key: string } | { form: 'bare'; key: string } | null;

/** A payload that carries the marker but cannot be read is no key; it is never taken for a bare key. */
function decodeKeyPayload(text: string): DecodedKey {
  if (!text.startsWith(KEY_PAYLOAD_MARKER)) return text === '' ? null : { form: 'bare', key: text };
  let json: unknown;
  try {
    json = JSON.parse(text.slice(KEY_PAYLOAD_MARKER.length));
  } catch {
    return null;
  }
  const parsed = KeyPayloadSchema.safeParse(json);
  return parsed.success ? { form: 'bound', origin: parsed.data.origin, key: parsed.data.key } : null;
}

/** The refusal for an entry used for the other purpose. */
export const wrongKind = (wanted: ProviderPurpose): string => (wanted === 'image' ? CANNOT_GENERATE : CANNOT_ANALYSE);

export interface ProviderEntry {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  timeoutSeconds: number;
  /** Always null for `venice`. */
  taggingModel: string | null;
  /** Always null for `venice`. */
  promptModel: string | null;
  /** Always null for a vision kind. */
  editModel: string | null;
  /** The request options of a vision kind; always null for `venice`. */
  options: ProviderOptions | null;
}

/** The options an entry of the kind starts with. */
const optionsFor = (kind: ProviderKind): ProviderOptions | null => (isVisionKind(kind) ? { ...DEFAULT_PROVIDER_OPTIONS } : null);

export interface ProviderStore {
  list(): ProviderList;
  /** The entry of any kind. */
  get(id: string): ProviderEntry | null;
  /** The first entry of the purpose; `vision` without one. */
  first(purpose?: ProviderPurpose): ProviderEntry | null;
  /**
   * A given id: that entry, else NotFoundError, or InvalidOperationError when it serves another purpose.
   * Absent: the entry of the purpose used last, else the first of the purpose, else null. `vision` without one.
   */
  resolve(id: string | undefined, purpose?: ProviderPurpose): ProviderEntry | null;
  /** Records the entry as used last for its purpose. Best effort; a failed write is swallowed. */
  markUsed(id: string): void;
  save(input: SaveProvider): ProviderView;
  delete(id: string): void;
  /** Null unless the entry exists, is not the environment entry, and its origin equals the origin of `baseUrl`. */
  apiKeyFor(id: string, baseUrl: string): string | null;
  /** Called with the entry id after every save and delete. */
  onChange(listener: (id: string) => void): void;
}

type LastUsed = Record<ProviderPurpose, string | null>;

interface Stored {
  providers: ProviderEntry[];
  /** One slot per purpose: `vision` names an `ollama` or `openai` entry, `image` a `venice` entry. */
  lastUsed: LastUsed;
  /** Set by the upgrade until the legacy key file has been renamed to the entry's key file. */
  adoptLegacyKey: { id: string; origin: string } | null;
}

const EMPTY: Stored = { providers: [], lastUsed: { vision: null, image: null }, adoptLegacyKey: null };

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

/** The rules every stored entry of version 3 and 4 obeys. */
const entryRules = (e: { kind: ProviderKind; baseUrl: string; taggingModel: string | null; promptModel: string | null; editModel: string | null }) =>
  (isVisionKind(e.kind) ? e.editModel === null : e.taggingModel === null && e.promptModel === null) &&
  // The save rule holds on read too: a hand-edited file must not send a stored key over plain http.
  (isVisionKind(e.kind) || secureForImages(e.baseUrl));

const SlotSchema = z.uuid().nullable();
const MarkerSchema = z.object({ id: z.uuid(), origin: z.string() }).nullable();

const V3EntrySchema = z.object(V3EntryShape).refine(entryRules);

/**
 * Stored options: a missing or broken `parallelRequests` (written before the field existed, or edited by hand) reads
 * as the default, so the entry is kept. The IPC schema has no such default.
 */
const StoredOptionsSchema = ProviderOptionsSchema.extend({
  parallelRequests: ParallelRequestsSchema.catch(PARALLEL_REQUESTS_DEFAULT),
});

const V4EntrySchema = z
  .object({ ...V3EntryShape, options: StoredOptionsSchema.nullable() })
  .refine(entryRules)
  // Options exactly on a vision entry. Stored extra parameters the save rule refuses do not make the entry
  // unreadable: the gateway sends none for that entry, and the next save refuses the text.
  .refine((e) => (e.options === null) === !isVisionKind(e.kind));

/** Version 2 to 4: an object with an integer version; everything else is checked field by field and entry by entry. */
const VersionSchema = z.object({ version: z.int() });
const EnvelopeSchema = z.object({ providers: z.array(z.unknown()) });

/**
 * `degraded`: something was left out (a broken entry or field, an entry over the limit, a repeated id) or the file was
 * unreadable. A degraded load deletes no key file.
 */
type ReadResult =
  | { kind: 'v1'; vision: z.infer<typeof V1FileSchema>['vision'] }
  | { kind: 'stored'; stored: Stored; degraded: boolean }
  | { kind: 'none'; degraded: boolean };

export function createProviderStore(o: { userData: string; secrets: SecretCodec; env: NodeJS.ProcessEnv }): ProviderStore {
  const settingsPath = join(o.userData, PROVIDER_SETTINGS_FILE);
  const credentialsDir = join(o.userData, CREDENTIALS_DIR);
  const legacyKeyPath = join(credentialsDir, LEGACY_KEY_NAME);
  const keyPath = (id: string) => join(credentialsDir, `${KEY_PREFIX}${id}`);
  const listeners: ((id: string) => void)[] = [];

  const fromEnvironment = o.env[ENV_BASE_URL] !== undefined;
  // Once per store, i.e. per app start; the value itself is never logged.
  if (fromEnvironment && usableBaseUrl(o.env[ENV_BASE_URL] ?? '') === null) console.warn(UNUSABLE_ENV_BASE_URL);
  const environmentEntry = fromEnvironment ? environment(o.env) : null;
  /** Environment mode never writes; the entry used last is kept for this app start only. */
  let environmentLastUsed: string | null = null;

  let state: Stored | null = null;
  /**
   * Entries whose key file still holds a bare key because binding it at load failed, with the origin the entry had
   * then. Such a key is used for this app session while the entry keeps that origin.
   */
  const unboundOrigins = new Map<string, string>();

  const write = (next: Stored): void => {
    writeAtomic(settingsPath, `${JSON.stringify({ version: 4, ...next }, null, 2)}\n`);
  };
  /** Writes `next` and only then makes it the state, so a failed write changes nothing. */
  const commit = (next: Stored): void => {
    write(next);
    state = next;
  };

  /**
   * Writes the legacy key, bound to `origin`, as the entry's key file and removes the legacy file. When the key cannot
   * be read or written in the new form, the file is renamed as it is; the load then binds it like any bare key file.
   */
  const moveLegacyKey = (id: string, origin: string): void => {
    try {
      if (!o.secrets.available()) throw new Error('no credential store');
      const decoded = decodeKeyPayload(o.secrets.decrypt(readFileSync(legacyKeyPath)));
      if (decoded?.form !== 'bare') throw new Error('not a bare key');
      writeAtomic(keyPath(id), o.secrets.encrypt(encodeKeyPayload(origin, decoded.key)));
    } catch {
      renameSync(legacyKeyPath, keyPath(id));
      return;
    }
    rmSync(legacyKeyPath, { force: true });
  };

  /**
   * Moves the legacy key to the entry's key file, but only while the entry still has the origin it was entered for.
   * On a degraded load nothing is deleted and the settings file is not rewritten: a legacy key whose entry was left
   * out stays with its marker.
   */
  const adoptLegacyKey = (stored: Stored, degraded: boolean): Stored => {
    const marker = stored.adoptLegacyKey;
    if (marker === null) return stored;
    const entry = stored.providers.find((p) => p.id === marker.id);
    if (existsSync(legacyKeyPath)) {
      if (entry !== undefined && originOf(entry.baseUrl) === marker.origin) moveLegacyKey(entry.id, marker.origin);
      else if (degraded) return stored;
      else rmSync(legacyKeyPath, { force: true });
    }
    const next = { ...stored, adoptLegacyKey: null };
    // A degraded file stays as it is until the next save; the next start finds the key moved and clears the marker.
    if (!degraded) write(next);
    return next;
  };

  /**
   * Version 1 → 4. Every step is written before the next one, so a crash in between resumes on the next start.
   * With `keepKeys` no key file is deleted.
   */
  const upgrade = (vision: z.infer<typeof V1FileSchema>['vision'], keepKeys: boolean): Stored => {
    if (vision.baseUrl === null) {
      write(EMPTY);
      if (!keepKeys) rmSync(legacyKeyPath, { force: true });
      return EMPTY;
    }
    const id = randomUUID();
    const entry: ProviderEntry = {
      id,
      kind: 'ollama',
      name: UPGRADED_NAME,
      baseUrl: vision.baseUrl,
      timeoutSeconds: vision.timeoutSeconds,
      taggingModel: vision.taggingModel,
      promptModel: vision.promptModel,
      editModel: null,
      options: optionsFor('ollama'),
    };
    const marked: Stored = { ...EMPTY, providers: [entry], adoptLegacyKey: { id, origin: originOf(entry.baseUrl)! } };
    write(marked);
    return adoptLegacyKey(marked, keepKeys);
  };

  /**
   * Rewrites every bare key file of a listed entry as a payload bound to the entry's current origin, before any
   * request can read it. A failed rewrite keeps the old file; its key stays usable for this session.
   */
  const bindBareKeys = (stored: Stored): void => {
    if (!o.secrets.available()) return;
    for (const entry of stored.providers) {
      let decoded: DecodedKey;
      try {
        decoded = decodeKeyPayload(o.secrets.decrypt(readFileSync(keyPath(entry.id))));
      } catch {
        continue;
      }
      const origin = originOf(entry.baseUrl);
      if (decoded?.form !== 'bare' || origin === null) continue;
      try {
        writeAtomic(keyPath(entry.id), o.secrets.encrypt(encodeKeyPayload(origin, decoded.key)));
      } catch {
        unboundOrigins.set(entry.id, origin);
      }
    }
  };

  /** Leaves only the key files of listed entries: no temporary file, no legacy file, no orphan. */
  const sweepKeyFiles = (stored: Stored): void => {
    let names: string[];
    try {
      names = readdirSync(credentialsDir);
    } catch {
      return;
    }
    const ids = new Set(stored.providers.map((p) => p.id));
    for (const name of names) {
      if (!name.startsWith(LEGACY_KEY_NAME)) continue;
      const path = join(credentialsDir, name);
      if (name.endsWith('.tmp')) rmSync(path, { force: true });
      else if (name === LEGACY_KEY_NAME) rmSync(path, { force: true });
      else if (name.startsWith(KEY_PREFIX) && !ids.has(name.slice(KEY_PREFIX.length))) rmSync(path, { force: true });
    }
  };

  const load = (): Stored => {
    if (state !== null) return state;
    const read = readStored(settingsPath);
    // No settings file (a fresh install, or one set aside) or a damaged copy beside it: the list may lack entries
    // whose keys are still wanted, so no key file is deleted.
    const keepKeys =
      read.kind === 'none' || (read.kind === 'stored' && read.degraded) || corruptCopies(settingsPath).length > 0;
    let stored: Stored;
    if (read.kind === 'v1') stored = upgrade(read.vision, keepKeys);
    else if (read.kind === 'stored') stored = adoptLegacyKey(read.stored, keepKeys);
    else stored = EMPTY;
    bindBareKeys(stored);
    if (!keepKeys) sweepKeyFiles(stored);
    state = stored;
    return stored;
  };

  const entries = (): ProviderEntry[] => {
    if (fromEnvironment) return environmentEntry === null ? [] : [environmentEntry];
    return load().providers;
  };

  const get = (id: string): ProviderEntry | null => entries().find((p) => p.id === id) ?? null;
  const first = (purpose: ProviderPurpose): ProviderEntry | null =>
    entries().find((p) => purposeOf(p.kind) === purpose) ?? null;

  /** The entry of the purpose used last, while it still exists and serves that purpose. */
  const lastUsed = (purpose: ProviderPurpose): ProviderEntry | null => {
    // Environment mode has only the `ollama` environment entry, so its image slot stays empty.
    const id = fromEnvironment ? (purpose === 'vision' ? environmentLastUsed : null) : load().lastUsed[purpose];
    const entry = id === null ? null : get(id);
    return entry !== null && purposeOf(entry.kind) === purpose ? entry : null;
  };

  /**
   * The stored key of an entry, decrypted, and only when it was stored for the entry's origin; any failure to read or
   * decrypt counts as no key. A key stored for another origin is left alone: saving a key replaces it.
   */
  const decryptKey = (entry: ProviderEntry): string | null => {
    if (fromEnvironment || entry.id === ENVIRONMENT_PROVIDER_ID || !o.secrets.available()) return null;
    let data: Buffer;
    try {
      data = readFileSync(keyPath(entry.id));
    } catch {
      return null;
    }
    let decoded: DecodedKey;
    try {
      decoded = decodeKeyPayload(o.secrets.decrypt(data));
    } catch {
      return null;
    }
    if (decoded === null) return null;
    const origin = originOf(entry.baseUrl);
    if (origin === null) return null;
    if (decoded.form === 'bound') return decoded.origin === origin ? decoded.key : null;
    // A bare key is used only when its binding at load failed, and only while the entry keeps the origin of then.
    return unboundOrigins.get(entry.id) === origin ? decoded.key : null;
  };

  const view = (entry: ProviderEntry): ProviderView => ({ ...entry, hasApiKey: decryptKey(entry) !== null });

  const notify = (id: string): void => {
    for (const listener of listeners) {
      try {
        listener(id);
      } catch {
        // One failing listener must not keep the others from hearing of the change.
      }
    }
  };

  return {
    list: () => ({
      providers: entries().map(view),
      lastUsedId: lastUsed('vision')?.id ?? null,
      lastUsedImageId: lastUsed('image')?.id ?? null,
      fromEnvironment,
      canStoreKey: o.secrets.available(),
    }),
    get,
    first: (purpose = 'vision') => first(purpose),
    resolve(id, purpose = 'vision') {
      if (id !== undefined) {
        const entry = get(id);
        if (entry === null) throw new NotFoundError(PROVIDER_NOT_FOUND);
        if (purposeOf(entry.kind) !== purpose) throw new InvalidOperationError(wrongKind(purpose));
        return entry;
      }
      return lastUsed(purpose) ?? first(purpose);
    },
    markUsed(id) {
      try {
        const entry = get(id);
        if (entry === null) return;
        if (fromEnvironment) {
          environmentLastUsed = id;
          return;
        }
        const current = load();
        const slot = purposeOf(entry.kind);
        if (current.lastUsed[slot] !== id) commit({ ...current, lastUsed: { ...current.lastUsed, [slot]: id } });
      } catch {
        // Best effort: the entry used last is a convenience.
      }
    },
    save(input) {
      if (fromEnvironment) throw new InvalidOperationError(FROM_ENVIRONMENT);
      const parsed = SaveProviderSchema.safeParse(input);
      if (!parsed.success) throw new InvalidOperationError(INVALID_SETTINGS);
      const { id, apiKey, name: rawName, baseUrl: rawBaseUrl, timeoutSeconds } = parsed.data;
      const current = load();
      const previous = id === undefined ? null : (current.providers.find((p) => p.id === id) ?? null);
      if (id !== undefined && previous === null) throw new NotFoundError(PROVIDER_NOT_FOUND);
      if (previous !== null && parsed.data.kind !== undefined && parsed.data.kind !== previous.kind) {
        throw new InvalidOperationError(KIND_CHANGED);
      }
      const kind = previous?.kind ?? parsed.data.kind ?? 'ollama';
      const name = ProviderNameSchema.safeParse(rawName);
      if (!name.success) throw new ValidationFailedError(INVALID_NAME);
      const baseUrl = usableBaseUrl(rawBaseUrl.trim());
      if (baseUrl === null) throw new InvalidOperationError(INVALID_BASE_URL);
      const vision = isVisionKind(kind);
      if (!vision && !secureForImages(baseUrl)) throw new ValidationFailedError(IMAGE_URL_NOT_SECURE);
      // A vision entry keeps its stored options when none are sent and a new one starts with the defaults;
      // an image entry has none, whatever was sent.
      const options = vision ? (parsed.data.options ?? previous?.options ?? optionsFor(kind)) : null;
      if (vision && options !== null) {
        const extra = parseExtraParameters(options.extra, kind);
        if (!extra.ok) throw new ValidationFailedError(extraParametersMessage(extra));
      }
      const others = current.providers.filter((p) => p.id !== id);
      const key = name.data.toLowerCase();
      if (others.some((p) => p.name.toLowerCase() === key)) throw new InvalidOperationError(DUPLICATE_NAME);
      if (previous === null && current.providers.length >= MAX_PROVIDERS) throw new InvalidOperationError(TOO_MANY);
      // Encrypt before anything is written, so a refused key leaves the entry unchanged too. The key is stored
      // together with the origin it is entered for.
      let encrypted: Buffer | null = null;
      if (typeof apiKey === 'string') {
        if (!o.secrets.available()) throw new CredentialStoreUnavailableError();
        encrypted = o.secrets.encrypt(encodeKeyPayload(originOf(baseUrl)!, apiKey));
      }

      // An image entry keeps no vision models, a vision entry no edit model. An absent edit model keeps the stored one.
      const editModel = parsed.data.editModel === undefined ? (previous?.editModel ?? null) : parsed.data.editModel;
      const entry: ProviderEntry = {
        id: previous?.id ?? randomUUID(),
        kind,
        name: name.data,
        baseUrl,
        timeoutSeconds,
        taggingModel: vision ? parsed.data.taggingModel : null,
        promptModel: vision ? parsed.data.promptModel : null,
        editModel: vision ? null : editModel,
        options,
      };
      const providers = previous === null ? [...current.providers, entry] : current.providers.map((p) => (p.id === entry.id ? entry : p));
      // The settings go first, so a failed write loses no key. A key is bound to the origin it was entered for, so an
      // old key left behind by a failed removal is never sent to a new origin.
      commit({ ...current, providers });
      // The entry changed once it is written, so listeners hear of it even if a key file operation fails.
      try {
        if (previous === null || apiKey === null || originOf(previous.baseUrl) !== originOf(baseUrl)) {
          unboundOrigins.delete(entry.id);
          rmSync(keyPath(entry.id), { force: true });
        }
        if (encrypted !== null) writeAtomic(keyPath(entry.id), encrypted);
      } finally {
        notify(entry.id);
      }
      return view(entry);
    },
    delete(id) {
      if (fromEnvironment) throw new InvalidOperationError(FROM_ENVIRONMENT);
      const current = load();
      if (!current.providers.some((p) => p.id === id)) throw new NotFoundError(PROVIDER_NOT_FOUND);
      // The entry goes first, so a failure half-way leaves an orphaned key file, which the next start deletes.
      commit({
        ...current,
        providers: current.providers.filter((p) => p.id !== id),
        lastUsed: {
          vision: current.lastUsed.vision === id ? null : current.lastUsed.vision,
          image: current.lastUsed.image === id ? null : current.lastUsed.image,
        },
      });
      unboundOrigins.delete(id);
      try {
        rmSync(keyPath(id), { force: true });
      } finally {
        notify(id);
      }
    },
    apiKeyFor(id, baseUrl) {
      if (fromEnvironment || id === ENVIRONMENT_PROVIDER_ID) return null;
      const entry = get(id);
      if (entry === null) return null;
      const origin = originOf(baseUrl);
      if (origin === null || originOf(entry.baseUrl) !== origin) return null;
      return decryptKey(entry);
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
}

/** The read-only entry of environment mode; none when the environment URL is not usable. */
function environment(env: NodeJS.ProcessEnv): ProviderEntry | null {
  const baseUrl = usableBaseUrl(env[ENV_BASE_URL] ?? '');
  if (baseUrl === null) return null;
  const model = env[ENV_MODEL]?.trim();
  const usableModel = model !== undefined && ModelNameSchema.safeParse(model).success ? model : null;
  return {
    id: ENVIRONMENT_PROVIDER_ID,
    kind: 'ollama',
    name: ENVIRONMENT_NAME,
    baseUrl,
    timeoutSeconds: VISION_TIMEOUT_DEFAULT_SECONDS,
    taggingModel: usableModel,
    promptModel: usableModel,
    editModel: null,
    options: optionsFor('ollama'),
  };
}

/** An image provider carries a key for a paid service: https, or plain http only to this machine. */
function secureForImages(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  // The WHATWG parser has already normalised IPv4 forms (e.g. `127.1`) and IPv6 literals (e.g. `[0::1]`).
  const host = url.hostname;
  return host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function originOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

/** The paths of the `.corrupt-<stamp>` copies beside the settings file. */
function corruptCopies(path: string): string[] {
  const dir = dirname(path);
  const prefix = `${basename(path)}.corrupt-`;
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function readStored(path: string): ReadResult {
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
  const corruptPath = () => `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  /** A copy with the same content already lies beside the file. */
  const alreadyKept = (): boolean =>
    corruptCopies(path).some((copy) => {
      try {
        return readFileSync(copy, 'utf8') === text;
      } catch {
        return false;
      }
    });
  /** Same pattern as the workspace registry: keep the unreadable file aside, start empty. */
  const setAside = (): ReadResult => {
    if (alreadyKept()) rmSync(path, { force: true });
    else renameSync(path, corruptPath());
    return { kind: 'none', degraded: true };
  };

  const version = VersionSchema.safeParse(json);
  // Not JSON, no version, or a version this app does not know (also a newer one): unreadable as a whole.
  if (!version.success) return setAside();
  if (version.data.version === 1) {
    const v1 = V1FileSchema.safeParse(json);
    return v1.success ? { kind: 'v1', vision: v1.data.vision } : setAside();
  }
  if (version.data.version < 2 || version.data.version > 4) return setAside();
  const envelope = EnvelopeSchema.safeParse(json);
  if (!envelope.success) return setAside();

  const raw = json as Record<string, unknown>;
  const read = readEntries(version.data.version, envelope.data.providers);
  let degraded = read.degraded;
  const slot = (value: unknown): string | null => {
    const parsed = SlotSchema.safeParse(value);
    if (!parsed.success) degraded = true;
    // A slot naming an entry that was left out (or was never there) reads as nothing used last.
    return parsed.success && parsed.data !== null && read.providers.some((p) => p.id === parsed.data) ? parsed.data : null;
  };
  let lastUsed: LastUsed;
  if (version.data.version === 2) {
    lastUsed = { vision: slot(raw.lastUsedId), image: null };
  } else {
    const slots = (typeof raw.lastUsed === 'object' && raw.lastUsed !== null ? raw.lastUsed : {}) as Record<string, unknown>;
    lastUsed = { vision: slot(slots.vision), image: slot(slots.image) };
  }
  const marker = MarkerSchema.safeParse(raw.adoptLegacyKey);
  if (!marker.success) degraded = true;
  const stored: Stored = { providers: read.providers, lastUsed, adoptLegacyKey: marker.success ? marker.data : null };
  // The original stays in place and is only rewritten by the next save; the copy keeps what was left out. A failed
  // copy leaves the load degraded all the same, and the next start tries again.
  if (degraded && !alreadyKept()) {
    try {
      copyFileSync(path, corruptPath());
    } catch {
      // Nothing is swept in this session either way.
    }
  }
  return { kind: 'stored', stored, degraded };
}

/**
 * Each entry on its own, upgraded to version 4 in memory (the first write stores version 4; until then a crash reads
 * the same again). Of a repeated id the first entry is kept, and only the first `MAX_PROVIDERS` entries.
 */
function readEntries(version: number, values: unknown[]): { providers: ProviderEntry[]; degraded: boolean } {
  const providers: ProviderEntry[] = [];
  let degraded = false;
  for (const value of values) {
    const entry = readEntry(version, value);
    if (entry === null || providers.some((p) => p.id === entry.id) || providers.length >= MAX_PROVIDERS) {
      degraded = true;
      continue;
    }
    providers.push(entry);
  }
  return { providers, degraded };
}

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
