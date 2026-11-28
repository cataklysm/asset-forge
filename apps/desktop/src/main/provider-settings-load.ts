import { randomUUID } from 'node:crypto';
import { originOf, optionsFor, type ProviderEntry } from './provider-entry.js';
import type { ProviderKeyFiles } from './provider-keys.js';
import {
  corruptCopies,
  EMPTY_SETTINGS,
  readStoredSettings,
  writeStoredSettings,
  type StoredSettings,
  type VersionOneVision,
} from './provider-settings-file.js';

// The first load of the provider settings in an app start: the upgrade of older versions, the adoption of the
// version 1 key file, the binding of bare keys and the sweep of key files that belong to no entry.
//
// No key file is deleted while no settings file exists or a `.corrupt-*` copy lies beside it, on this start and every
// later one: a key of an entry that was left out stays until the copy is removed.

/** The name of the entry a version 1 file is upgraded into. */
const UPGRADED_NAME = 'Ollama';

/**
 * Reads the settings file, upgrades it and puts the key files in order.
 *
 * @param settingsPath the settings file
 * @param keys the key files of the entries
 * @returns the settings to keep in memory
 * @throws whatever reading or writing the settings file throws
 */
export function loadProviderSettings(settingsPath: string, keys: ProviderKeyFiles): StoredSettings {
  const read = readStoredSettings(settingsPath);
  // No settings file (a fresh install, or one set aside) or a damaged copy beside it: the list may lack entries
  // whose keys are still wanted, so no key file is deleted.
  const keepKeys =
    read.kind === 'none' || (read.kind === 'stored' && read.degraded) || corruptCopies(settingsPath).length > 0;
  let stored: StoredSettings;
  if (read.kind === 'v1') stored = upgradeVersionOne(settingsPath, keys, read.vision, keepKeys);
  else if (read.kind === 'stored') stored = adoptLegacyKey(settingsPath, keys, read.stored, keepKeys);
  else stored = EMPTY_SETTINGS;
  keys.bindBareKeys(stored.providers);
  if (!keepKeys) keys.sweep(stored.providers);
  return stored;
}

/**
 * Moves the legacy key to the entry's key file, but only while the entry still has the origin it was entered for.
 * On a degraded load nothing is deleted and the settings file is not rewritten: a legacy key whose entry was left
 * out stays with its marker.
 *
 * @param settingsPath the settings file
 * @param keys the key files of the entries
 * @param stored the settings that were read
 * @param degraded whether something was left out; then nothing is deleted or written
 * @returns the settings without the marker, or unchanged on a degraded load that keeps the legacy key
 */
function adoptLegacyKey(settingsPath: string, keys: ProviderKeyFiles, stored: StoredSettings, degraded: boolean): StoredSettings {
  const marker = stored.adoptLegacyKey;
  if (marker === null) return stored;
  const entry = stored.providers.find((provider) => provider.id === marker.id);
  if (keys.hasLegacyKey()) {
    if (entry !== undefined && originOf(entry.baseUrl) === marker.origin) keys.moveLegacyKey(entry.id, marker.origin);
    else if (degraded) return stored;
    else keys.removeLegacyKey();
  }
  const next = { ...stored, adoptLegacyKey: null };
  // A degraded file stays as it is until the next save; the next start finds the key moved and clears the marker.
  if (!degraded) writeStoredSettings(settingsPath, next);
  return next;
}

/**
 * Version 1 → 4. Every step is written before the next one, so a crash in between resumes on the next start.
 * With `keepKeys` no key file is deleted.
 *
 * @param settingsPath the settings file
 * @param keys the key files of the entries
 * @param vision the single provider of the version 1 file
 * @param keepKeys whether no key file may be deleted
 * @returns the upgraded settings
 */
function upgradeVersionOne(settingsPath: string, keys: ProviderKeyFiles, vision: VersionOneVision, keepKeys: boolean): StoredSettings {
  if (vision.baseUrl === null) {
    writeStoredSettings(settingsPath, EMPTY_SETTINGS);
    if (!keepKeys) keys.removeLegacyKey();
    return EMPTY_SETTINGS;
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
  const marked: StoredSettings = { ...EMPTY_SETTINGS, providers: [entry], adoptLegacyKey: { id, origin: originOf(entry.baseUrl)! } };
  writeStoredSettings(settingsPath, marked);
  return adoptLegacyKey(settingsPath, keys, marked, keepKeys);
}
