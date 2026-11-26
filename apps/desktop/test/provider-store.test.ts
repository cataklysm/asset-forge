import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SaveProvider } from '@assetforge/contracts';
import { AssetForgeError } from '@assetforge/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderStore, UNUSABLE_ENV_BASE_URL } from '../src/main/provider-store.js';
import { FakeCodec } from './fake-codec.js';

const KEY = 'test-key-not-real';
const OTHER_KEY = 'test-key-not-real-2';
const UNKNOWN = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';
const PREPARED = '11111111-2222-4333-8444-555555555555';

let dir: string;
let codec: FakeCodec;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-provider-store-'));
  codec = new FakeCodec();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const settingsFile = () => join(dir, 'provider-settings.json');
const credentials = () => join(dir, 'credentials');
const legacyKeyFile = () => join(credentials(), 'vision-api-key');
const keyFile = (id: string) => join(credentials(), `vision-api-key-${id}`);
const store = (env: NodeJS.ProcessEnv = {}) => createProviderStore({ userData: dir, secrets: codec, env });
const readSettings = () => JSON.parse(readFileSync(settingsFile(), 'utf8'));

function input(overrides: Partial<SaveProvider> = {}): SaveProvider {
  return {
    name: 'Local',
    baseUrl: 'http://192.168.1.20:11434',
    timeoutSeconds: 120,
    taggingModel: 'tagger',
    promptModel: 'writer',
    ...overrides,
  };
}

function errorOf(fn: () => unknown): { code: string; message: string } | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof AssetForgeError) return { code: error.code, message: error.message };
    throw error;
  }
  return undefined;
}
const codeOf = (fn: () => unknown) => errorOf(fn)?.code;

/** Every file under `root`, recursively, with its raw bytes. */
function allFiles(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) for (const [p, b] of allFiles(path)) out.set(p, b);
    else out.set(path, readFileSync(path));
  }
  return out;
}

function writeV1(vision: { baseUrl: string | null; timeoutSeconds?: number; taggingModel?: string | null; promptModel?: string | null }) {
  writeFileSync(
    settingsFile(),
    JSON.stringify({ version: 1, vision: { timeoutSeconds: 300, taggingModel: 'tagger', promptModel: null, ...vision } }),
  );
}

function writeLegacyKey(key = KEY) {
  mkdirSync(credentials(), { recursive: true });
  writeFileSync(legacyKeyFile(), codec.encrypt(key));
}

function writeV2(o: { baseUrl: string; marker: { id: string; origin: string } | null }) {
  writeFileSync(
    settingsFile(),
    JSON.stringify({
      version: 2,
      providers: [{ id: PREPARED, name: 'Ollama', baseUrl: o.baseUrl, timeoutSeconds: 120, taggingModel: null, promptModel: null }],
      lastUsedId: null,
      adoptLegacyKey: o.marker,
    }),
  );
}

describe('provider store: upgrade and start', () => {
  it('is empty without a file and writes nothing', () => {
    expect(store().list()).toEqual({ providers: [], lastUsedId: null, lastUsedImageId: null, fromEnvironment: false, canStoreKey: true });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('upgrades a version 1 file with a URL and a key to one entry Ollama that owns the key', () => {
    writeV1({ baseUrl: 'http://192.168.1.20:11434' });
    writeLegacyKey();
    const s = store();
    const { providers } = s.list();
    expect(providers).toEqual([
      {
        id: expect.any(String),
        kind: 'ollama',
        name: 'Ollama',
        baseUrl: 'http://192.168.1.20:11434',
        timeoutSeconds: 300,
        taggingModel: 'tagger',
        promptModel: null,
        editModel: null,
        hasApiKey: true,
      },
    ]);
    const id = providers[0]!.id;
    expect(existsSync(legacyKeyFile())).toBe(false);
    expect(readdirSync(credentials())).toEqual([`vision-api-key-${id}`]);
    expect(s.apiKeyFor(id, 'http://192.168.1.20:11434')).toBe(KEY);
    expect(readSettings()).toEqual({
      version: 3,
      providers: [
        {
          id,
          kind: 'ollama',
          name: 'Ollama',
          baseUrl: 'http://192.168.1.20:11434',
          timeoutSeconds: 300,
          taggingModel: 'tagger',
          promptModel: null,
          editModel: null,
        },
      ],
      lastUsed: { vision: null, image: null },
      adoptLegacyKey: null,
    });
    // A second start reads the upgraded file as it is.
    expect(store().list().providers).toEqual(providers);
  });

  it('upgrades a version 1 file with a URL and no key to an entry without a key', () => {
    writeV1({ baseUrl: 'http://192.168.1.20:11434' });
    expect(store().list().providers).toMatchObject([{ name: 'Ollama', hasApiKey: false }]);
  });

  it('upgrades a version 1 file without a URL to an empty list and deletes the legacy key file', () => {
    writeV1({ baseUrl: null });
    writeLegacyKey();
    expect(store().list().providers).toEqual([]);
    expect(existsSync(legacyKeyFile())).toBe(false);
    expect(readSettings()).toEqual({ version: 3, providers: [], lastUsed: { vision: null, image: null }, adoptLegacyKey: null });
  });

  it('adopts the legacy key after a crash between writing version 2 and the rename', () => {
    writeV2({ baseUrl: 'http://192.168.1.20:11434/api', marker: { id: PREPARED, origin: 'http://192.168.1.20:11434' } });
    writeLegacyKey();
    const s = store();
    expect(s.list().providers).toMatchObject([{ id: PREPARED, hasApiKey: true }]);
    expect(s.apiKeyFor(PREPARED, 'http://192.168.1.20:11434')).toBe(KEY);
    expect(readdirSync(credentials())).toEqual([`vision-api-key-${PREPARED}`]);
    expect(readSettings().adoptLegacyKey).toBeNull();
  });

  it('deletes the legacy key when the marked entry no longer has the origin it was entered for', () => {
    writeV2({ baseUrl: 'http://192.168.1.21:11434', marker: { id: PREPARED, origin: 'http://192.168.1.20:11434' } });
    writeLegacyKey();
    const s = store();
    expect(s.list().providers).toMatchObject([{ id: PREPARED, hasApiKey: false }]);
    expect(readdirSync(credentials())).toEqual([]);
    expect(readSettings().adoptLegacyKey).toBeNull();
  });

  it('deletes the legacy key when the marked entry is gone', () => {
    writeV2({ baseUrl: 'http://192.168.1.20:11434', marker: { id: UNKNOWN, origin: 'http://192.168.1.20:11434' } });
    writeLegacyKey();
    expect(store().list().providers).toMatchObject([{ id: PREPARED, hasApiKey: false }]);
    expect(readdirSync(credentials())).toEqual([]);
  });

  it('clears a marker whose legacy key file was already renamed', () => {
    writeV2({ baseUrl: 'http://192.168.1.20:11434', marker: { id: PREPARED, origin: 'http://192.168.1.20:11434' } });
    mkdirSync(credentials());
    writeFileSync(keyFile(PREPARED), codec.encrypt(KEY));
    expect(store().list().providers).toMatchObject([{ id: PREPARED, hasApiKey: true }]);
    expect(readSettings().adoptLegacyKey).toBeNull();
  });

  it('deletes a legacy key file without a marker', () => {
    writeV2({ baseUrl: 'http://192.168.1.20:11434', marker: null });
    writeLegacyKey();
    expect(store().list().providers).toMatchObject([{ id: PREPARED, hasApiKey: false }]);
    expect(existsSync(legacyKeyFile())).toBe(false);
  });

  it('deletes a legacy key file when there is no settings file', () => {
    writeLegacyKey();
    store().list();
    expect(readdirSync(credentials())).toEqual([]);
  });

  it('deletes orphaned key files and temporary key files, and nothing else', () => {
    writeV2({ baseUrl: 'http://192.168.1.20:11434', marker: null });
    mkdirSync(credentials());
    writeFileSync(keyFile(PREPARED), codec.encrypt(KEY));
    writeFileSync(keyFile(UNKNOWN), codec.encrypt(OTHER_KEY));
    writeFileSync(join(credentials(), `vision-api-key-${PREPARED}.22222222-2222-4222-8222-222222222222.tmp`), 'partial');
    writeFileSync(join(credentials(), 'unrelated.tmp'), 'other');
    expect(store().list().providers).toMatchObject([{ id: PREPARED, hasApiKey: true }]);
    expect(readdirSync(credentials()).sort()).toEqual(['unrelated.tmp', `vision-api-key-${PREPARED}`]);
  });

  it.each([
    ['not JSON', 'not json'],
    ['an unknown version', JSON.stringify({ version: 4, providers: [] })],
    ['a version 3 without slots', JSON.stringify({ version: 3, providers: [], adoptLegacyKey: null })],
    [
      'a venice entry with a tagging model',
      JSON.stringify({
        version: 3,
        providers: [
          { id: PREPARED, kind: 'venice', name: 'V', baseUrl: 'https://v.example.test', timeoutSeconds: 120, taggingModel: 'x', promptModel: null, editModel: null },
        ],
        lastUsed: { vision: null, image: null },
        adoptLegacyKey: null,
      }),
    ],
    ['a wrong shape', JSON.stringify({ version: 2, providers: [{ id: 5 }], lastUsedId: null, adoptLegacyKey: null })],
    ['a bad version 1', JSON.stringify({ version: 1, vision: { baseUrl: 'http://u:p@h', timeoutSeconds: 120, taggingModel: null, promptModel: null } })],
  ])('sets a file with %s aside and reads an empty list', (_label, content) => {
    writeFileSync(settingsFile(), content);
    writeLegacyKey();
    expect(store().list().providers).toEqual([]);
    const names = readdirSync(dir);
    expect(names.filter((n) => n.startsWith('provider-settings.json.corrupt-'))).toHaveLength(1);
    expect(names.some((n) => n.includes(':'))).toBe(false);
    expect(existsSync(settingsFile())).toBe(false);
    expect(readdirSync(credentials())).toEqual([]);
  });
});

describe('provider store: save', () => {
  it('creates an entry with a UUID and appends it; an edit keeps its position', () => {
    const s = store();
    const a = s.save(input({ name: 'A' }));
    const b = s.save(input({ name: 'B', baseUrl: 'https://pod.example.test/base/' }));
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b.id).not.toBe(a.id);
    expect(b).toEqual({
      id: b.id,
      kind: 'ollama',
      name: 'B',
      baseUrl: 'https://pod.example.test/base',
      timeoutSeconds: 120,
      taggingModel: 'tagger',
      promptModel: 'writer',
      editModel: null,
      hasApiKey: false,
    });
    const edited = s.save(input({ id: a.id, name: 'A2', timeoutSeconds: 60 }));
    expect(edited).toMatchObject({ id: a.id, name: 'A2', timeoutSeconds: 60 });
    expect(s.list().providers.map((p) => p.name)).toEqual(['A2', 'B']);
    expect(store().list().providers.map((p) => p.name)).toEqual(['A2', 'B']);
    expect(s.first()?.id).toBe(a.id);
    expect(s.get(b.id)?.name).toBe('B');
    expect(s.get(UNKNOWN)).toBeNull();
  });

  it('trims the name', () => {
    expect(store().save(input({ name: '  Pod  ' })).name).toBe('Pod');
  });

  it.each([
    ['blank', '  '],
    ['61 characters', 'n'.repeat(61)],
  ])('refuses a %s name with validation_failed and writes nothing', (_label, name) => {
    const s = store();
    expect(errorOf(() => s.save(input({ name })))).toEqual({
      code: 'validation_failed',
      message: 'The provider name must have 1 to 60 characters',
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a duplicate name regardless of case; the same name on the entry itself is fine', () => {
    const s = store();
    const a = s.save(input({ name: 'RunPod' }));
    expect(errorOf(() => s.save(input({ name: 'runpod' })))).toEqual({
      code: 'invalid_operation',
      message: 'A provider with this name already exists',
    });
    expect(s.save(input({ id: a.id, name: 'RUNPOD' })).name).toBe('RUNPOD');
    const b = s.save(input({ name: 'Other' }));
    expect(codeOf(() => s.save(input({ id: b.id, name: ' runpod ' })))).toBe('invalid_operation');
  });

  it('refuses an 11th entry; an edit at the limit is fine', () => {
    const s = store();
    for (let i = 0; i < 10; i++) s.save(input({ name: `P${i}` }));
    expect(errorOf(() => s.save(input({ name: 'P10' })))).toEqual({ code: 'invalid_operation', message: 'No more than 10 providers' });
    const first = s.first()!;
    expect(s.save(input({ id: first.id, name: 'Renamed' })).name).toBe('Renamed');
    expect(s.list().providers).toHaveLength(10);
  });

  it('answers not_found for an unknown id and for the environment id outside environment mode', () => {
    const s = store();
    expect(errorOf(() => s.save(input({ id: UNKNOWN })))).toEqual({ code: 'not_found', message: 'This provider does not exist' });
    expect(codeOf(() => s.save(input({ id: 'environment' })))).toBe('not_found');
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    ['user info', 'http://user:pw@host:11434'],
    ['a query', 'http://host:11434/?a=1'],
    ['a fragment', 'http://host:11434/#x'],
    ['ftp', 'ftp://host/'],
    ['no URL', 'not a url'],
    ['a blank URL', '   '],
  ])('refuses a base URL with %s and writes nothing', (_label, baseUrl) => {
    const s = store();
    expect(errorOf(() => s.save(input({ baseUrl, apiKey: KEY })))).toEqual({
      code: 'invalid_operation',
      message: 'The base URL must be an http or https URL without user info, query or fragment',
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses values outside the contract and writes nothing', () => {
    const s = store();
    expect(codeOf(() => s.save(input({ timeoutSeconds: 5 })))).toBe('invalid_operation');
    expect(codeOf(() => s.save(input({ apiKey: '' })))).toBe('invalid_operation');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('calls every listener even when an earlier one throws', () => {
    const s = store();
    const ids: string[] = [];
    s.onChange(() => {
      throw new Error('listener failed');
    });
    s.onChange((id) => ids.push(id));
    const a = s.save(input());
    s.delete(a.id);
    expect(ids).toEqual([a.id, a.id]);
  });

  it('tells listeners when the key write fails after the settings were written', () => {
    const s = store();
    const a = s.save(input());
    // A non-empty directory where the key file belongs makes the final rename fail.
    mkdirSync(keyFile(a.id), { recursive: true });
    writeFileSync(join(keyFile(a.id), 'blocker'), 'x');
    let calls = 0;
    s.onChange(() => calls++);
    expect(() => s.save(input({ id: a.id, timeoutSeconds: 200, apiKey: KEY }))).toThrow();
    expect(calls).toBe(1);
    expect(s.get(a.id)?.timeoutSeconds).toBe(200);
    expect(readdirSync(credentials()).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('never touches the registry settings.json', () => {
    const registry = join(dir, 'settings.json');
    writeFileSync(registry, 'registry content');
    const before = statSync(registry).mtimeMs;
    const s = store();
    const a = s.save(input({ apiKey: KEY }));
    s.save(input({ id: a.id, baseUrl: 'http://other:1', apiKey: null }));
    s.markUsed(a.id);
    s.list();
    s.delete(a.id);
    store().list();
    expect(readFileSync(registry, 'utf8')).toBe('registry content');
    expect(statSync(registry).mtimeMs).toBe(before);
  });

  it('tells listeners the id after a save and a delete, not after a refusal', () => {
    const s = store();
    const ids: string[] = [];
    s.onChange((id) => ids.push(id));
    const a = s.save(input());
    expect(codeOf(() => s.save(input({ name: '' })))).toBe('validation_failed');
    s.delete(a.id);
    expect(ids).toEqual([a.id, a.id]);
  });
});

describe('provider store: keys', () => {
  it('keeps the key when the default port is spelled out', () => {
    const s = store();
    const a = s.save(input({ baseUrl: 'https://ollama.example.test', apiKey: KEY }));
    expect(s.save(input({ id: a.id, baseUrl: 'https://ollama.example.test:443/' })).hasApiKey).toBe(true);
    expect(s.apiKeyFor(a.id, 'https://ollama.example.test:443/')).toBe(KEY);
  });

  it.each([
    ['host case', 'http://Ollama.Example.test:11434', 'http://ollama.example.TEST:11434/x', true],
    ['an IPv6 literal', 'http://[::1]:11434', 'http://[0:0:0:0:0:0:0:1]:11434/api', true],
    ['an explicit default port', 'http://ollama.example.test', 'http://ollama.example.test:80', true],
    ['a trailing dot', 'http://ollama.example.test:11434', 'http://ollama.example.test.:11434', false],
  ])('normalises the origin for %s', (_label, first, second, kept) => {
    const s = store();
    const a = s.save(input({ baseUrl: first, apiKey: KEY }));
    expect(s.save(input({ id: a.id, baseUrl: second })).hasApiKey).toBe(kept);
    expect(s.apiKeyFor(a.id, second)).toBe(kept ? KEY : null);
    expect(existsSync(keyFile(a.id))).toBe(kept);
  });
  it('keeps the key when apiKey is absent, deletes it on null, replaces it on a string', () => {
    const s = store();
    const a = s.save(input({ apiKey: KEY }));
    expect(a.hasApiKey).toBe(true);
    expect(s.save(input({ id: a.id, timeoutSeconds: 200 })).hasApiKey).toBe(true);
    expect(s.apiKeyFor(a.id, a.baseUrl)).toBe(KEY);
    s.save(input({ id: a.id, apiKey: OTHER_KEY }));
    expect(s.apiKeyFor(a.id, a.baseUrl)).toBe(OTHER_KEY);
    expect(s.save(input({ id: a.id, apiKey: null })).hasApiKey).toBe(false);
    expect(s.apiKeyFor(a.id, a.baseUrl)).toBeNull();
    expect(existsSync(keyFile(a.id))).toBe(false);
  });

  it('keeps one key per entry', () => {
    const s = store();
    const a = s.save(input({ name: 'A', apiKey: KEY }));
    const b = s.save(input({ name: 'B', baseUrl: 'http://192.168.1.30:11434', apiKey: OTHER_KEY }));
    expect(s.apiKeyFor(a.id, a.baseUrl)).toBe(KEY);
    expect(s.apiKeyFor(b.id, b.baseUrl)).toBe(OTHER_KEY);
    expect(readdirSync(credentials()).sort()).toEqual([`vision-api-key-${a.id}`, `vision-api-key-${b.id}`].sort());
  });

  it('keeps the key on a rename and a path change within the origin', () => {
    const s = store();
    const a = s.save(input({ apiKey: KEY }));
    expect(s.save(input({ id: a.id, name: 'Renamed' })).hasApiKey).toBe(true);
    expect(s.save(input({ id: a.id, name: 'Renamed', baseUrl: 'http://192.168.1.20:11434/ollama' })).hasApiKey).toBe(true);
    expect(s.apiKeyFor(a.id, 'http://192.168.1.20:11434')).toBe(KEY);
  });

  it.each([
    ['the port', 'http://192.168.1.20:11435'],
    ['the host', 'http://192.168.1.21:11434'],
    ['the scheme', 'https://192.168.1.20:11434'],
  ])('deletes the key when %s changes', (_label, baseUrl) => {
    const s = store();
    const a = s.save(input({ apiKey: KEY }));
    expect(s.save(input({ id: a.id, baseUrl })).hasApiKey).toBe(false);
    expect(existsSync(keyFile(a.id))).toBe(false);
    expect(s.apiKeyFor(a.id, baseUrl)).toBeNull();
  });

  it('stores the new key when the origin changes with a new key', () => {
    const s = store();
    const a = s.save(input({ apiKey: KEY }));
    expect(s.save(input({ id: a.id, baseUrl: 'http://192.168.1.21:11434', apiKey: OTHER_KEY })).hasApiKey).toBe(true);
    expect(s.apiKeyFor(a.id, 'http://192.168.1.21:11434')).toBe(OTHER_KEY);
    expect(s.apiKeyFor(a.id, 'http://192.168.1.20:11434')).toBeNull();
  });

  it('answers apiKeyFor only for the entry and its origin in force', () => {
    const s = store();
    const a = s.save(input({ name: 'A', apiKey: KEY }));
    const b = s.save(input({ name: 'B', baseUrl: 'http://192.168.1.30:11434', apiKey: OTHER_KEY }));
    expect(s.apiKeyFor(a.id, 'http://192.168.1.20:11434/other')).toBe(KEY);
    expect(s.apiKeyFor(a.id, b.baseUrl)).toBeNull();
    expect(s.apiKeyFor(b.id, a.baseUrl)).toBeNull();
    expect(s.apiKeyFor(a.id, 'not a url')).toBeNull();
    expect(s.apiKeyFor(UNKNOWN, a.baseUrl)).toBeNull();
    // After an origin change the old address no longer gets a key, even with a new key stored.
    s.save(input({ id: a.id, name: 'A', baseUrl: 'http://192.168.1.40:11434', apiKey: KEY }));
    expect(s.apiKeyFor(a.id, 'http://192.168.1.20:11434')).toBeNull();
  });

  it('deletes the key file with the entry; a new entry for the old URL has no key', () => {
    const s = store();
    const a = s.save(input({ apiKey: KEY }));
    s.delete(a.id);
    expect(existsSync(keyFile(a.id))).toBe(false);
    expect(s.apiKeyFor(a.id, a.baseUrl)).toBeNull();
    const again = s.save(input());
    expect(again.id).not.toBe(a.id);
    expect(again.hasApiKey).toBe(false);
    expect(s.apiKeyFor(again.id, again.baseUrl)).toBeNull();
    expect(codeOf(() => s.delete(a.id))).toBe('not_found');
  });

  it('refuses a key without a credential store and saves nothing', () => {
    codec.canEncrypt = false;
    const s = store();
    expect(s.list().canStoreKey).toBe(false);
    expect(codeOf(() => s.save(input({ apiKey: KEY })))).toBe('credential_store_unavailable');
    expect(codec.encryptCalls).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    expect(s.list().providers).toEqual([]);
    // Without a key the entry is saved.
    expect(s.save(input()).hasApiKey).toBe(false);
  });

  it('never writes the key literal into any file', () => {
    const s = store();
    const a = s.save(input({ name: 'A', apiKey: KEY }));
    s.save(input({ name: 'B', baseUrl: 'http://192.168.1.30:11434', apiKey: OTHER_KEY }));
    s.markUsed(a.id);
    expect(readFileSync(settingsFile(), 'utf8')).not.toContain('test-key-not-real');
    for (const bytes of allFiles(dir).values()) {
      expect(bytes.includes(Buffer.from(KEY))).toBe(false);
      expect(bytes.includes(Buffer.from(OTHER_KEY))).toBe(false);
    }
    expect(JSON.stringify(s.list())).not.toContain('test-key-not-real');
  });

  it('counts an undecryptable key file and an unavailable credential store as no key', () => {
    const s = store();
    const a = s.save(input({ apiKey: KEY }));
    writeFileSync(keyFile(a.id), 'garbage');
    expect(store().list().providers[0]!.hasApiKey).toBe(false);
    s.save(input({ id: a.id, apiKey: KEY }));
    codec.canEncrypt = false;
    expect(store().list().providers[0]!.hasApiKey).toBe(false);
    expect(store().apiKeyFor(a.id, a.baseUrl)).toBeNull();
  });
});

describe('provider store: used last', () => {
  it('resolves the entry used last, else the first, else null', () => {
    const s = store();
    expect(s.resolve(undefined)).toBeNull();
    const a = s.save(input({ name: 'A' }));
    const b = s.save(input({ name: 'B' }));
    expect(s.resolve(undefined)?.id).toBe(a.id);
    s.markUsed(b.id);
    expect(s.list().lastUsedId).toBe(b.id);
    expect(s.resolve(undefined)?.id).toBe(b.id);
    expect(store().resolve(undefined)?.id).toBe(b.id);
    s.delete(b.id);
    expect(s.list().lastUsedId).toBeNull();
    expect(s.resolve(undefined)?.id).toBe(a.id);
    s.delete(a.id);
    expect(s.resolve(undefined)).toBeNull();
  });

  it('resolves a given id or answers not_found', () => {
    const s = store();
    const a = s.save(input());
    expect(s.resolve(a.id)?.id).toBe(a.id);
    expect(errorOf(() => s.resolve(UNKNOWN))).toEqual({ code: 'not_found', message: 'This provider does not exist' });
  });

  it('ignores an unknown id in markUsed', () => {
    const s = store();
    s.save(input());
    s.markUsed(UNKNOWN);
    expect(s.list().lastUsedId).toBeNull();
  });

  it('swallows a failing write in markUsed', () => {
    const s = store();
    const a = s.save(input());
    // A non-empty directory where the settings file belongs makes the rename fail.
    rmSync(settingsFile());
    mkdirSync(settingsFile());
    writeFileSync(join(settingsFile(), 'blocker'), 'x');
    expect(() => s.markUsed(a.id)).not.toThrow();
    expect(s.list().lastUsedId).toBeNull();
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('provider store: environment', () => {
  const env = { ASSETFORGE_VISION_BASE_URL: 'http://127.0.0.1:11500/', ASSETFORGE_VISION_MODEL: 'env-model' };

  it('lists one read-only entry and leaves the stored files byte-identical', () => {
    const stored = store().save(input({ apiKey: KEY }));
    writeLegacyKey();
    writeFileSync(keyFile(UNKNOWN), codec.encrypt(OTHER_KEY));
    const before = allFiles(dir);
    const s = store(env);
    expect(s.list()).toEqual({
      providers: [
        {
          id: 'environment',
          kind: 'ollama',
          name: 'Environment',
          baseUrl: 'http://127.0.0.1:11500',
          timeoutSeconds: 120,
          taggingModel: 'env-model',
          promptModel: 'env-model',
          editModel: null,
          hasApiKey: false,
        },
      ],
      lastUsedId: null,
      lastUsedImageId: null,
      fromEnvironment: true,
      canStoreKey: true,
    });
    expect(s.get(stored.id)).toBeNull();
    expect(s.resolve(undefined)?.id).toBe('environment');
    s.markUsed('environment');
    expect(s.list().lastUsedId).toBe('environment');
    expect(errorOf(() => s.save(input()))).toEqual({
      code: 'invalid_operation',
      message: 'The provider settings are set by the environment and cannot be changed',
    });
    expect(codeOf(() => s.save(input({ id: 'environment' })))).toBe('invalid_operation');
    expect(codeOf(() => s.delete('environment'))).toBe('invalid_operation');
    expect(codeOf(() => s.delete(stored.id))).toBe('invalid_operation');
    expect(s.apiKeyFor('environment', 'http://127.0.0.1:11500')).toBeNull();
    expect(s.apiKeyFor(stored.id, stored.baseUrl)).toBeNull();
    const after = allFiles(dir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, bytes] of before) expect(after.get(path)!.equals(bytes), path).toBe(true);
  });

  it('has no models without ASSETFORGE_VISION_MODEL', () => {
    expect(store({ ASSETFORGE_VISION_BASE_URL: 'http://127.0.0.1:11500' }).first()).toMatchObject({
      taggingModel: null,
      promptModel: null,
    });
  });

  it('lists no entry for an unusable environment URL and warns once, without the value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = store({ ASSETFORGE_VISION_BASE_URL: 'http://u:secret-part@127.0.0.1:11500' });
      expect(s.list()).toMatchObject({ providers: [], fromEnvironment: true });
      s.resolve(undefined);
      s.first();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]).toEqual([UNUSABLE_ENV_BASE_URL]);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-part|127\.0\.0\.1|u:/);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn about a usable environment URL or without one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      store(env).list();
      store().list();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

const venice = (overrides: Partial<SaveProvider> = {}): SaveProvider =>
  input({ kind: 'venice', name: 'Venice', baseUrl: 'https://api.venice.ai/api/v1', editModel: 'edit-a', ...overrides });

describe('provider store: version 3', () => {
  const SECOND = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  function writeV2WithTwo() {
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        version: 2,
        providers: [
          { id: PREPARED, name: 'One', baseUrl: 'http://192.168.1.20:11434', timeoutSeconds: 120, taggingModel: 'tagger', promptModel: null },
          { id: SECOND, name: 'Two', baseUrl: 'http://192.168.1.30:11434', timeoutSeconds: 90, taggingModel: null, promptModel: 'writer' },
        ],
        lastUsedId: SECOND,
        adoptLegacyKey: null,
      }),
    );
    mkdirSync(credentials(), { recursive: true });
    writeFileSync(keyFile(PREPARED), codec.encrypt(KEY));
    writeFileSync(keyFile(SECOND), codec.encrypt(OTHER_KEY));
  }

  it('upgrades version 2 in memory, keeping ids, keys and the vision entry used last', () => {
    writeV2WithTwo();
    const before = readFileSync(settingsFile(), 'utf8');
    const s = store();
    const list = s.list();
    expect(list.providers).toEqual([
      expect.objectContaining({ id: PREPARED, kind: 'ollama', editModel: null, taggingModel: 'tagger', hasApiKey: true }),
      expect.objectContaining({ id: SECOND, kind: 'ollama', editModel: null, promptModel: 'writer', hasApiKey: true }),
    ]);
    expect(list.lastUsedId).toBe(SECOND);
    expect(list.lastUsedImageId).toBeNull();
    expect(s.apiKeyFor(PREPARED, 'http://192.168.1.20:11434')).toBe(KEY);
    expect(s.apiKeyFor(SECOND, 'http://192.168.1.30:11434')).toBe(OTHER_KEY);
    // Reading alone writes nothing; a crash now leaves version 2, which reads the same on the next start.
    expect(readFileSync(settingsFile(), 'utf8')).toBe(before);
    expect(store().list()).toEqual(list);
  });

  it('writes version 3 atomically on the first write', () => {
    writeV2WithTwo();
    const s = store();
    s.markUsed(PREPARED);
    expect(readSettings()).toEqual({
      version: 3,
      providers: [
        { id: PREPARED, kind: 'ollama', name: 'One', baseUrl: 'http://192.168.1.20:11434', timeoutSeconds: 120, taggingModel: 'tagger', promptModel: null, editModel: null },
        { id: SECOND, kind: 'ollama', name: 'Two', baseUrl: 'http://192.168.1.30:11434', timeoutSeconds: 90, taggingModel: null, promptModel: 'writer', editModel: null },
      ],
      lastUsed: { vision: PREPARED, image: null },
      adoptLegacyKey: null,
    });
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(store().list().providers.map((p) => [p.id, p.hasApiKey])).toEqual([
      [PREPARED, true],
      [SECOND, true],
    ]);
  });
});

describe('provider store: kinds', () => {
  it('creates an ollama entry without a kind and a venice entry with one', () => {
    const s = store();
    const o = s.save(input({ editModel: 'ignored' }));
    expect(o).toMatchObject({ kind: 'ollama', taggingModel: 'tagger', promptModel: 'writer', editModel: null });
    const v = s.save(venice());
    expect(v).toEqual({
      id: expect.any(String),
      kind: 'venice',
      name: 'Venice',
      baseUrl: 'https://api.venice.ai/api/v1',
      timeoutSeconds: 120,
      taggingModel: null,
      promptModel: null,
      editModel: 'edit-a',
      hasApiKey: false,
    });
    expect(readSettings().providers[1]).toMatchObject({ kind: 'venice', taggingModel: null, promptModel: null, editModel: 'edit-a' });
    expect(store().get(v.id)).toMatchObject({ kind: 'venice', editModel: 'edit-a' });
  });

  it('keeps the edit model when it is absent on an edit and clears it on null', () => {
    const s = store();
    const v = s.save(venice());
    const { editModel: _omit, ...withoutEdit } = venice({ id: v.id, name: 'Renamed' });
    expect(s.save(withoutEdit).editModel).toBe('edit-a');
    expect(s.save(venice({ id: v.id, editModel: null })).editModel).toBeNull();
  });

  it('refuses a changed kind; the same kind or none is fine', () => {
    const s = store();
    const o = s.save(input());
    const v = s.save(venice());
    expect(errorOf(() => s.save(input({ id: o.id, kind: 'venice' })))).toEqual({
      code: 'invalid_operation',
      message: 'The kind of a provider cannot be changed',
    });
    expect(errorOf(() => s.save(venice({ id: v.id, kind: 'ollama' })))?.message).toBe('The kind of a provider cannot be changed');
    expect(s.save(input({ id: o.id, kind: 'ollama', name: 'Same' })).kind).toBe('ollama');
    const { kind: _omit, ...noKind } = venice({ id: v.id, name: 'Still venice' });
    expect(s.save(noKind)).toMatchObject({ kind: 'venice', taggingModel: null });
  });

  it.each([
    ['http on 127.0.0.1', 'http://127.0.0.1:11500/api/v1', 'http://127.0.0.1:11500/api/v1'],
    ['http on 127.8.9.10', 'http://127.8.9.10/api/v1', 'http://127.8.9.10/api/v1'],
    ['http on localhost', 'http://localhost:8080/api/v1', 'http://localhost:8080/api/v1'],
    ['http on ::1', 'http://[::1]:8080/api/v1', 'http://[::1]:8080/api/v1'],
    ['https anywhere', 'https://api.venice.ai/api/v1/', 'https://api.venice.ai/api/v1'],
  ])('accepts a venice URL with %s', (_label, baseUrl, stored) => {
    expect(store().save(venice({ baseUrl })).baseUrl).toBe(stored);
  });

  it.each([
    ['http elsewhere', 'http://example.com'],
    ['http on a LAN address', 'http://192.168.1.20:11500/api/v1'],
    ['http on a name ending in localhost', 'http://evil-localhost.example/api'],
    ['http on a localhost subdomain', 'http://a.localhost/api'],
  ])('refuses a venice URL with %s and writes nothing', (_label, baseUrl) => {
    const s = store();
    expect(errorOf(() => s.save(venice({ baseUrl, apiKey: KEY })))).toEqual({
      code: 'validation_failed',
      message: 'An image provider needs an https URL, or http on a loopback address',
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('allows plain http for an ollama entry anywhere', () => {
    expect(store().save(input({ baseUrl: 'http://example.com' })).baseUrl).toBe('http://example.com');
  });

  it('counts both kinds against the limit of 10', () => {
    const s = store();
    for (let i = 0; i < 5; i++) s.save(input({ name: `O${i}` }));
    for (let i = 0; i < 5; i++) s.save(venice({ name: `V${i}` }));
    expect(codeOf(() => s.save(venice({ name: 'V5' })))).toBe('invalid_operation');
    expect(codeOf(() => s.save(input({ name: 'O5' })))).toBe('invalid_operation');
  });

  it('drops the key of a venice entry whose URL moves to another origin', () => {
    const s = store();
    const v = s.save(venice({ apiKey: KEY }));
    expect(s.apiKeyFor(v.id, 'https://api.venice.ai/api/v1')).toBe(KEY);
    expect(s.save(venice({ id: v.id, baseUrl: 'https://other.example.test/api/v1' })).hasApiKey).toBe(false);
    expect(s.apiKeyFor(v.id, 'https://api.venice.ai/api/v1')).toBeNull();
    expect(existsSync(keyFile(v.id))).toBe(false);
  });
});

describe('provider store: resolve by kind', () => {
  it('resolves the image entry used last, else the first venice entry, else null', () => {
    const s = store();
    const o = s.save(input({ name: 'O' }));
    expect(s.resolve(undefined, 'venice')).toBeNull();
    expect(s.first('venice')).toBeNull();
    const v1 = s.save(venice({ name: 'V1' }));
    const v2 = s.save(venice({ name: 'V2' }));
    expect(s.first()?.id).toBe(o.id);
    expect(s.first('ollama')?.id).toBe(o.id);
    expect(s.first('venice')?.id).toBe(v1.id);
    expect(s.resolve(undefined)?.id).toBe(o.id);
    expect(s.resolve(undefined, 'venice')?.id).toBe(v1.id);
    s.markUsed(v2.id);
    expect(s.list()).toMatchObject({ lastUsedId: null, lastUsedImageId: v2.id });
    expect(s.resolve(undefined, 'venice')?.id).toBe(v2.id);
    expect(s.resolve(undefined)?.id).toBe(o.id);
    expect(store().resolve(undefined, 'venice')?.id).toBe(v2.id);
    s.markUsed(o.id);
    expect(s.list()).toMatchObject({ lastUsedId: o.id, lastUsedImageId: v2.id });
    expect(readSettings().lastUsed).toEqual({ vision: o.id, image: v2.id });
    s.delete(v2.id);
    expect(s.list()).toMatchObject({ lastUsedId: o.id, lastUsedImageId: null });
    expect(s.resolve(undefined, 'venice')?.id).toBe(v1.id);
  });

  it('skips an entry of the other kind as the first one', () => {
    const s = store();
    const v = s.save(venice());
    expect(s.first()).toBeNull();
    expect(s.resolve(undefined)).toBeNull();
    expect(s.first('venice')?.id).toBe(v.id);
  });

  it('resolves a given id of the right kind and refuses one of the wrong kind', () => {
    const s = store();
    const o = s.save(input());
    const v = s.save(venice());
    expect(s.resolve(v.id, 'venice')?.id).toBe(v.id);
    expect(s.resolve(o.id)?.id).toBe(o.id);
    expect(errorOf(() => s.resolve(o.id, 'venice'))).toEqual({ code: 'invalid_operation', message: 'This provider cannot generate images' });
    expect(errorOf(() => s.resolve(v.id))).toEqual({ code: 'invalid_operation', message: 'This provider cannot analyse images' });
    expect(errorOf(() => s.resolve(UNKNOWN, 'venice'))).toEqual({ code: 'not_found', message: 'This provider does not exist' });
  });

  it('lists only the environment entry in environment mode, with no image entry used last', () => {
    store().save(venice());
    const s = store({ ASSETFORGE_VISION_BASE_URL: 'http://127.0.0.1:11500' });
    expect(s.list()).toMatchObject({ providers: [{ id: 'environment', kind: 'ollama' }], lastUsedImageId: null });
    expect(s.list().providers).toHaveLength(1);
    expect(s.resolve(undefined, 'venice')).toBeNull();
    expect(s.first('venice')).toBeNull();
    s.markUsed('environment');
    expect(s.list()).toMatchObject({ lastUsedId: 'environment', lastUsedImageId: null });
  });
});
