import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeAtomic } from './atomic-file.js';
import { originOf, type ProviderEntry } from './provider-entry.js';
import type { SecretCodec } from './secret-codec.js';

// One API key per provider entry, encrypted by the OS credential store, in `userData/credentials/vision-api-key-<id>`
// (the name predates the kinds and is kept for every kind). A key is decrypted only when asked for and is never cached.
//
// A key file holds the encrypted key payload (see `encodeKeyPayload`): the key together with the origin it was
// entered for, so a hand-edited settings file cannot redirect a stored key to another origin. A file written before
// the payload existed holds the bare key; it is bound to the entry's origin when the settings are loaded.

const CREDENTIALS_DIR = 'credentials';
/** The single key file of version 1; adopted by the upgrade, deleted otherwise. */
const LEGACY_KEY_NAME = 'vision-api-key';
const KEY_PREFIX = `${LEGACY_KEY_NAME}-`;

/**
 * Starts every key payload. A bare key is any text a user typed into a text field; the NUL characters make the marker
 * one that a typed key does not start with, and the test is a plain prefix test: with the marker the text is a
 * payload, without it a bare key.
 */
const KEY_PAYLOAD_MARKER = '\u0000assetforge-key\u0000';
const KeyPayloadSchema = z.object({ v: z.literal(1), origin: z.string().min(1), key: z.string().min(1) });

/**
 * The text that is encrypted into a key file: the marker, then `{ v: 1, origin, key }` as JSON.
 *
 * @param origin the origin the key was entered for
 * @param key the API key
 * @returns the payload to encrypt
 */
export function encodeKeyPayload(origin: string, key: string): string {
  return `${KEY_PAYLOAD_MARKER}${JSON.stringify({ v: 1, origin, key })}`;
}

/** A decrypted key file: bound to an origin, a bare key of an older file, or no key. */
type DecodedKey = { form: 'bound'; origin: string; key: string } | { form: 'bare'; key: string } | null;

/**
 * Reads a decrypted key file. A payload that carries the marker but cannot be read is no key; it is never taken for a
 * bare key.
 *
 * @param text the decrypted content
 * @returns the key with its form, or null
 */
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

/** The key files of the provider entries in `userData/credentials`. */
export class ProviderKeyFiles {
  private readonly credentialsDirectory: string;
  private readonly legacyKeyPath: string;
  /**
   * Entries whose key file still holds a bare key because binding it at load failed, with the origin the entry had
   * then. Such a key is used for this app session while the entry keeps that origin.
   */
  private readonly unboundOrigins = new Map<string, string>();

  /**
   * @param userData the app's `userData` directory
   * @param secrets the OS credential store
   */
  constructor(
    userData: string,
    private readonly secrets: SecretCodec,
  ) {
    this.credentialsDirectory = join(userData, CREDENTIALS_DIR);
    this.legacyKeyPath = join(this.credentialsDirectory, LEGACY_KEY_NAME);
  }

  /**
   * Whether keys can be stored and read.
   *
   * @returns true while the credential store is usable
   */
  available(): boolean {
    return this.secrets.available();
  }

  /**
   * The key file of one entry.
   *
   * @param id the entry's id
   * @returns the file's path
   */
  private keyPath(id: string): string {
    return join(this.credentialsDirectory, `${KEY_PREFIX}${id}`);
  }

  /**
   * Whether the key file of version 1 still exists.
   *
   * @returns true when it lies in the credentials directory
   */
  hasLegacyKey(): boolean {
    return existsSync(this.legacyKeyPath);
  }

  /** Deletes the key file of version 1, if there is one. */
  removeLegacyKey(): void {
    rmSync(this.legacyKeyPath, { force: true });
  }

  /**
   * Writes the legacy key, bound to `origin`, as the entry's key file and removes the legacy file. When the key cannot
   * be read or written in the new form, the file is renamed as it is; the load then binds it like any bare key file.
   *
   * @param id the entry that adopts the key
   * @param origin the origin the key was entered for
   */
  moveLegacyKey(id: string, origin: string): void {
    try {
      if (!this.secrets.available()) throw new Error('no credential store');
      const decoded = decodeKeyPayload(this.secrets.decrypt(readFileSync(this.legacyKeyPath)));
      if (decoded?.form !== 'bare') throw new Error('not a bare key');
      writeAtomic(this.keyPath(id), this.secrets.encrypt(encodeKeyPayload(origin, decoded.key)));
    } catch {
      renameSync(this.legacyKeyPath, this.keyPath(id));
      return;
    }
    rmSync(this.legacyKeyPath, { force: true });
  }

  /**
   * Rewrites every bare key file of a listed entry as a payload bound to the entry's current origin, before any
   * request can read it. A failed rewrite keeps the old file; its key stays usable for this session.
   *
   * @param providers the entries that were loaded
   */
  bindBareKeys(providers: ProviderEntry[]): void {
    if (!this.secrets.available()) return;
    for (const entry of providers) this.bindBareKey(entry);
  }

  /**
   * Rewrites the key file of one entry when it holds a bare key.
   *
   * @param entry the entry whose key file is bound
   */
  private bindBareKey(entry: ProviderEntry): void {
    let decoded: DecodedKey;
    try {
      decoded = decodeKeyPayload(this.secrets.decrypt(readFileSync(this.keyPath(entry.id))));
    } catch {
      return;
    }
    const origin = originOf(entry.baseUrl);
    if (decoded?.form !== 'bare' || origin === null) return;
    try {
      writeAtomic(this.keyPath(entry.id), this.secrets.encrypt(encodeKeyPayload(origin, decoded.key)));
    } catch {
      this.unboundOrigins.set(entry.id, origin);
    }
  }

  /**
   * Leaves only the key files of listed entries: no temporary file, no legacy file, no orphan.
   *
   * @param providers the entries whose key files stay
   */
  sweep(providers: ProviderEntry[]): void {
    let names: string[];
    try {
      names = readdirSync(this.credentialsDirectory);
    } catch {
      return;
    }
    const ids = new Set(providers.map((provider) => provider.id));
    for (const name of names) {
      if (!name.startsWith(LEGACY_KEY_NAME)) continue;
      const path = join(this.credentialsDirectory, name);
      if (name.endsWith('.tmp')) rmSync(path, { force: true });
      else if (name === LEGACY_KEY_NAME) rmSync(path, { force: true });
      else if (name.startsWith(KEY_PREFIX) && !ids.has(name.slice(KEY_PREFIX.length))) rmSync(path, { force: true });
    }
  }

  /**
   * The stored key of an entry, decrypted, and only when it was stored for the entry's origin; any failure to read or
   * decrypt counts as no key. A key stored for another origin is left alone: saving a key replaces it. The caller has
   * checked that the credential store is usable.
   *
   * @param entry the entry whose key is read
   * @returns the key, or null
   */
  decrypt(entry: ProviderEntry): string | null {
    let data: Buffer;
    try {
      data = readFileSync(this.keyPath(entry.id));
    } catch {
      return null;
    }
    let decoded: DecodedKey;
    try {
      decoded = decodeKeyPayload(this.secrets.decrypt(data));
    } catch {
      return null;
    }
    if (decoded === null) return null;
    const origin = originOf(entry.baseUrl);
    if (origin === null) return null;
    if (decoded.form === 'bound') return decoded.origin === origin ? decoded.key : null;
    // A bare key is used only when its binding at load failed, and only while the entry keeps the origin of then.
    return this.unboundOrigins.get(entry.id) === origin ? decoded.key : null;
  }

  /**
   * Encrypts a key bound to the origin it is entered for. The caller has checked that the credential store is usable.
   *
   * @param origin the origin of the entry's base URL
   * @param key the API key
   * @returns the content of the key file
   */
  encrypt(origin: string, key: string): Buffer {
    return this.secrets.encrypt(encodeKeyPayload(origin, key));
  }

  /**
   * Writes an encrypted key as the entry's key file.
   *
   * @param id the entry's id
   * @param encrypted what `encrypt` answered
   */
  write(id: string, encrypted: Buffer): void {
    writeAtomic(this.keyPath(id), encrypted);
  }

  /**
   * Deletes the entry's key file and forgets an unbound key of it.
   *
   * @param id the entry's id
   */
  remove(id: string): void {
    this.unboundOrigins.delete(id);
    rmSync(this.keyPath(id), { force: true });
  }
}
