import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SaveProvider } from '@assetforge/contracts';
import { DEFAULT_PROVIDER_OPTIONS } from '@assetforge/contracts';
import { AssetForgeError } from '@assetforge/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeKeyPayload } from '../src/main/provider-keys.js';
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

function writeV1(vision: {
  baseUrl: string | null;
  timeoutSeconds?: number;
  taggingModel?: string | null;
  promptModel?: string | null;
}) {
  writeFileSync(
    settingsFile(),
    JSON.stringify({
      version: 1,
      vision: { timeoutSeconds: 300, taggingModel: 'tagger', promptModel: null, ...vision },
    }),
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
      providers: [
        {
          id: PREPARED,
          name: 'Ollama',
          baseUrl: o.baseUrl,
          timeoutSeconds: 120,
          taggingModel: null,
          promptModel: null,
        },
      ],
      lastUsedId: null,
      adoptLegacyKey: o.marker,
    }),
  );
}

describe('provider store: upgrade and start', () => {
  it('is empty without a file and writes nothing', () => {
    expect(store().list()).toEqual({
      providers: [],
      lastUsedId: null,
      lastUsedImageId: null,
      fromEnvironment: false,
      canStoreKey: true,
    });
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
        options: DEFAULT_PROVIDER_OPTIONS,
      },
    ]);
    const id = providers[0]!.id;
    expect(existsSync(legacyKeyFile())).toBe(false);
    expect(readdirSync(credentials())).toEqual([`vision-api-key-${id}`]);
    expect(codec.decrypt(readFileSync(keyFile(id)))).toBe(encodeKeyPayload('http://192.168.1.20:11434', KEY));
    expect(s.apiKeyFor(id, 'http://192.168.1.20:11434')).toBe(KEY);
    expect(readSettings()).toEqual({
      version: 4,
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
          options: DEFAULT_PROVIDER_OPTIONS,
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
    expect(readSettings()).toEqual({
      version: 4,
      providers: [],
      lastUsed: { vision: null, image: null },
      adoptLegacyKey: null,
    });
  });

  it('adopts the legacy key after a crash between writing version 2 and the rename', () => {
    writeV2({
      baseUrl: 'http://192.168.1.20:11434/api',
      marker: { id: PREPARED, origin: 'http://192.168.1.20:11434' },
    });
    writeLegacyKey();
    const s = store();
    expect(s.list().providers).toMatchObject([{ id: PREPARED, hasApiKey: true }]);
    expect(s.apiKeyFor(PREPARED, 'http://192.168.1.20:11434')).toBe(KEY);
    expect(readdirSync(credentials())).toEqual([`vision-api-key-${PREPARED}`]);
    expect(codec.decrypt(readFileSync(keyFile(PREPARED)))).toBe(encodeKeyPayload('http://192.168.1.20:11434', KEY));
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

  it('keeps a legacy key file when there is no settings file', () => {
    writeLegacyKey();
    store().list();
    expect(readdirSync(credentials())).toEqual(['vision-api-key']);
  });

  it('deletes orphaned key files and temporary key files, and nothing else', () => {
    writeV2({ baseUrl: 'http://192.168.1.20:11434', marker: null });
    mkdirSync(credentials());
    writeFileSync(keyFile(PREPARED), codec.encrypt(KEY));
    writeFileSync(keyFile(UNKNOWN), codec.encrypt(OTHER_KEY));
    writeFileSync(
      join(credentials(), `vision-api-key-${PREPARED}.22222222-2222-4222-8222-222222222222.tmp`),
      'partial',
    );
    writeFileSync(join(credentials(), 'unrelated.tmp'), 'other');
    expect(store().list().providers).toMatchObject([{ id: PREPARED, hasApiKey: true }]);
    expect(readdirSync(credentials()).sort()).toEqual(['unrelated.tmp', `vision-api-key-${PREPARED}`]);
  });

  it.each([
    ['not JSON', 'not json'],
    ['a JSON array', '[1]'],
    ['no version', JSON.stringify({ providers: [] })],
    [
      'an unknown version',
      JSON.stringify({ version: 5, providers: [], lastUsed: { vision: null, image: null }, adoptLegacyKey: null }),
    ],
    [
      'a provider list that is not a list',
      JSON.stringify({ version: 4, providers: {}, lastUsed: { vision: null, image: null }, adoptLegacyKey: null }),
    ],
    [
      'a bad version 1',
      JSON.stringify({
        version: 1,
        vision: { baseUrl: 'http://u:p@h', timeoutSeconds: 120, taggingModel: null, promptModel: null },
      }),
    ],
  ])('sets a file with %s aside, reads an empty list and keeps every key file', (_label, content) => {
    writeFileSync(settingsFile(), content);
    writeLegacyKey();
    writeFileSync(keyFile(PREPARED), codec.encrypt(KEY));
    writeFileSync(
      join(credentials(), `vision-api-key-${PREPARED}.22222222-2222-4222-8222-222222222222.tmp`),
      'partial',
    );
    const before = allFiles(credentials());
    const s = store();
    expect(s.list().providers).toEqual([]);
    const names = readdirSync(dir);
    const copies = names.filter((n) => n.startsWith('provider-settings.json.corrupt-'));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(dir, copies[0]!), 'utf8')).toBe(content);
    expect(names.some((n) => n.includes(':'))).toBe(false);
    expect(existsSync(settingsFile())).toBe(false);
    // Not swept for the rest of the session, not even after a save.
    s.save(input());
    const after = allFiles(credentials());
    for (const [path, bytes] of before) expect(after.get(path)?.equals(bytes), path).toBe(true);
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
      options: DEFAULT_PROVIDER_OPTIONS,
    });
    const edited = s.save(input({ id: a.id, name: 'A2', timeoutSeconds: 60 }));
    expect(edited).toMatchObject({ id: a.id, name: 'A2', timeoutSeconds: 60 });
    expect(s.list().providers.map((p) => p.name)).toEqual(['A2', 'B']);
    expect(
      store()
        .list()
        .providers.map((p) => p.name),
    ).toEqual(['A2', 'B']);
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
    expect(errorOf(() => s.save(input({ name: 'P10' })))).toEqual({
      code: 'invalid_operation',
      message: 'No more than 10 providers',
    });
    const first = s.first()!;
    expect(s.save(input({ id: first.id, name: 'Renamed' })).name).toBe('Renamed');
    expect(s.list().providers).toHaveLength(10);
  });

  it('answers not_found for an unknown id and for the environment id outside environment mode', () => {
    const s = store();
    expect(errorOf(() => s.save(input({ id: UNKNOWN })))).toEqual({
      code: 'not_found',
      message: 'This provider does not exist',
    });
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
    ['a trailing dot', 'http://ollama.example.test:11434', 'http://ollama.example.test.:11434', true],
    ['a trailing dot removed', 'http://ollama.example.test.:11434', 'http://ollama.example.test:11434', true],
  ])('normalises the origin for %s', (_label, first, second, kept) => {
    const s = store();
    const a = s.save(input({ baseUrl: first, apiKey: KEY }));
    expect(s.save(input({ id: a.id, baseUrl: second })).hasApiKey).toBe(kept);
    expect(s.apiKeyFor(a.id, second)).toBe(kept ? KEY : null);
    expect(existsSync(keyFile(a.id))).toBe(kept);
  });

  it('sends a key kept across a trailing dot only to the origin stored now', () => {
    const s = store();
    const a = s.save(input({ baseUrl: 'http://ollama.example.test:11434', apiKey: KEY }));
    s.save(input({ id: a.id, baseUrl: 'http://ollama.example.test.:11434' }));
    expect(s.apiKeyFor(a.id, 'http://ollama.example.test.:11434/api')).toBe(KEY);
    expect(s.apiKeyFor(a.id, 'http://ollama.example.test:11434/api')).toBeNull();
    expect(s.apiKeyFor(a.id, 'http://other.example.test.:11434/api')).toBeNull();
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
    expect(s.save(input({ id: a.id, name: 'Renamed', baseUrl: 'http://192.168.1.20:11434/ollama' })).hasApiKey).toBe(
      true,
    );
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
          options: DEFAULT_PROVIDER_OPTIONS,
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
          {
            id: PREPARED,
            name: 'One',
            baseUrl: 'http://192.168.1.20:11434',
            timeoutSeconds: 120,
            taggingModel: 'tagger',
            promptModel: null,
          },
          {
            id: SECOND,
            name: 'Two',
            baseUrl: 'http://192.168.1.30:11434',
            timeoutSeconds: 90,
            taggingModel: null,
            promptModel: 'writer',
          },
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
      expect.objectContaining({
        id: PREPARED,
        kind: 'ollama',
        editModel: null,
        taggingModel: 'tagger',
        hasApiKey: true,
      }),
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

  it('writes version 4 atomically on the first write', () => {
    writeV2WithTwo();
    const s = store();
    s.markUsed(PREPARED);
    const options = DEFAULT_PROVIDER_OPTIONS;
    expect(readSettings()).toEqual({
      version: 4,
      providers: [
        {
          id: PREPARED,
          kind: 'ollama',
          name: 'One',
          baseUrl: 'http://192.168.1.20:11434',
          timeoutSeconds: 120,
          taggingModel: 'tagger',
          promptModel: null,
          editModel: null,
          options,
        },
        {
          id: SECOND,
          kind: 'ollama',
          name: 'Two',
          baseUrl: 'http://192.168.1.30:11434',
          timeoutSeconds: 90,
          taggingModel: null,
          promptModel: 'writer',
          editModel: null,
          options,
        },
      ],
      lastUsed: { vision: PREPARED, image: null },
      adoptLegacyKey: null,
    });
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(
      store()
        .list()
        .providers.map((p) => [p.id, p.hasApiKey]),
    ).toEqual([
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
      options: null,
    });
    expect(readSettings().providers[1]).toMatchObject({
      kind: 'venice',
      taggingModel: null,
      promptModel: null,
      editModel: 'edit-a',
    });
    expect(readSettings().providers.map((p: { options: unknown }) => p.options)).toEqual([
      DEFAULT_PROVIDER_OPTIONS,
      null,
    ]);
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
    expect(errorOf(() => s.save(venice({ id: v.id, kind: 'ollama' })))?.message).toBe(
      'The kind of a provider cannot be changed',
    );
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

  it.each([
    ['refuses', 'http://example.com', false],
    ['loads', 'http://127.0.0.1:11500/api/v1', true],
  ])('%s a stored venice entry on %s when reading the file', (_label, baseUrl, loads) => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        version: 3,
        providers: [
          {
            id: PREPARED,
            kind: 'venice',
            name: 'V',
            baseUrl,
            timeoutSeconds: 120,
            taggingModel: null,
            promptModel: null,
            editModel: 'edit-a',
          },
        ],
        lastUsed: { vision: null, image: null },
        adoptLegacyKey: null,
      }),
    );
    mkdirSync(credentials(), { recursive: true });
    writeFileSync(keyFile(PREPARED), codec.encrypt(KEY));
    const s = store();
    expect(existsSync(settingsFile())).toBe(true);
    if (loads) {
      expect(s.list().providers).toMatchObject([{ id: PREPARED, kind: 'venice', baseUrl, hasApiKey: true }]);
    } else {
      expect(s.list().providers).toEqual([]);
      expect(s.apiKeyFor(PREPARED, baseUrl)).toBeNull();
      expect(readdirSync(dir).filter((n) => n.startsWith('provider-settings.json.corrupt-'))).toHaveLength(1);
      expect(existsSync(keyFile(PREPARED))).toBe(true);
    }
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
    expect(s.resolve(undefined, 'image')).toBeNull();
    expect(s.first('image')).toBeNull();
    const v1 = s.save(venice({ name: 'V1' }));
    const v2 = s.save(venice({ name: 'V2' }));
    expect(s.first()?.id).toBe(o.id);
    expect(s.first('vision')?.id).toBe(o.id);
    expect(s.first('image')?.id).toBe(v1.id);
    expect(s.resolve(undefined)?.id).toBe(o.id);
    expect(s.resolve(undefined, 'image')?.id).toBe(v1.id);
    s.markUsed(v2.id);
    expect(s.list()).toMatchObject({ lastUsedId: null, lastUsedImageId: v2.id });
    expect(s.resolve(undefined, 'image')?.id).toBe(v2.id);
    expect(s.resolve(undefined)?.id).toBe(o.id);
    expect(store().resolve(undefined, 'image')?.id).toBe(v2.id);
    s.markUsed(o.id);
    expect(s.list()).toMatchObject({ lastUsedId: o.id, lastUsedImageId: v2.id });
    expect(readSettings().lastUsed).toEqual({ vision: o.id, image: v2.id });
    s.delete(v2.id);
    expect(s.list()).toMatchObject({ lastUsedId: o.id, lastUsedImageId: null });
    expect(s.resolve(undefined, 'image')?.id).toBe(v1.id);
  });

  it('skips an entry of the other kind as the first one', () => {
    const s = store();
    const v = s.save(venice());
    expect(s.first()).toBeNull();
    expect(s.resolve(undefined)).toBeNull();
    expect(s.first('image')?.id).toBe(v.id);
  });

  it('resolves a given id of the right kind and refuses one of the wrong kind', () => {
    const s = store();
    const o = s.save(input());
    const v = s.save(venice());
    expect(s.resolve(v.id, 'image')?.id).toBe(v.id);
    expect(s.resolve(o.id)?.id).toBe(o.id);
    expect(errorOf(() => s.resolve(o.id, 'image'))).toEqual({
      code: 'invalid_operation',
      message: 'This provider cannot generate images',
    });
    expect(errorOf(() => s.resolve(v.id))).toEqual({
      code: 'invalid_operation',
      message: 'This provider cannot analyse images',
    });
    expect(errorOf(() => s.resolve(UNKNOWN, 'image'))).toEqual({
      code: 'not_found',
      message: 'This provider does not exist',
    });
  });

  it('lists only the environment entry in environment mode, with no image entry used last', () => {
    store().save(venice());
    const s = store({ ASSETFORGE_VISION_BASE_URL: 'http://127.0.0.1:11500' });
    expect(s.list()).toMatchObject({ providers: [{ id: 'environment', kind: 'ollama' }], lastUsedImageId: null });
    expect(s.list().providers).toHaveLength(1);
    expect(s.resolve(undefined, 'image')).toBeNull();
    expect(s.first('image')).toBeNull();
    s.markUsed('environment');
    expect(s.list()).toMatchObject({ lastUsedId: 'environment', lastUsedImageId: null });
  });
});

const openai = (overrides: Partial<SaveProvider> = {}): SaveProvider =>
  input({ kind: 'openai', name: 'vLLM', baseUrl: 'http://127.0.0.1:1/v1', ...overrides });

const CUSTOM = {
  temperature: 0.7,
  thinking: 'off',
  maxTokens: 512,
  extra: '{"top_p":0.9}',
  parallelRequests: 4,
} as const;

describe('provider store: version 4 and options', () => {
  const SECOND = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  const v3Entries = [
    {
      id: PREPARED,
      kind: 'ollama',
      name: 'O',
      baseUrl: 'http://192.168.1.20:11434',
      timeoutSeconds: 120,
      taggingModel: 'tagger',
      promptModel: null,
      editModel: null,
    },
    {
      id: SECOND,
      kind: 'venice',
      name: 'V',
      baseUrl: 'https://v.example.test/api/v1',
      timeoutSeconds: 120,
      taggingModel: null,
      promptModel: null,
      editModel: 'edit-a',
    },
  ];
  const writeFile = (version: number, providers: unknown[]) =>
    writeFileSync(
      settingsFile(),
      JSON.stringify({ version, providers, lastUsed: { vision: null, image: null }, adoptLegacyKey: null }),
    );

  it('reads version 3 with default options on ollama and none on venice, and writes version 4 on the first write', () => {
    writeFile(3, v3Entries);
    const before = readFileSync(settingsFile(), 'utf8');
    const s = store();
    const listed = s.list().providers;
    expect(listed.map((p) => p.options)).toEqual([DEFAULT_PROVIDER_OPTIONS, null]);
    expect(readFileSync(settingsFile(), 'utf8')).toBe(before);
    s.markUsed(PREPARED);
    expect(readSettings()).toMatchObject({
      version: 4,
      providers: [
        { ...v3Entries[0], options: DEFAULT_PROVIDER_OPTIONS },
        { ...v3Entries[1], options: null },
      ],
    });
    expect(store().list().providers).toEqual(listed);
  });

  it('creates an openai entry with its options and reads it back', () => {
    const s = store();
    const saved = s.save(openai({ options: CUSTOM }));
    expect(saved).toMatchObject({
      kind: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1',
      taggingModel: 'tagger',
      promptModel: 'writer',
      editModel: null,
      options: CUSTOM,
    });
    expect(readSettings().providers[0]).toMatchObject({ kind: 'openai', options: CUSTOM });
    expect(store().get(saved.id)).toEqual(s.get(saved.id));
    expect(s.save(openai({ name: 'Plain' })).options).toEqual(DEFAULT_PROVIDER_OPTIONS);
  });

  it('gives a new vision entry the defaults and keeps the stored options when they are absent on an edit', () => {
    const s = store();
    const o = s.save(input());
    expect(o.options).toEqual(DEFAULT_PROVIDER_OPTIONS);
    const edited = s.save(input({ id: o.id, options: CUSTOM }));
    expect(edited.options).toEqual(CUSTOM);
    expect(s.save(input({ id: o.id, name: 'Renamed' })).options).toEqual(CUSTOM);
    expect(store().get(o.id)?.options).toEqual(CUSTOM);
  });

  it.each([
    ['[1]', 'The extra parameters are not a JSON object'],
    ['{not json', 'The extra parameters are not a JSON object'],
    ['{"model":"x"}', 'The extra parameters must not set model'],
  ])('refuses the extra parameters %s and writes nothing', (extra, message) => {
    const s = store();
    const o = s.save(input());
    const before = readFileSync(settingsFile(), 'utf8');
    expect(errorOf(() => s.save(input({ id: o.id, options: { ...DEFAULT_PROVIDER_OPTIONS, extra } })))).toEqual({
      code: 'validation_failed',
      message,
    });
    expect(errorOf(() => s.save(openai({ options: { ...DEFAULT_PROVIDER_OPTIONS, extra } })))?.message).toBe(message);
    expect(readFileSync(settingsFile(), 'utf8')).toBe(before);
    expect(s.get(o.id)?.options).toEqual(DEFAULT_PROVIDER_OPTIONS);
  });

  it('refuses response_format for an openai entry and accepts it for an ollama entry', () => {
    const s = store();
    const options = { ...DEFAULT_PROVIDER_OPTIONS, extra: '{"response_format":{}}' };
    expect(errorOf(() => s.save(openai({ options })))).toEqual({
      code: 'validation_failed',
      message: 'The extra parameters must not set response_format',
    });
    expect(s.list().providers).toEqual([]);
    expect(s.save(input({ options })).options).toEqual(options);
  });

  it('stores null options for a venice entry even when options are sent', () => {
    const s = store();
    const v = s.save(venice({ options: CUSTOM }));
    expect(v.options).toBeNull();
    expect(s.save(venice({ id: v.id, options: { ...DEFAULT_PROVIDER_OPTIONS, extra: '[1]' } })).options).toBeNull();
    expect(readSettings().providers[0].options).toBeNull();
  });

  it('refuses a kind change from ollama to openai and the reverse', () => {
    const s = store();
    const o = s.save(input());
    const a = s.save(openai());
    expect(errorOf(() => s.save(openai({ id: o.id })))).toEqual({
      code: 'invalid_operation',
      message: 'The kind of a provider cannot be changed',
    });
    expect(errorOf(() => s.save(input({ id: a.id, kind: 'ollama' })))?.message).toBe(
      'The kind of a provider cannot be changed',
    );
    const { kind: _omit, ...noKind } = openai({ id: a.id, name: 'Still openai' });
    expect(s.save(noKind).kind).toBe('openai');
  });

  it('resolves an openai entry for analysis and refuses it for images', () => {
    const s = store();
    const o = s.save(input({ name: 'O' }));
    const a = s.save(openai());
    expect(s.resolve(undefined)?.id).toBe(o.id);
    s.markUsed(a.id);
    expect(s.list().lastUsedId).toBe(a.id);
    expect(s.resolve(undefined)?.id).toBe(a.id);
    expect(s.resolve(undefined, 'vision')?.id).toBe(a.id);
    expect(store().resolve(undefined)?.id).toBe(a.id);
    expect(s.resolve(a.id)?.id).toBe(a.id);
    expect(s.resolve(undefined, 'image')).toBeNull();
    expect(errorOf(() => s.resolve(a.id, 'image'))).toEqual({
      code: 'invalid_operation',
      message: 'This provider cannot generate images',
    });
    s.delete(o.id);
    expect(s.first()?.id).toBe(a.id);
  });

  it.each([
    ['a vision entry without options', [{ ...v3Entries[0], options: null }]],
    ['a vision entry without the options key', [v3Entries[0]]],
    ['a venice entry with options', [{ ...v3Entries[1], options: DEFAULT_PROVIDER_OPTIONS }]],
    ['options out of bounds', [{ ...v3Entries[0], options: { ...DEFAULT_PROVIDER_OPTIONS, temperature: 3 } }]],
  ])('leaves out a version 4 entry with %s and copies the file', (_label, providers) => {
    writeFile(4, providers);
    expect(store().list().providers).toEqual([]);
    expect(readdirSync(dir).filter((n) => n.startsWith('provider-settings.json.corrupt-'))).toHaveLength(1);
    expect(existsSync(settingsFile())).toBe(true);
  });

  it('reads a version 4 entry without parallel requests as 1 and writes the field on the first write', () => {
    const { parallelRequests: _omit, ...withoutField } = DEFAULT_PROVIDER_OPTIONS;
    writeFile(4, [
      { ...v3Entries[0], options: { ...withoutField, temperature: 0.5 } },
      { ...v3Entries[1], options: null },
    ]);
    const before = readFileSync(settingsFile(), 'utf8');
    const s = store();
    expect(s.list().providers.map((p) => p.options)).toEqual([
      { ...DEFAULT_PROVIDER_OPTIONS, temperature: 0.5, parallelRequests: 1 },
      null,
    ]);
    expect(readFileSync(settingsFile(), 'utf8')).toBe(before);
    s.markUsed(PREPARED);
    expect(readSettings().providers.map((p: { options: unknown }) => p.options)).toEqual([
      { ...DEFAULT_PROVIDER_OPTIONS, temperature: 0.5, parallelRequests: 1 },
      null,
    ]);
  });

  it.each([0, 65, 2.5, -3, '4', null])(
    'reads a stored parallel requests value of %s as 1 and keeps the entry',
    (parallelRequests) => {
      writeFile(4, [
        { ...v3Entries[0], options: { ...DEFAULT_PROVIDER_OPTIONS, parallelRequests } },
        { ...v3Entries[1], options: null },
      ]);
      const s = store();
      expect(s.list().providers.map((p) => p.id)).toEqual([PREPARED, SECOND]);
      expect(s.get(PREPARED)?.options?.parallelRequests).toBe(1);
      expect(readdirSync(dir).filter((n) => n.startsWith('provider-settings.json.corrupt-'))).toEqual([]);
    },
  );

  it('gives the upgrades from versions 1 to 3 one parallel request', () => {
    writeFile(3, v3Entries);
    expect(store().get(PREPARED)?.options?.parallelRequests).toBe(1);
    writeV2({ baseUrl: 'http://192.168.1.20:11434', marker: null });
    expect(store().get(PREPARED)?.options?.parallelRequests).toBe(1);
    writeV1({ baseUrl: 'http://192.168.1.20:11434' });
    expect(store().list().providers[0]?.options?.parallelRequests).toBe(1);
  });

  it('round-trips a parallel requests value through save and list', () => {
    const s = store();
    const o = s.save(openai({ options: { ...DEFAULT_PROVIDER_OPTIONS, parallelRequests: 16 } }));
    expect(o.options?.parallelRequests).toBe(16);
    expect(readSettings().providers[0].options.parallelRequests).toBe(16);
    expect(store().list().providers[0]?.options?.parallelRequests).toBe(16);
    expect(s.save(openai({ id: o.id, name: 'Renamed' })).options?.parallelRequests).toBe(16);
    expect(
      s.save(openai({ id: o.id, options: { ...DEFAULT_PROVIDER_OPTIONS, parallelRequests: 64 } })).options
        ?.parallelRequests,
    ).toBe(64);
  });

  it.each([0, 65, 1.5])('refuses a parallel requests value of %s and writes nothing', (parallelRequests) => {
    const s = store();
    const o = s.save(input());
    const before = readFileSync(settingsFile(), 'utf8');
    expect(codeOf(() => s.save(input({ id: o.id, options: { ...DEFAULT_PROVIDER_OPTIONS, parallelRequests } })))).toBe(
      'invalid_operation',
    );
    expect(readFileSync(settingsFile(), 'utf8')).toBe(before);
    expect(s.get(o.id)?.options?.parallelRequests).toBe(1);
  });

  it.each([
    ['a reserved key', '{"n":2}'],
    ['text that is not JSON', '{not json'],
    ['a JSON array', '[1]'],
  ])('keeps every entry and every key file when stored extra parameters hold %s', (_label, extra) => {
    const refused = { ...v3Entries[0], kind: 'openai', options: { ...DEFAULT_PROVIDER_OPTIONS, extra } };
    writeFile(4, [refused, { ...v3Entries[1], options: null }]);
    mkdirSync(credentials());
    writeFileSync(keyFile(PREPARED), codec.encrypt(KEY));
    writeFileSync(keyFile(SECOND), codec.encrypt(OTHER_KEY));
    const s = store();
    expect(s.list().providers.map((p) => [p.id, p.hasApiKey])).toEqual([
      [PREPARED, true],
      [SECOND, true],
    ]);
    expect(s.get(PREPARED)?.options?.extra).toBe(extra);
    expect(readdirSync(dir).filter((n) => n.startsWith('provider-settings.json.corrupt-'))).toEqual([]);
    expect(readdirSync(credentials()).sort()).toEqual(
      [`vision-api-key-${PREPARED}`, `vision-api-key-${SECOND}`].sort(),
    );
    expect(errorOf(() => s.save(openai({ id: PREPARED, options: { ...DEFAULT_PROVIDER_OPTIONS, extra } })))?.code).toBe(
      'validation_failed',
    );
  });
});

describe('provider store: damaged entries', () => {
  const SECOND = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  const THIRD = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
  const good = {
    id: PREPARED,
    kind: 'ollama',
    name: 'O',
    baseUrl: 'http://192.168.1.20:11434',
    timeoutSeconds: 120,
    taggingModel: 'tagger',
    promptModel: null,
    editModel: null,
    options: DEFAULT_PROVIDER_OPTIONS,
  };
  const image = {
    id: SECOND,
    kind: 'venice',
    name: 'V',
    baseUrl: 'https://v.example.test/api/v1',
    timeoutSeconds: 120,
    taggingModel: null,
    promptModel: null,
    editModel: 'edit-a',
    options: null,
  };
  const brokenVision = { ...good, id: THIRD, name: 'B' };
  const brokenImage = { ...image, id: THIRD, name: 'B' };
  const noSlots = { vision: null, image: null };
  const writeFile = (content: unknown) => {
    const text = JSON.stringify(content);
    writeFileSync(settingsFile(), text);
    return text;
  };
  const writeV4 = (providers: unknown[], lastUsed: unknown = noSlots, adoptLegacyKey: unknown = null) =>
    writeFile({ version: 4, providers, lastUsed, adoptLegacyKey });
  const writeKeys = (...ids: string[]) => {
    mkdirSync(credentials(), { recursive: true });
    for (const id of ids)
      writeFileSync(
        keyFile(id),
        codec.encrypt(encodeKeyPayload(id === SECOND ? 'https://v.example.test' : 'http://192.168.1.20:11434', KEY)),
      );
  };
  const copies = () => readdirSync(dir).filter((n) => n.startsWith('provider-settings.json.corrupt-'));
  const expectCopyOf = (text: string) => {
    expect(copies()).toHaveLength(1);
    expect(readFileSync(join(dir, copies()[0]!), 'utf8')).toBe(text);
    expect(readFileSync(settingsFile(), 'utf8')).toBe(text);
  };

  it.each([
    ['a vision entry with an edit model', { ...brokenVision, editModel: 'x' }],
    ['a venice entry with a tagging model', { ...brokenImage, taggingModel: 'x' }],
    ['a venice entry with a prompt model', { ...brokenImage, promptModel: 'x' }],
    ['a venice entry on plain http elsewhere', { ...brokenImage, baseUrl: 'http://example.com' }],
    ['a vision entry without options', { ...brokenVision, options: null }],
    ['a venice entry with options', { ...brokenImage, options: DEFAULT_PROVIDER_OPTIONS }],
    ['a timeout out of bounds', { ...brokenVision, timeoutSeconds: 5 }],
    ['an unknown kind', { ...brokenVision, kind: 'other' }],
    ['a base URL with user info', { ...brokenVision, baseUrl: 'http://u:p@host' }],
    ['a value that is not an object', 7],
  ])('leaves out %s, keeps the others and every key file, and copies the file', (_label, broken) => {
    const text = writeV4([good, broken, image]);
    writeKeys(PREPARED, SECOND, THIRD);
    const s = store();
    expect(s.list().providers.map((p) => [p.id, p.hasApiKey])).toEqual([
      [PREPARED, true],
      [SECOND, true],
    ]);
    expectCopyOf(text);
    expect(readdirSync(credentials()).sort()).toEqual(
      [PREPARED, SECOND, THIRD].map((id) => `vision-api-key-${id}`).sort(),
    );
  });

  it('keeps every key file for the rest of the session after a degraded load, also after saves', () => {
    writeV4([good, { ...brokenVision, editModel: 'x' }]);
    writeKeys(PREPARED, THIRD, UNKNOWN);
    writeLegacyKey();
    const s = store();
    expect(s.list().providers.map((p) => p.id)).toEqual([PREPARED]);
    s.save(input({ id: PREPARED, name: 'Renamed' }));
    s.save(input({ name: 'New', apiKey: OTHER_KEY }));
    s.markUsed(PREPARED);
    s.list();
    for (const id of [PREPARED, THIRD, UNKNOWN]) expect(existsSync(keyFile(id)), id).toBe(true);
    expect(existsSync(legacyKeyFile())).toBe(true);
    // The save rewrote the file without the broken entry; the copy keeps it.
    expect(readSettings().providers.map((p: { id: string }) => p.id)).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(dir, copies()[0]!), 'utf8')).providers).toHaveLength(2);
  });

  it('reads an empty list when every entry is broken, copies the file and keeps every key file', () => {
    const text = writeV4([
      { ...brokenVision, editModel: 'x' },
      { ...brokenImage, id: PREPARED, taggingModel: 'x' },
    ]);
    writeKeys(PREPARED, THIRD);
    expect(store().list().providers).toEqual([]);
    expectCopyOf(text);
    expect(readdirSync(credentials()).sort()).toEqual([PREPARED, THIRD].map((id) => `vision-api-key-${id}`).sort());
  });

  it('reads the entry used last of a dropped entry as null', () => {
    writeV4(
      [good, { ...brokenVision, editModel: 'x' }, image, { ...brokenImage, id: UNKNOWN, name: 'C', taggingModel: 'x' }],
      {
        vision: THIRD,
        image: UNKNOWN,
      },
    );
    const s = store();
    expect(s.list()).toMatchObject({ lastUsedId: null, lastUsedImageId: null });
    expect(s.resolve(undefined)?.id).toBe(PREPARED);
    expect(s.resolve(undefined, 'image')?.id).toBe(SECOND);
    s.markUsed(SECOND);
    expect(readSettings().lastUsed).toEqual({ vision: null, image: SECOND });
  });

  it('keeps the first ten entries of a longer list', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const text = writeV4(ids.map((id, i) => ({ ...good, id, name: `P${i}` })));
    writeKeys(...ids);
    const s = store();
    expect(s.list().providers.map((p) => p.id)).toEqual(ids.slice(0, 10));
    expectCopyOf(text);
    expect(readdirSync(credentials())).toHaveLength(12);
  });

  it('keeps the first entry of a duplicate id', () => {
    const text = writeV4([good, image, { ...good, name: 'Second O' }]);
    writeKeys(PREPARED, SECOND);
    expect(
      store()
        .list()
        .providers.map((p) => [p.id, p.name]),
    ).toEqual([
      [PREPARED, 'O'],
      [SECOND, 'V'],
    ]);
    expectCopyOf(text);
  });

  it('reads broken slots and a broken marker as null and copies the file', () => {
    const text = writeFile({ version: 3, providers: [{ ...good, options: undefined }], adoptLegacyKey: 'x' });
    writeKeys(PREPARED);
    writeLegacyKey();
    const s = store();
    expect(s.list()).toMatchObject({
      providers: [{ id: PREPARED, hasApiKey: true }],
      lastUsedId: null,
      lastUsedImageId: null,
    });
    expectCopyOf(text);
    expect(existsSync(legacyKeyFile())).toBe(true);
  });

  it('leaves out a broken entry of version 2 and version 3', () => {
    const v2 = writeFile({
      version: 2,
      providers: [
        {
          id: PREPARED,
          name: 'O',
          baseUrl: 'http://192.168.1.20:11434',
          timeoutSeconds: 120,
          taggingModel: null,
          promptModel: null,
        },
        { id: THIRD, name: 'B', baseUrl: 'ftp://x', timeoutSeconds: 120, taggingModel: null, promptModel: null },
      ],
      lastUsedId: THIRD,
      adoptLegacyKey: null,
    });
    writeKeys(PREPARED, THIRD);
    expect(store().list()).toMatchObject({ providers: [{ id: PREPARED, hasApiKey: true }], lastUsedId: null });
    expectCopyOf(v2);
    rmSync(join(dir, copies()[0]!));
    const { options: _a, ...v3Good } = good;
    const { options: _b, ...v3Broken } = brokenVision;
    const v3 = writeFile({
      version: 3,
      providers: [v3Good, { ...v3Broken, editModel: 'x' }],
      lastUsed: noSlots,
      adoptLegacyKey: null,
    });
    expect(
      store()
        .list()
        .providers.map((p) => p.id),
    ).toEqual([PREPARED]);
    expectCopyOf(v3);
    expect(existsSync(keyFile(THIRD))).toBe(true);
  });

  it('keeps the legacy key and the marker while the marked entry was left out', () => {
    writeFile({
      version: 2,
      providers: [
        {
          id: PREPARED,
          name: 'O',
          baseUrl: 'http://192.168.1.20:11434',
          timeoutSeconds: 120,
          taggingModel: null,
          promptModel: null,
        },
        {
          id: THIRD,
          name: 'B',
          baseUrl: 'http://192.168.1.30:11434',
          timeoutSeconds: 5,
          taggingModel: null,
          promptModel: null,
        },
      ],
      lastUsedId: null,
      adoptLegacyKey: { id: THIRD, origin: 'http://192.168.1.30:11434' },
    });
    writeLegacyKey();
    const s = store();
    expect(s.list().providers.map((p) => p.id)).toEqual([PREPARED]);
    expect(existsSync(legacyKeyFile())).toBe(true);
    s.markUsed(PREPARED);
    expect(readSettings().adoptLegacyKey).toEqual({ id: THIRD, origin: 'http://192.168.1.30:11434' });
    expect(existsSync(legacyKeyFile())).toBe(true);
  });

  it('adopts the legacy key of a kept entry on a degraded load without rewriting the file', () => {
    const text = writeFile({
      version: 2,
      providers: [
        {
          id: PREPARED,
          name: 'O',
          baseUrl: 'http://192.168.1.20:11434',
          timeoutSeconds: 120,
          taggingModel: null,
          promptModel: null,
        },
        {
          id: THIRD,
          name: 'B',
          baseUrl: 'http://192.168.1.30:11434',
          timeoutSeconds: 5,
          taggingModel: null,
          promptModel: null,
        },
      ],
      lastUsedId: null,
      adoptLegacyKey: { id: PREPARED, origin: 'http://192.168.1.20:11434' },
    });
    writeLegacyKey();
    const s = store();
    expect(s.list().providers).toMatchObject([{ id: PREPARED, hasApiKey: true }]);
    expect(existsSync(legacyKeyFile())).toBe(false);
    expect(codec.decrypt(readFileSync(keyFile(PREPARED)))).toBe(encodeKeyPayload('http://192.168.1.20:11434', KEY));
    expect(readFileSync(settingsFile(), 'utf8')).toBe(text);
    // The next start finds the key already moved and clears the marker as today.
    expect(store().list().providers).toMatchObject([{ id: PREPARED, hasApiKey: true }]);
  });

  it('sweeps an orphan key file after a clean load and makes no copy', () => {
    writeV4([good]);
    writeKeys(PREPARED, UNKNOWN);
    expect(store().list().providers).toMatchObject([{ id: PREPARED, hasApiKey: true }]);
    expect(readdirSync(credentials())).toEqual([`vision-api-key-${PREPARED}`]);
    expect(copies()).toEqual([]);
  });
});

describe('provider store: key bound to its origin', () => {
  const ORIGIN = 'http://192.168.1.20:11434';
  const writeStored = () =>
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        version: 4,
        providers: [
          {
            id: PREPARED,
            kind: 'ollama',
            name: 'O',
            baseUrl: `${ORIGIN}/api`,
            timeoutSeconds: 120,
            taggingModel: null,
            promptModel: null,
            editModel: null,
            options: DEFAULT_PROVIDER_OPTIONS,
          },
        ],
        lastUsed: { vision: null, image: null },
        adoptLegacyKey: null,
      }),
    );
  const writeKey = (data: Buffer) => {
    mkdirSync(credentials(), { recursive: true });
    writeFileSync(keyFile(PREPARED), data);
  };
  const stored = () => codec.decrypt(readFileSync(keyFile(PREPARED)));

  it('stores a saved key together with the origin', () => {
    const s = store();
    const a = s.save(input({ baseUrl: `${ORIGIN}/x/`, apiKey: KEY }));
    expect(codec.decrypt(readFileSync(keyFile(a.id)))).toBe(encodeKeyPayload(ORIGIN, KEY));
  });

  it('gives no key when the stored origin differs from the entry, and leaves the file alone', () => {
    writeStored();
    const data = codec.encrypt(encodeKeyPayload('http://192.168.1.99:11434', KEY));
    writeKey(data);
    const s = store();
    expect(s.list().providers).toMatchObject([{ id: PREPARED, hasApiKey: false }]);
    expect(s.apiKeyFor(PREPARED, ORIGIN)).toBeNull();
    expect(s.apiKeyFor(PREPARED, 'http://192.168.1.99:11434')).toBeNull();
    expect(readFileSync(keyFile(PREPARED)).equals(data)).toBe(true);
    // Saving a key replaces it.
    expect(s.save(input({ id: PREPARED, name: 'O', baseUrl: ORIGIN, apiKey: OTHER_KEY })).hasApiKey).toBe(true);
    expect(s.apiKeyFor(PREPARED, ORIGIN)).toBe(OTHER_KEY);
  });

  it('gives no key for a payload in the new form that cannot be read, and leaves the file alone', () => {
    writeStored();
    const data = codec.encrypt(`${encodeKeyPayload(ORIGIN, KEY).slice(0, -2)}`);
    writeKey(data);
    const s = store();
    expect(s.list().providers).toMatchObject([{ hasApiKey: false }]);
    expect(s.apiKeyFor(PREPARED, ORIGIN)).toBeNull();
    expect(readFileSync(keyFile(PREPARED)).equals(data)).toBe(true);
  });

  it('binds a bare key file to the entry origin at load, before any request', () => {
    writeStored();
    writeKey(codec.encrypt(KEY));
    const s = store();
    expect(s.apiKeyFor(PREPARED, ORIGIN)).toBe(KEY);
    expect(stored()).toBe(encodeKeyPayload(ORIGIN, KEY));
    expect(s.list().providers).toMatchObject([{ hasApiKey: true }]);
    expect(store().apiKeyFor(PREPARED, `${ORIGIN}/other`)).toBe(KEY);
    expect(readdirSync(credentials())).toEqual([`vision-api-key-${PREPARED}`]);
  });

  it('keeps a bare key file usable for the session when the rewrite fails', () => {
    writeStored();
    const data = codec.encrypt(KEY);
    writeKey(data);
    const encrypt = codec.encrypt.bind(codec);
    codec.encrypt = () => {
      throw new Error('encrypt failed');
    };
    const s = store();
    expect(s.list().providers).toMatchObject([{ hasApiKey: true }]);
    expect(s.apiKeyFor(PREPARED, ORIGIN)).toBe(KEY);
    expect(readFileSync(keyFile(PREPARED)).equals(data)).toBe(true);
    expect(readdirSync(credentials())).toEqual([`vision-api-key-${PREPARED}`]);
    // The next start rewrites it.
    codec.encrypt = encrypt;
    expect(store().apiKeyFor(PREPARED, ORIGIN)).toBe(KEY);
    expect(stored()).toBe(encodeKeyPayload(ORIGIN, KEY));
  });

  it('still removes the key on an origin change through save, whatever its form', () => {
    writeStored();
    writeKey(codec.encrypt(KEY));
    const encrypt = codec.encrypt.bind(codec);
    codec.encrypt = () => {
      throw new Error('encrypt failed');
    };
    const s = store();
    codec.encrypt = encrypt;
    expect(s.save(input({ id: PREPARED, name: 'O', baseUrl: 'http://192.168.1.21:11434' })).hasApiKey).toBe(false);
    expect(existsSync(keyFile(PREPARED))).toBe(false);
    expect(s.apiKeyFor(PREPARED, 'http://192.168.1.21:11434')).toBeNull();
  });
});

describe('provider store: a later start', () => {
  const ORPHAN = '88888888-9999-4aaa-8bbb-cccccccccccc';
  const entry = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind: 'ollama',
    name,
    baseUrl: 'http://192.168.1.20:11434',
    timeoutSeconds: 120,
    taggingModel: null,
    promptModel: null,
    editModel: null,
    options: DEFAULT_PROVIDER_OPTIONS,
    ...extra,
  });
  const writeV4 = (providers: unknown[]) =>
    writeFileSync(
      settingsFile(),
      JSON.stringify({ version: 4, providers, lastUsed: { vision: null, image: null }, adoptLegacyKey: null }),
    );
  const writeKeys = (...ids: string[]) => {
    mkdirSync(credentials(), { recursive: true });
    for (const id of ids) writeFileSync(keyFile(id), codec.encrypt(encodeKeyPayload('http://192.168.1.20:11434', KEY)));
  };
  const copies = () => readdirSync(dir).filter((n) => n.startsWith('provider-settings.json.corrupt-'));

  it('keeps every key file on a second start after a wholly unreadable file was set aside', () => {
    writeFileSync(settingsFile(), 'not json');
    writeKeys(PREPARED, ORPHAN);
    expect(store().list().providers).toEqual([]);
    expect(existsSync(settingsFile())).toBe(false);
    expect(store().list().providers).toEqual([]);
    for (const id of [PREPARED, ORPHAN]) expect(existsSync(keyFile(id)), id).toBe(true);
  });

  it('keeps the old key files on a second start after a provider was saved in the session that set the file aside', () => {
    writeFileSync(settingsFile(), 'not json');
    writeKeys(PREPARED, ORPHAN);
    const a = store().save(input({ name: 'New', apiKey: OTHER_KEY }));
    const s = store();
    expect(s.list().providers.map((p) => p.id)).toEqual([a.id]);
    for (const id of [PREPARED, ORPHAN, a.id]) expect(existsSync(keyFile(id)), id).toBe(true);
    expect(s.apiKeyFor(a.id, a.baseUrl)).toBe(OTHER_KEY);
  });

  it('keeps the key file of a left-out entry on a second start after the file was rewritten', () => {
    writeV4([entry(PREPARED, 'O'), entry(ORPHAN, 'B', { timeoutSeconds: 5 })]);
    writeKeys(PREPARED, ORPHAN);
    const s = store();
    expect(s.list().providers.map((p) => p.id)).toEqual([PREPARED]);
    s.markUsed(PREPARED);
    expect(readSettings().providers).toHaveLength(1);
    expect(
      store()
        .list()
        .providers.map((p) => p.id),
    ).toEqual([PREPARED]);
    expect(existsSync(keyFile(ORPHAN))).toBe(true);
  });

  it('still sweeps an orphan on a clean file without a damaged copy beside it', () => {
    writeV4([entry(PREPARED, 'O')]);
    writeKeys(PREPARED, ORPHAN);
    store().list();
    expect(readdirSync(credentials())).toEqual([`vision-api-key-${PREPARED}`]);
  });

  it('keeps key files while there is no settings file', () => {
    writeKeys(ORPHAN);
    writeLegacyKey();
    store().list();
    expect(readdirSync(credentials()).sort()).toEqual(['vision-api-key', `vision-api-key-${ORPHAN}`].sort());
  });

  it('does not pile up copies of a damaged file that stays unchanged', () => {
    writeV4([entry(PREPARED, 'O'), entry(ORPHAN, 'B', { timeoutSeconds: 5 })]);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-27T10:00:00Z'));
      store().list();
      vi.setSystemTime(new Date('2026-11-27T11:00:00Z'));
      store().list();
    } finally {
      vi.useRealTimers();
    }
    expect(copies()).toHaveLength(1);
  });

  it('loads a damaged file when the copy cannot be written, and sweeps nothing', () => {
    writeV4([entry(PREPARED, 'O'), entry(ORPHAN, 'B', { timeoutSeconds: 5 })]);
    writeKeys(PREPARED, ORPHAN, UNKNOWN);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-27T10:00:00Z'));
      // A non-empty directory where the copy belongs makes the copy fail.
      const blocked = join(dir, 'provider-settings.json.corrupt-2026-11-27T10-00-00-000Z');
      mkdirSync(blocked);
      writeFileSync(join(blocked, 'blocker'), 'x');
      const s = store();
      expect(s.list().providers.map((p) => p.id)).toEqual([PREPARED]);
    } finally {
      vi.useRealTimers();
    }
    for (const id of [PREPARED, ORPHAN, UNKNOWN]) expect(existsSync(keyFile(id)), id).toBe(true);
  });

  it('keeps the key when the settings write of a save fails', () => {
    const s = store();
    const a = s.save(input({ apiKey: KEY }));
    rmSync(settingsFile());
    mkdirSync(settingsFile());
    writeFileSync(join(settingsFile(), 'blocker'), 'x');
    expect(() => s.save(input({ id: a.id, apiKey: null }))).toThrow();
    expect(() => s.save(input({ id: a.id, baseUrl: 'http://192.168.1.21:11434' }))).toThrow();
    expect(existsSync(keyFile(a.id))).toBe(true);
    expect(s.apiKeyFor(a.id, a.baseUrl)).toBe(KEY);
  });
});
