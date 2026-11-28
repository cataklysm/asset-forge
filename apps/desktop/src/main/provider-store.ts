/* eslint-disable max-lines -- load, save, delete and the key handling share one serial write order (docs/backlog.md) */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  ENVIRONMENT_PROVIDER_ID,
  extraParametersMessage,
  isVisionKind,
  MAX_PROVIDERS,
  ModelNameSchema,
  parseExtraParameters,
  ProviderNameSchema,
  purposeOf,
  SaveProviderSchema,
  VISION_TIMEOUT_DEFAULT_SECONDS,
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
import {
  KIND_CHANGED,
  optionsFor,
  originOf,
  PROVIDER_NOT_FOUND,
  secureForImages,
  wrongKind,
  type ProviderEntry,
} from './provider-entry.js';
import { ProviderKeyFiles } from './provider-keys.js';
import { loadProviderSettings } from './provider-settings-load.js';
import { PROVIDER_SETTINGS_FILE, writeStoredSettings, type StoredSettings } from './provider-settings-file.js';
import type { SecretCodec } from './secret-codec.js';
import { usableBaseUrl } from './vision-config.js';

// App-level provider entries (`ollama` and `openai` for vision, `venice` for images) in `userData/provider-settings.json`
// (see `provider-settings-file.ts`) and one API key per entry (see `provider-keys.ts`). Kept free of Electron imports.

const ENV_BASE_URL = 'ASSETFORGE_VISION_BASE_URL';
const ENV_MODEL = 'ASSETFORGE_VISION_MODEL';
const ENVIRONMENT_NAME = 'Environment';

const INVALID_SETTINGS = 'The provider settings are not valid';
const INVALID_BASE_URL = 'The base URL must be an http or https URL without user info, query or fragment';
/** The one warning of an unusable environment URL; it never carries the value. */
export const UNUSABLE_ENV_BASE_URL = `${ENV_BASE_URL} is not a usable http(s) URL; the vision provider is not configured`;
const FROM_ENVIRONMENT = 'The provider settings are set by the environment and cannot be changed';
const INVALID_NAME = 'The provider name must have 1 to 60 characters';
const DUPLICATE_NAME = 'A provider with this name already exists';
const TOO_MANY = `No more than ${MAX_PROVIDERS} providers`;
const IMAGE_URL_NOT_SECURE = 'An image provider needs an https URL, or http on a loopback address';

/** The provider entries at app level. */
export interface ProviderStore {
  /**
   * Lists the entries as the renderer sees them.
   *
   * @returns every entry with `hasApiKey`, the entries used last and the store's mode
   */
  list(): ProviderList;
  /**
   * The entry of any kind.
   *
   * @param id the entry's id
   * @returns the entry, or null
   */
  get(id: string): ProviderEntry | null;
  /**
   * The first entry of the purpose; `vision` without one.
   *
   * @param purpose the purpose the entry serves
   * @returns the entry, or null
   */
  first(purpose?: ProviderPurpose): ProviderEntry | null;
  /**
   * A given id: that entry, else NotFoundError, or InvalidOperationError when it serves another purpose.
   * Absent: the entry of the purpose used last, else the first of the purpose, else null. `vision` without one.
   *
   * @param id the entry asked for, if any
   * @param purpose the purpose the entry must serve
   * @returns the entry, or null when none is configured
   */
  resolve(id: string | undefined, purpose?: ProviderPurpose): ProviderEntry | null;
  /**
   * Records the entry as used last for its purpose. Best effort; a failed write is swallowed.
   *
   * @param id the entry's id
   */
  markUsed(id: string): void;
  /**
   * Creates or changes an entry and its key.
   *
   * @param input what the renderer sent
   * @returns the saved entry as the renderer sees it
   */
  save(input: SaveProvider): ProviderView;
  /**
   * Deletes an entry and its key file.
   *
   * @param id the entry's id
   */
  delete(id: string): void;
  /**
   * The entry's key for a request to `baseUrl`.
   *
   * @param id the entry's id
   * @param baseUrl the URL the request goes to
   * @returns null unless the entry exists, is not the environment entry, and its origin equals the origin of `baseUrl`
   */
  apiKeyFor(id: string, baseUrl: string): string | null;
  /**
   * Called with the entry id after every save and delete.
   *
   * @param listener hears the id of the changed entry
   */
  onChange(listener: (id: string) => void): void;
}

/** What `createProviderStore` is wired with. */
export interface ProviderStoreOptions {
  /** The app's `userData` directory. */
  userData: string;
  /** The OS credential store. */
  secrets: SecretCodec;
  /** The process environment; `ASSETFORGE_VISION_BASE_URL` switches to environment mode. */
  env: NodeJS.ProcessEnv;
}

/**
 * Creates the provider store. Environment mode is decided here, once per app start.
 *
 * @param options the `userData` directory, the credential store and the environment
 * @returns the store
 */
export function createProviderStore(options: ProviderStoreOptions): ProviderStore {
  const store = new SettingsProviderStore(options);
  return {
    list: () => store.list(),
    get: (id) => store.get(id),
    first: (purpose = 'vision') => store.first(purpose),
    resolve: (id, purpose = 'vision') => store.resolve(id, purpose),
    markUsed: (id) => store.markUsed(id),
    save: (input) => store.save(input),
    delete: (id) => store.delete(id),
    apiKeyFor: (id, baseUrl) => store.apiKeyFor(id, baseUrl),
    onChange: (listener) => store.onChange(listener),
  };
}

/** The store behind `createProviderStore`: the settings file, or the read-only entry of environment mode. */
class SettingsProviderStore {
  private readonly settingsPath: string;
  private readonly keys: ProviderKeyFiles;
  private readonly listeners: ((id: string) => void)[] = [];
  private readonly fromEnvironment: boolean;
  private readonly environmentEntry: ProviderEntry | null;
  /** Environment mode never writes; the entry used last is kept for this app start only. */
  private environmentLastUsed: string | null = null;
  /** The settings once loaded; loaded on first use. */
  private state: StoredSettings | null = null;

  /**
   * @param options the `userData` directory, the credential store and the environment
   */
  constructor(options: ProviderStoreOptions) {
    this.settingsPath = join(options.userData, PROVIDER_SETTINGS_FILE);
    this.keys = new ProviderKeyFiles(options.userData, options.secrets);
    this.fromEnvironment = options.env[ENV_BASE_URL] !== undefined;
    // Once per store, i.e. per app start; the value itself is never logged.
    if (this.fromEnvironment && usableBaseUrl(options.env[ENV_BASE_URL] ?? '') === null) console.warn(UNUSABLE_ENV_BASE_URL);
    this.environmentEntry = this.fromEnvironment ? environmentEntryOf(options.env) : null;
  }

  /**
   * Writes `next` and only then makes it the state, so a failed write changes nothing.
   *
   * @param next the settings to store
   */
  private commit(next: StoredSettings): void {
    writeStoredSettings(this.settingsPath, next);
    this.state = next;
  }

  /**
   * The settings, loaded on first use.
   *
   * @returns the settings in memory
   */
  private load(): StoredSettings {
    if (this.state !== null) return this.state;
    const stored = loadProviderSettings(this.settingsPath, this.keys);
    this.state = stored;
    return stored;
  }

  /**
   * Every entry of the mode.
   *
   * @returns the environment entry in environment mode, else the stored entries
   */
  private entries(): ProviderEntry[] {
    if (this.fromEnvironment) return this.environmentEntry === null ? [] : [this.environmentEntry];
    return this.load().providers;
  }

  /**
   * The entry of the purpose used last, while it still exists and serves that purpose.
   *
   * @param purpose the slot to read
   * @returns the entry, or null
   */
  private lastUsed(purpose: ProviderPurpose): ProviderEntry | null {
    // Environment mode has only the `ollama` environment entry, so its image slot stays empty.
    const id = this.fromEnvironment ? (purpose === 'vision' ? this.environmentLastUsed : null) : this.load().lastUsed[purpose];
    const entry = id === null ? null : this.get(id);
    return entry !== null && purposeOf(entry.kind) === purpose ? entry : null;
  }

  /**
   * The stored key of an entry; never one of the environment entry or without a usable credential store.
   *
   * @param entry the entry whose key is read
   * @returns the key, or null
   */
  private decryptKey(entry: ProviderEntry): string | null {
    if (this.fromEnvironment || entry.id === ENVIRONMENT_PROVIDER_ID || !this.keys.available()) return null;
    return this.keys.decrypt(entry);
  }

  /**
   * The entry as the renderer sees it: without the key, with whether one is stored.
   *
   * @param entry the entry
   * @returns the view
   */
  private view(entry: ProviderEntry): ProviderView {
    return { ...entry, hasApiKey: this.decryptKey(entry) !== null };
  }

  /**
   * Tells every listener of a changed entry.
   *
   * @param id the entry's id
   */
  private notify(id: string): void {
    for (const listener of this.listeners) {
      try {
        listener(id);
      } catch {
        // One failing listener must not keep the others from hearing of the change.
      }
    }
  }

  /** See `ProviderStore.list`. @returns the list */
  list(): ProviderList {
    return {
      providers: this.entries().map((entry) => this.view(entry)),
      lastUsedId: this.lastUsed('vision')?.id ?? null,
      lastUsedImageId: this.lastUsed('image')?.id ?? null,
      fromEnvironment: this.fromEnvironment,
      canStoreKey: this.keys.available(),
    };
  }

  /** See `ProviderStore.get`. @param id the entry's id @returns the entry, or null */
  get(id: string): ProviderEntry | null {
    return this.entries().find((provider) => provider.id === id) ?? null;
  }

  /** See `ProviderStore.first`. @param purpose the purpose @returns the entry, or null */
  first(purpose: ProviderPurpose): ProviderEntry | null {
    return this.entries().find((provider) => purposeOf(provider.kind) === purpose) ?? null;
  }

  /** See `ProviderStore.resolve`. @param id the entry asked for @param purpose the purpose @returns the entry, or null */
  resolve(id: string | undefined, purpose: ProviderPurpose): ProviderEntry | null {
    if (id !== undefined) {
      const entry = this.get(id);
      if (entry === null) throw new NotFoundError(PROVIDER_NOT_FOUND);
      if (purposeOf(entry.kind) !== purpose) throw new InvalidOperationError(wrongKind(purpose));
      return entry;
    }
    return this.lastUsed(purpose) ?? this.first(purpose);
  }

  /** See `ProviderStore.markUsed`. @param id the entry's id */
  markUsed(id: string): void {
    try {
      const entry = this.get(id);
      if (entry === null) return;
      if (this.fromEnvironment) {
        this.environmentLastUsed = id;
        return;
      }
      const current = this.load();
      const slot = purposeOf(entry.kind);
      if (current.lastUsed[slot] !== id) this.commit({ ...current, lastUsed: { ...current.lastUsed, [slot]: id } });
    } catch {
      // Best effort: the entry used last is a convenience.
    }
  }

  /** See `ProviderStore.save`. @param input what the renderer sent @returns the saved entry */
  save(input: SaveProvider): ProviderView {
    if (this.fromEnvironment) throw new InvalidOperationError(FROM_ENVIRONMENT);
    const parsed = SaveProviderSchema.safeParse(input);
    if (!parsed.success) throw new InvalidOperationError(INVALID_SETTINGS);
    const request = parsed.data;
    const current = this.load();
    const previous = previousEntry(current, request);
    const kind = previous?.kind ?? request.kind ?? 'ollama';
    const name = checkedName(request.name);
    const baseUrl = checkedBaseUrl(request.baseUrl, kind);
    const options = checkedOptions(request, previous, kind);
    checkRoom(current, request.id, name, previous);
    const encrypted = this.encryptedKey(request.apiKey, baseUrl);
    const entry = entryOf(request, previous, { kind, name, baseUrl, options });
    const providers =
      previous === null ? [...current.providers, entry] : current.providers.map((provider) => (provider.id === entry.id ? entry : provider));
    // The settings go first, so a failed write loses no key. A key is bound to the origin it was entered for, so an
    // old key left behind by a failed removal is never sent to a new origin.
    this.commit({ ...current, providers });
    // The entry changed once it is written, so listeners hear of it even if a key file operation fails.
    try {
      if (previous === null || request.apiKey === null || originOf(previous.baseUrl) !== originOf(baseUrl)) this.keys.remove(entry.id);
      if (encrypted !== null) this.keys.write(entry.id, encrypted);
    } finally {
      this.notify(entry.id);
    }
    return this.view(entry);
  }

  /**
   * Encrypts a key that is sent with a save, before anything is written, so a refused key leaves the entry unchanged
   * too. The key is stored together with the origin it is entered for.
   *
   * @param apiKey the key sent, null to remove it, absent to keep it
   * @param baseUrl the entry's base URL after the rule
   * @returns the key file's content, or null when no key is sent
   * @throws CredentialStoreUnavailableError when a key is sent and the credential store is not usable
   */
  private encryptedKey(apiKey: string | null | undefined, baseUrl: string): Buffer | null {
    if (typeof apiKey !== 'string') return null;
    if (!this.keys.available()) throw new CredentialStoreUnavailableError();
    return this.keys.encrypt(originOf(baseUrl)!, apiKey);
  }

  /** See `ProviderStore.delete`. @param id the entry's id */
  delete(id: string): void {
    if (this.fromEnvironment) throw new InvalidOperationError(FROM_ENVIRONMENT);
    const current = this.load();
    if (!current.providers.some((provider) => provider.id === id)) throw new NotFoundError(PROVIDER_NOT_FOUND);
    // The entry goes first, so a failure half-way leaves an orphaned key file, which the next start deletes.
    this.commit({
      ...current,
      providers: current.providers.filter((provider) => provider.id !== id),
      lastUsed: {
        vision: current.lastUsed.vision === id ? null : current.lastUsed.vision,
        image: current.lastUsed.image === id ? null : current.lastUsed.image,
      },
    });
    try {
      this.keys.remove(id);
    } finally {
      this.notify(id);
    }
  }

  /** See `ProviderStore.apiKeyFor`. @param id the entry's id @param baseUrl the request's URL @returns the key, or null */
  apiKeyFor(id: string, baseUrl: string): string | null {
    if (this.fromEnvironment || id === ENVIRONMENT_PROVIDER_ID) return null;
    const entry = this.get(id);
    if (entry === null) return null;
    const origin = originOf(baseUrl);
    if (origin === null || originOf(entry.baseUrl) !== origin) return null;
    return this.decryptKey(entry);
  }

  /** See `ProviderStore.onChange`. @param listener hears the id of the changed entry */
  onChange(listener: (id: string) => void): void {
    this.listeners.push(listener);
  }
}

/** The checked fields of a save that `entryOf` puts into the entry. */
interface CheckedFields {
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  options: ProviderOptions | null;
}

/**
 * The stored entry a save changes.
 *
 * @param current the settings
 * @param request the parsed save
 * @returns the entry, or null for a new one
 * @throws NotFoundError for an unknown id, InvalidOperationError when another kind is sent
 */
function previousEntry(current: StoredSettings, request: SaveProvider): ProviderEntry | null {
  const { id } = request;
  const previous = id === undefined ? null : (current.providers.find((provider) => provider.id === id) ?? null);
  if (id !== undefined && previous === null) throw new NotFoundError(PROVIDER_NOT_FOUND);
  if (previous !== null && request.kind !== undefined && request.kind !== previous.kind) {
    throw new InvalidOperationError(KIND_CHANGED);
  }
  return previous;
}

/**
 * The name of a save after the name rule.
 *
 * @param rawName the name sent
 * @returns the name
 * @throws ValidationFailedError when it breaks the rule
 */
function checkedName(rawName: string): string {
  const name = ProviderNameSchema.safeParse(rawName);
  if (!name.success) throw new ValidationFailedError(INVALID_NAME);
  return name.data;
}

/**
 * The base URL of a save after the base URL rule and, for an image entry, the secure rule.
 *
 * @param rawBaseUrl the URL sent
 * @param kind the entry's kind
 * @returns the URL without trailing slashes
 * @throws InvalidOperationError for an unusable URL, ValidationFailedError for an image URL that is not secure
 */
function checkedBaseUrl(rawBaseUrl: string, kind: ProviderKind): string {
  const baseUrl = usableBaseUrl(rawBaseUrl.trim());
  if (baseUrl === null) throw new InvalidOperationError(INVALID_BASE_URL);
  if (!isVisionKind(kind) && !secureForImages(baseUrl)) throw new ValidationFailedError(IMAGE_URL_NOT_SECURE);
  return baseUrl;
}

/**
 * The options of a save. A vision entry keeps its stored options when none are sent and a new one starts with the
 * defaults; an image entry has none, whatever was sent.
 *
 * @param request the parsed save
 * @param previous the stored entry, or null
 * @param kind the entry's kind
 * @returns the options to store
 * @throws ValidationFailedError when the extra parameters break their rule
 */
function checkedOptions(request: SaveProvider, previous: ProviderEntry | null, kind: ProviderKind): ProviderOptions | null {
  const vision = isVisionKind(kind);
  const options = vision ? (request.options ?? previous?.options ?? optionsFor(kind)) : null;
  if (vision && options !== null) {
    const extra = parseExtraParameters(options.extra, kind);
    if (!extra.ok) throw new ValidationFailedError(extraParametersMessage(extra));
  }
  return options;
}

/**
 * Refuses a name another entry has and a new entry over the limit.
 *
 * @param current the settings
 * @param id the id sent, if any
 * @param name the checked name
 * @param previous the stored entry, or null for a new one
 * @throws InvalidOperationError for a repeated name or one entry too many
 */
function checkRoom(current: StoredSettings, id: string | undefined, name: string, previous: ProviderEntry | null): void {
  const others = current.providers.filter((provider) => provider.id !== id);
  const key = name.toLowerCase();
  if (others.some((provider) => provider.name.toLowerCase() === key)) throw new InvalidOperationError(DUPLICATE_NAME);
  if (previous === null && current.providers.length >= MAX_PROVIDERS) throw new InvalidOperationError(TOO_MANY);
}

/**
 * The entry a save stores. An image entry keeps no vision models, a vision entry no edit model. An absent edit model
 * keeps the stored one.
 *
 * @param request the parsed save
 * @param previous the stored entry, or null
 * @param fields the checked kind, name, base URL and options
 * @returns the entry
 */
function entryOf(request: SaveProvider, previous: ProviderEntry | null, fields: CheckedFields): ProviderEntry {
  const vision = isVisionKind(fields.kind);
  const editModel = request.editModel === undefined ? (previous?.editModel ?? null) : request.editModel;
  return {
    id: previous?.id ?? randomUUID(),
    kind: fields.kind,
    name: fields.name,
    baseUrl: fields.baseUrl,
    timeoutSeconds: request.timeoutSeconds,
    taggingModel: vision ? request.taggingModel : null,
    promptModel: vision ? request.promptModel : null,
    editModel: vision ? null : editModel,
    options: fields.options,
  };
}

/**
 * The read-only entry of environment mode.
 *
 * @param env the process environment
 * @returns the entry; none when the environment URL is not usable
 */
function environmentEntryOf(env: NodeJS.ProcessEnv): ProviderEntry | null {
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
