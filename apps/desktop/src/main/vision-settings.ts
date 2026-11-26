import { readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  ModelNameSchema,
  SetVisionSettingsSchema,
  VISION_TIMEOUT_DEFAULT_SECONDS,
  VISION_TIMEOUT_MAX_SECONDS,
  VISION_TIMEOUT_MIN_SECONDS,
  type SetVisionSettings,
  type VisionSettingsView,
} from '@assetforge/contracts';
import { CredentialStoreUnavailableError, InvalidOperationError } from '@assetforge/core';
import { writeAtomic } from './atomic-file.js';
import type { SecretCodec } from './secret-codec.js';
import { usableBaseUrl } from './vision-config.js';

// App-level vision provider settings in `userData/provider-settings.json` and the API key, encrypted
// by the OS credential store, in `userData/credentials/vision-api-key`. Kept free of Electron imports.
// The key is decrypted only when `apiKey()` (or the `hasApiKey` check) asks for it and is never cached.

export const PROVIDER_SETTINGS_FILE = 'provider-settings.json';
const KEY_FILE = join('credentials', 'vision-api-key');

const ENV_BASE_URL = 'ASSETFORGE_VISION_BASE_URL';
const ENV_MODEL = 'ASSETFORGE_VISION_MODEL';

const INVALID_SETTINGS = 'The provider settings are not valid';
const INVALID_BASE_URL = 'The base URL must be an http or https URL without user info, query or fragment';
export const UNUSABLE_ENV_BASE_URL = `${ENV_BASE_URL} is not a usable http(s) URL; the vision provider is not configured`;
const FROM_ENVIRONMENT = 'The provider settings are set by the environment and cannot be changed';

interface StoredVision {
  baseUrl: string | null;
  timeoutSeconds: number;
  taggingModel: string | null;
  promptModel: string | null;
}

const StoredFileSchema = z.object({
  version: z.literal(1),
  vision: z.object({
    baseUrl: z
      .string()
      .nullable()
      .refine((url) => url === null || usableBaseUrl(url) === url),
    timeoutSeconds: z.number().int().min(VISION_TIMEOUT_MIN_SECONDS).max(VISION_TIMEOUT_MAX_SECONDS),
    taggingModel: ModelNameSchema.nullable(),
    promptModel: ModelNameSchema.nullable(),
  }),
});

const EMPTY: StoredVision = {
  baseUrl: null,
  timeoutSeconds: VISION_TIMEOUT_DEFAULT_SECONDS,
  taggingModel: null,
  promptModel: null,
};

export interface VisionSettingsStore {
  view(): VisionSettingsView;
  save(input: SetVisionSettings): VisionSettingsView;
  /** The base URL in force; null when the provider is not configured. */
  baseUrl(): string | null;
  timeoutMs(): number;
  /** Decrypts the stored key for one request; null when there is none or the environment is in force. */
  apiKey(): string | null;
  /**
   * The key for a request to `baseUrl`: null unless the base URL in force has the same origin.
   * An adapter built for an earlier origin can therefore never receive a key entered for a later one.
   */
  apiKeyFor(baseUrl: string): string | null;
  defaults(): { taggingModel: string | null; promptModel: string | null };
  /** Called after every successful save. */
  onChange(listener: () => void): void;
}

export function createVisionSettingsStore(o: {
  userData: string;
  secrets: SecretCodec;
  env: NodeJS.ProcessEnv;
}): VisionSettingsStore {
  const settingsPath = join(o.userData, PROVIDER_SETTINGS_FILE);
  const keyPath = join(o.userData, KEY_FILE);
  const listeners: (() => void)[] = [];
  const fromEnvironment = o.env[ENV_BASE_URL] !== undefined;
  // Once per store, i.e. per app start; the value itself is never logged.
  if (fromEnvironment && usableBaseUrl(o.env[ENV_BASE_URL] ?? '') === null) console.warn(UNUSABLE_ENV_BASE_URL);
  let stored: StoredVision | null = null;

  /** The environment replaces the stored settings entirely; an unusable URL means "not configured". */
  const environment = (): StoredVision => {
    const model = o.env[ENV_MODEL]?.trim();
    const usableModel = model !== undefined && ModelNameSchema.safeParse(model).success ? model : null;
    return {
      baseUrl: usableBaseUrl(o.env[ENV_BASE_URL] ?? ''),
      timeoutSeconds: VISION_TIMEOUT_DEFAULT_SECONDS,
      taggingModel: usableModel,
      promptModel: usableModel,
    };
  };

  const load = (): StoredVision => {
    if (stored === null) {
      sweepKeyTemps(keyPath);
      stored = readStored(settingsPath);
    }
    return stored;
  };

  const current = (): StoredVision => (fromEnvironment ? environment() : load());

  /** The stored key, decrypted; any failure to read or decrypt counts as no key. */
  const decryptKey = (): string | null => {
    if (fromEnvironment || !o.secrets.available()) return null;
    let data: Buffer;
    try {
      data = readFileSync(keyPath);
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

  const view = (): VisionSettingsView => ({
    ...current(),
    hasApiKey: decryptKey() !== null,
    fromEnvironment,
    canStoreKey: o.secrets.available(),
  });

  return {
    view,
    save(input) {
      if (fromEnvironment) throw new InvalidOperationError(FROM_ENVIRONMENT);
      const parsed = SetVisionSettingsSchema.safeParse(input);
      if (!parsed.success) throw new InvalidOperationError(INVALID_SETTINGS);
      const { apiKey, ...rest } = parsed.data;
      let baseUrl: string | null = null;
      if (rest.baseUrl !== null && rest.baseUrl.trim() !== '') {
        baseUrl = usableBaseUrl(rest.baseUrl.trim());
        if (baseUrl === null) throw new InvalidOperationError(INVALID_BASE_URL);
      }
      // Encrypt before anything is written, so a refused key leaves URL and models unchanged too.
      let encrypted: Buffer | null = null;
      if (typeof apiKey === 'string') {
        if (!o.secrets.available()) throw new CredentialStoreUnavailableError();
        encrypted = o.secrets.encrypt(apiKey);
      }
      const next: StoredVision = { ...rest, baseUrl };
      const previous = load();

      // The key is bound to the origin it was entered for. The old key goes first, so a failure
      // half-way leaves no key rather than a key bound to the wrong origin.
      if (apiKey === null || originOf(previous.baseUrl) !== originOf(next.baseUrl)) {
        rmSync(keyPath, { force: true });
        sweepKeyTemps(keyPath);
      }
      writeAtomic(settingsPath, `${JSON.stringify({ version: 1, vision: next }, null, 2)}\n`);
      stored = next;
      // The settings changed once they are written, so listeners hear of it even if the key write fails.
      try {
        if (encrypted !== null) writeAtomic(keyPath, encrypted);
      } finally {
        for (const listener of listeners) listener();
      }
      return view();
    },
    baseUrl: () => current().baseUrl,
    timeoutMs: () => current().timeoutSeconds * 1000,
    apiKey: decryptKey,
    apiKeyFor(baseUrl) {
      const inForce = current().baseUrl;
      if (inForce === null || originOf(inForce) !== originOf(baseUrl)) return null;
      return decryptKey();
    },
    defaults: () => {
      const { taggingModel, promptModel } = current();
      return { taggingModel, promptModel };
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
}

/** Removes temporary key files a crash between write and rename left behind. */
function sweepKeyTemps(keyPath: string): void {
  const dir = dirname(keyPath);
  const prefix = `${keyPath.slice(dir.length + 1)}.`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith('.tmp')) rmSync(join(dir, name), { force: true });
  }
}

function originOf(baseUrl: string | null): string | null {
  return baseUrl === null ? null : new URL(baseUrl).origin;
}

function readStored(path: string): StoredVision {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const result = StoredFileSchema.safeParse(json);
  if (result.success) return result.data.vision;
  // Same pattern as the workspace registry: keep the unreadable file aside, start empty.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  renameSync(path, `${path}.corrupt-${stamp}`);
  return { ...EMPTY };
}
