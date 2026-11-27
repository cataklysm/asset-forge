import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_PROVIDER_OPTIONS,
  ENVIRONMENT_PROVIDER_ID,
  extraParametersMessage,
  isVisionKind,
  MAX_PROVIDERS,
  ModelNameSchema,
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

const V2FileSchema = z.object({
  version: z.literal(2),
  providers: z
    .array(
      z.object({
        id: z.uuid(),
        name: ProviderNameSchema,
        baseUrl: StoredBaseUrlSchema,
        timeoutSeconds: TimeoutSchema,
        taggingModel: ModelNameSchema.nullable(),
        promptModel: ModelNameSchema.nullable(),
      }),
    )
    .max(MAX_PROVIDERS)
    .refine((entries) => new Set(entries.map((e) => e.id)).size === entries.length),
  lastUsedId: z.uuid().nullable(),
  adoptLegacyKey: z.object({ id: z.uuid(), origin: z.string() }).nullable(),
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

const entriesOf = <T extends { id: string }>(entry: z.ZodType<T>) =>
  z
    .array(entry)
    .max(MAX_PROVIDERS)
    .refine((entries) => new Set(entries.map((e) => e.id)).size === entries.length);

const LastUsedSchema = z.object({ vision: z.uuid().nullable(), image: z.uuid().nullable() });
const MarkerSchema = z.object({ id: z.uuid(), origin: z.string() }).nullable();

const V3FileSchema = z.object({
  version: z.literal(3),
  providers: entriesOf(z.object(V3EntryShape).refine(entryRules)),
  lastUsed: LastUsedSchema,
  adoptLegacyKey: MarkerSchema,
});

const V4FileSchema = z.object({
  version: z.literal(4),
  providers: entriesOf(
    z
      .object({ ...V3EntryShape, options: ProviderOptionsSchema.nullable() })
      .refine(entryRules)
      // Options exactly on a vision entry. Stored extra parameters the save rule refuses do not make the file
      // unreadable: the gateway sends none for that entry, and the next save refuses the text.
      .refine((e) => (e.options === null) === !isVisionKind(e.kind)),
  ),
  lastUsed: LastUsedSchema,
  adoptLegacyKey: MarkerSchema,
});

type ReadResult = { kind: 'v1'; vision: z.infer<typeof V1FileSchema>['vision'] } | { kind: 'stored'; stored: Stored } | { kind: 'none' };

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

  const write = (next: Stored): void => {
    writeAtomic(settingsPath, `${JSON.stringify({ version: 4, ...next }, null, 2)}\n`);
  };
  /** Writes `next` and only then makes it the state, so a failed write changes nothing. */
  const commit = (next: Stored): void => {
    write(next);
    state = next;
  };

  /** Moves the legacy key to the entry's key file, but only while the entry still has the origin it was entered for. */
  const adoptLegacyKey = (stored: Stored): Stored => {
    const marker = stored.adoptLegacyKey;
    if (marker === null) return stored;
    const entry = stored.providers.find((p) => p.id === marker.id);
    if (existsSync(legacyKeyPath)) {
      if (entry !== undefined && originOf(entry.baseUrl) === marker.origin) renameSync(legacyKeyPath, keyPath(entry.id));
      else rmSync(legacyKeyPath, { force: true });
    }
    const next = { ...stored, adoptLegacyKey: null };
    write(next);
    return next;
  };

  /** Version 1 → 4. Every step is written before the next one, so a crash in between resumes on the next start. */
  const upgrade = (vision: z.infer<typeof V1FileSchema>['vision']): Stored => {
    if (vision.baseUrl === null) {
      write(EMPTY);
      rmSync(legacyKeyPath, { force: true });
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
    return adoptLegacyKey(marked);
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
    let stored: Stored;
    if (read.kind === 'v1') stored = upgrade(read.vision);
    else if (read.kind === 'stored') stored = adoptLegacyKey(read.stored);
    else stored = EMPTY;
    sweepKeyFiles(stored);
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

  /** The stored key of an entry, decrypted; any failure to read or decrypt counts as no key. */
  const decryptKey = (id: string): string | null => {
    if (fromEnvironment || id === ENVIRONMENT_PROVIDER_ID || !o.secrets.available()) return null;
    let data: Buffer;
    try {
      data = readFileSync(keyPath(id));
    } catch {
      return null;
    }
    try {
      const key = o.secrets.decrypt(data);
      return key === '' ? null : key;
    } catch {
      return null;
    }
  };

  const view = (entry: ProviderEntry): ProviderView => ({ ...entry, hasApiKey: decryptKey(entry.id) !== null });

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
      // Encrypt before anything is written, so a refused key leaves the entry unchanged too.
      let encrypted: Buffer | null = null;
      if (typeof apiKey === 'string') {
        if (!o.secrets.available()) throw new CredentialStoreUnavailableError();
        encrypted = o.secrets.encrypt(apiKey);
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
      // The key is bound to the origin it was entered for. The old key goes first, so a failure
      // half-way leaves no key rather than a key bound to the wrong origin.
      if (previous === null || apiKey === null || originOf(previous.baseUrl) !== originOf(baseUrl)) {
        rmSync(keyPath(entry.id), { force: true });
      }
      commit({ ...current, providers });
      // The entry changed once it is written, so listeners hear of it even if the key write fails.
      try {
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
      return decryptKey(id);
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

function readStored(path: string): ReadResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const v4 = V4FileSchema.safeParse(json);
  if (v4.success) return { kind: 'stored', stored: v4.data };
  const v3 = V3FileSchema.safeParse(json);
  if (v3.success) {
    // Version 3 → 4 in memory only; the first write stores version 4. Until then a crash reads the same again.
    const { providers, lastUsed, adoptLegacyKey } = v3.data;
    return {
      kind: 'stored',
      stored: { providers: providers.map((p) => ({ ...p, options: optionsFor(p.kind) })), lastUsed, adoptLegacyKey },
    };
  }
  const v2 = V2FileSchema.safeParse(json);
  if (v2.success) {
    // Version 2 → 4 in memory only; the first write stores version 4. Until then a crash reads the same again.
    const { providers, lastUsedId, adoptLegacyKey } = v2.data;
    return {
      kind: 'stored',
      stored: {
        providers: providers.map((p) => ({ ...p, kind: 'ollama' as const, editModel: null, options: optionsFor('ollama') })),
        lastUsed: { vision: lastUsedId, image: null },
        adoptLegacyKey,
      },
    };
  }
  const v1 = V1FileSchema.safeParse(json);
  if (v1.success) return { kind: 'v1', vision: v1.data.vision };
  // Same pattern as the workspace registry: keep the unreadable file aside, start empty.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  renameSync(path, `${path}.corrupt-${stamp}`);
  return { kind: 'none' };
}
