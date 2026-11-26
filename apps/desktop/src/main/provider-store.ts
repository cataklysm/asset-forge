import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ENVIRONMENT_PROVIDER_ID,
  MAX_PROVIDERS,
  ModelNameSchema,
  ProviderNameSchema,
  SaveProviderSchema,
  VISION_TIMEOUT_DEFAULT_SECONDS,
  VISION_TIMEOUT_MAX_SECONDS,
  VISION_TIMEOUT_MIN_SECONDS,
  type ProviderList,
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

// App-level vision provider entries in `userData/provider-settings.json` (version 2) and one API key
// per entry, encrypted by the OS credential store, in `userData/credentials/vision-api-key-<id>`.
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

export interface ProviderEntry {
  id: string;
  name: string;
  baseUrl: string;
  timeoutSeconds: number;
  taggingModel: string | null;
  promptModel: string | null;
}

export interface ProviderStore {
  list(): ProviderList;
  get(id: string): ProviderEntry | null;
  first(): ProviderEntry | null;
  /** A given id: that entry, else NotFoundError. Absent: the entry used last, else the first, else null. */
  resolve(id: string | undefined): ProviderEntry | null;
  /** Best effort; a failed write is swallowed. */
  markUsed(id: string): void;
  save(input: SaveProvider): ProviderView;
  delete(id: string): void;
  /** Null unless the entry exists, is not the environment entry, and its origin equals the origin of `baseUrl`. */
  apiKeyFor(id: string, baseUrl: string): string | null;
  /** Called with the entry id after every save and delete. */
  onChange(listener: (id: string) => void): void;
}

interface Stored {
  providers: ProviderEntry[];
  lastUsedId: string | null;
  /** Set by the upgrade until the legacy key file has been renamed to the entry's key file. */
  adoptLegacyKey: { id: string; origin: string } | null;
}

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

type ReadResult = { kind: 'v1'; vision: z.infer<typeof V1FileSchema>['vision'] } | { kind: 'v2'; stored: Stored } | { kind: 'none' };

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
    writeAtomic(settingsPath, `${JSON.stringify({ version: 2, ...next }, null, 2)}\n`);
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

  /** Version 1 → 2. Every step is written before the next one, so a crash in between resumes on the next start. */
  const upgrade = (vision: z.infer<typeof V1FileSchema>['vision']): Stored => {
    if (vision.baseUrl === null) {
      const empty: Stored = { providers: [], lastUsedId: null, adoptLegacyKey: null };
      write(empty);
      rmSync(legacyKeyPath, { force: true });
      return empty;
    }
    const id = randomUUID();
    const entry: ProviderEntry = {
      id,
      name: UPGRADED_NAME,
      baseUrl: vision.baseUrl,
      timeoutSeconds: vision.timeoutSeconds,
      taggingModel: vision.taggingModel,
      promptModel: vision.promptModel,
    };
    const marked: Stored = { providers: [entry], lastUsedId: null, adoptLegacyKey: { id, origin: originOf(entry.baseUrl)! } };
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
    else if (read.kind === 'v2') stored = adoptLegacyKey(read.stored);
    else stored = { providers: [], lastUsedId: null, adoptLegacyKey: null };
    sweepKeyFiles(stored);
    state = stored;
    return stored;
  };

  const entries = (): ProviderEntry[] => {
    if (fromEnvironment) return environmentEntry === null ? [] : [environmentEntry];
    return load().providers;
  };

  const get = (id: string): ProviderEntry | null => entries().find((p) => p.id === id) ?? null;

  const lastUsedId = (): string | null => {
    const id = fromEnvironment ? environmentLastUsed : load().lastUsedId;
    return id !== null && get(id) !== null ? id : null;
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
      lastUsedId: lastUsedId(),
      fromEnvironment,
      canStoreKey: o.secrets.available(),
    }),
    get,
    first: () => entries()[0] ?? null,
    resolve(id) {
      if (id !== undefined) {
        const entry = get(id);
        if (entry === null) throw new NotFoundError(PROVIDER_NOT_FOUND);
        return entry;
      }
      const last = lastUsedId();
      return (last === null ? null : get(last)) ?? entries()[0] ?? null;
    },
    markUsed(id) {
      try {
        if (get(id) === null) return;
        if (fromEnvironment) {
          environmentLastUsed = id;
          return;
        }
        const current = load();
        if (current.lastUsedId !== id) commit({ ...current, lastUsedId: id });
      } catch {
        // Best effort: the entry used last is a convenience.
      }
    },
    save(input) {
      if (fromEnvironment) throw new InvalidOperationError(FROM_ENVIRONMENT);
      const parsed = SaveProviderSchema.safeParse(input);
      if (!parsed.success) throw new InvalidOperationError(INVALID_SETTINGS);
      const { id, apiKey, name: rawName, baseUrl: rawBaseUrl, ...rest } = parsed.data;
      const current = load();
      const previous = id === undefined ? null : (current.providers.find((p) => p.id === id) ?? null);
      if (id !== undefined && previous === null) throw new NotFoundError(PROVIDER_NOT_FOUND);
      const name = ProviderNameSchema.safeParse(rawName);
      if (!name.success) throw new ValidationFailedError(INVALID_NAME);
      const baseUrl = usableBaseUrl(rawBaseUrl.trim());
      if (baseUrl === null) throw new InvalidOperationError(INVALID_BASE_URL);
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

      const entry: ProviderEntry = { id: previous?.id ?? randomUUID(), name: name.data, baseUrl, ...rest };
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
        lastUsedId: current.lastUsedId === id ? null : current.lastUsedId,
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
    name: ENVIRONMENT_NAME,
    baseUrl,
    timeoutSeconds: VISION_TIMEOUT_DEFAULT_SECONDS,
    taggingModel: usableModel,
    promptModel: usableModel,
  };
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
  const v2 = V2FileSchema.safeParse(json);
  if (v2.success) {
    const { providers, lastUsedId, adoptLegacyKey } = v2.data;
    return { kind: 'v2', stored: { providers, lastUsedId, adoptLegacyKey } };
  }
  const v1 = V1FileSchema.safeParse(json);
  if (v1.success) return { kind: 'v1', vision: v1.data.vision };
  // Same pattern as the workspace registry: keep the unreadable file aside, start empty.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  renameSync(path, `${path}.corrupt-${stamp}`);
  return { kind: 'none' };
}
