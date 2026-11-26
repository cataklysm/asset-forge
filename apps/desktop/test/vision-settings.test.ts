import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SetVisionSettings } from '@assetforge/contracts';
import { AssetForgeError } from '@assetforge/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVisionSettingsStore, UNUSABLE_ENV_BASE_URL } from '../src/main/vision-settings.js';
import { FakeCodec } from './fake-codec.js';

const KEY = 'test-key-not-real';
const OTHER_KEY = 'test-key-not-real-2';

let dir: string;
let codec: FakeCodec;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-vision-settings-'));
  codec = new FakeCodec();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const settingsFile = () => join(dir, 'provider-settings.json');
const keyFile = () => join(dir, 'credentials', 'vision-api-key');
const store = (env: NodeJS.ProcessEnv = {}) => createVisionSettingsStore({ userData: dir, secrets: codec, env });

function input(overrides: Partial<SetVisionSettings> = {}): SetVisionSettings {
  return { baseUrl: 'http://192.168.1.20:11434', timeoutSeconds: 120, taggingModel: 'tagger', promptModel: 'writer', ...overrides };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof AssetForgeError) return error.code;
    throw error;
  }
  return undefined;
}

/** Every file under `root`, recursively, as raw bytes. */
function allFiles(root: string): Buffer[] {
  const out: Buffer[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) out.push(...allFiles(path));
    else out.push(readFileSync(path));
  }
  return out;
}

describe('vision settings store: settings', () => {
  it('is empty without a file and without the environment', () => {
    const s = store();
    expect(s.baseUrl()).toBeNull();
    expect(s.apiKey()).toBeNull();
    expect(s.timeoutMs()).toBe(120_000);
    expect(s.defaults()).toEqual({ taggingModel: null, promptModel: null });
    expect(s.view()).toEqual({
      baseUrl: null,
      timeoutSeconds: 120,
      taggingModel: null,
      promptModel: null,
      hasApiKey: false,
      fromEnvironment: false,
      canStoreKey: true,
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('round-trips URL, timeout and models across instances', () => {
    const saved = store().save(input({ baseUrl: 'https://ollama.example.test/base/', timeoutSeconds: 300 }));
    expect(saved).toMatchObject({ baseUrl: 'https://ollama.example.test/base', timeoutSeconds: 300, taggingModel: 'tagger', promptModel: 'writer' });
    const again = store();
    expect(again.view()).toEqual(saved);
    expect(again.baseUrl()).toBe('https://ollama.example.test/base');
    expect(again.timeoutMs()).toBe(300_000);
    expect(again.defaults()).toEqual({ taggingModel: 'tagger', promptModel: 'writer' });
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8'))).toEqual({
      version: 1,
      vision: { baseUrl: 'https://ollama.example.test/base', timeoutSeconds: 300, taggingModel: 'tagger', promptModel: 'writer' },
    });
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('stores a null base URL and null models', () => {
    store().save(input({ baseUrl: null, taggingModel: null, promptModel: null }));
    expect(store().view()).toMatchObject({ baseUrl: null, taggingModel: null, promptModel: null });
  });

  it.each([
    ['user info', 'http://user:pw@host:11434'],
    ['a user name', 'http://user@host:11434'],
    ['a query', 'http://host:11434/?a=1'],
    ['a fragment', 'http://host:11434/#x'],
    ['a bare ?', 'http://host:11434/?'],
    ['a bare #', 'http://host:11434/#'],
    ['ftp', 'ftp://host/'],
    ['no URL', 'not a url'],
  ])('refuses a base URL with %s and writes nothing', (_label, baseUrl) => {
    const s = store();
    expect(codeOf(() => s.save(input({ baseUrl, apiKey: KEY })))).toBe('invalid_operation');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses values outside the contract and writes nothing', () => {
    const s = store();
    expect(codeOf(() => s.save(input({ timeoutSeconds: 9 })))).toBe('invalid_operation');
    expect(codeOf(() => s.save(input({ taggingModel: '' })))).toBe('invalid_operation');
    expect(codeOf(() => s.save(input({ apiKey: '' })))).toBe('invalid_operation');
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    ['not JSON', 'not json'],
    ['a wrong version', JSON.stringify({ version: 2, vision: {} })],
    ['a wrong shape', JSON.stringify({ version: 1, vision: { baseUrl: 5 } })],
    ['an unusable base URL', JSON.stringify({ version: 1, vision: { baseUrl: 'http://u:p@h', timeoutSeconds: 120, taggingModel: null, promptModel: null } })],
  ])('renames a file with %s aside and reads empty', (_label, content) => {
    writeFileSync(settingsFile(), content);
    const s = store();
    expect(s.view()).toMatchObject({ baseUrl: null, timeoutSeconds: 120, taggingModel: null, promptModel: null });
    const names = readdirSync(dir);
    expect(names.filter((n) => n.startsWith('provider-settings.json.corrupt-'))).toHaveLength(1);
    expect(names.some((n) => n.includes(':'))).toBe(false);
    expect(existsSync(settingsFile())).toBe(false);
  });

  it('never touches the registry settings.json', () => {
    const registry = join(dir, 'settings.json');
    writeFileSync(registry, 'registry content');
    const before = statSync(registry).mtimeMs;
    const s = store();
    s.save(input({ apiKey: KEY }));
    s.save(input({ baseUrl: 'http://other:1', apiKey: null }));
    s.view();
    expect(readFileSync(registry, 'utf8')).toBe('registry content');
    expect(statSync(registry).mtimeMs).toBe(before);
  });

  it('tells listeners after a save', () => {
    const s = store();
    let calls = 0;
    s.onChange(() => calls++);
    s.save(input());
    expect(calls).toBe(1);
    expect(codeOf(() => s.save(input({ baseUrl: 'ftp://x' })))).toBe('invalid_operation');
    expect(calls).toBe(1);
  });
});

describe('vision settings store: API key', () => {
  it('stores bytes that differ from the plaintext; the plaintext is nowhere under userData', () => {
    const s = store();
    s.save(input({ apiKey: KEY }));
    const stored = readFileSync(keyFile());
    expect(stored.equals(Buffer.from(KEY))).toBe(false);
    for (const bytes of allFiles(dir)) expect(bytes.includes(Buffer.from(KEY))).toBe(false);
    expect(s.apiKey()).toBe(KEY);
    expect(store().apiKey()).toBe(KEY);
  });

  it('returns only hasApiKey from view and save, never the key', () => {
    const s = store();
    const saved = s.save(input({ apiKey: KEY }));
    expect(saved.hasApiKey).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(JSON.stringify(s.view())).not.toContain(KEY);
    expect(Object.keys(saved).sort()).toEqual(
      ['baseUrl', 'canStoreKey', 'fromEnvironment', 'hasApiKey', 'promptModel', 'taggingModel', 'timeoutSeconds'],
    );
  });

  it('keeps the key when apiKey is absent, deletes it on null, replaces it on a string', () => {
    const s = store();
    s.save(input({ apiKey: KEY }));
    expect(s.save(input({ timeoutSeconds: 200 })).hasApiKey).toBe(true);
    expect(s.apiKey()).toBe(KEY);
    s.save(input({ apiKey: OTHER_KEY }));
    expect(s.apiKey()).toBe(OTHER_KEY);
    expect(s.save(input({ apiKey: null })).hasApiKey).toBe(false);
    expect(s.apiKey()).toBeNull();
    expect(existsSync(keyFile())).toBe(false);
  });

  it('refuses a key without a credential store: no key file, the URL is not saved either', () => {
    codec.canEncrypt = false;
    const s = store();
    expect(s.view().canStoreKey).toBe(false);
    expect(codeOf(() => s.save(input({ apiKey: KEY })))).toBe('credential_store_unavailable');
    expect(codec.encryptCalls).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    expect(s.baseUrl()).toBeNull();
  });

  it('still saves URL and models without a credential store when no key is given', () => {
    codec.canEncrypt = false;
    const s = store();
    expect(s.save(input()).baseUrl).toBe('http://192.168.1.20:11434');
    expect(existsSync(keyFile())).toBe(false);
  });

  it('counts an undecryptable key file as no key', () => {
    mkdirSync(join(dir, 'credentials'));
    writeFileSync(keyFile(), 'garbage');
    store().save(input());
    const s = store();
    expect(s.view().hasApiKey).toBe(false);
    expect(s.apiKey()).toBeNull();
  });

  it('tells listeners when the key write fails after the settings were written', () => {
    const s = store();
    s.save(input());
    // A non-empty directory where the key file belongs makes the final rename fail.
    mkdirSync(keyFile(), { recursive: true });
    writeFileSync(join(keyFile(), 'blocker'), 'x');
    let calls = 0;
    s.onChange(() => calls++);
    expect(() => s.save(input({ timeoutSeconds: 200, apiKey: KEY }))).toThrow();
    expect(calls).toBe(1);
    expect(s.timeoutMs()).toBe(200_000);
    expect(readdirSync(join(dir, 'credentials')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('sweeps temporary key files left by a crash on load', () => {
    mkdirSync(join(dir, 'credentials'));
    const leftover = join(dir, 'credentials', 'vision-api-key.11111111-1111-4111-8111-111111111111.tmp');
    writeFileSync(leftover, 'partial');
    writeFileSync(join(dir, 'credentials', 'unrelated.tmp'), 'other');
    store().view();
    expect(existsSync(leftover)).toBe(false);
    expect(readdirSync(join(dir, 'credentials'))).toEqual(['unrelated.tmp']);
  });

  it('sweeps temporary key files when the key is deleted', () => {
    const s = store();
    s.save(input({ apiKey: KEY }));
    const leftover = join(dir, 'credentials', 'vision-api-key.22222222-2222-4222-8222-222222222222.tmp');
    writeFileSync(leftover, 'partial');
    s.save(input({ apiKey: null }));
    expect(readdirSync(join(dir, 'credentials'))).toEqual([]);
  });

  it('reports no key when the credential store becomes unavailable', () => {
    store().save(input({ apiKey: KEY }));
    codec.canEncrypt = false;
    const s = store();
    expect(s.apiKey()).toBeNull();
    expect(s.view().hasApiKey).toBe(false);
  });
});

describe('vision settings store: origin rule', () => {
  it.each([
    ['the scheme', 'https://192.168.1.20:11434'],
    ['the host', 'http://192.168.1.21:11434'],
    ['the port', 'http://192.168.1.20:11435'],
    ['to no URL', null],
  ])('deletes the key when %s changes without a new key', (_label, baseUrl) => {
    const s = store();
    s.save(input({ apiKey: KEY }));
    expect(s.save(input({ baseUrl })).hasApiKey).toBe(false);
    expect(s.apiKey()).toBeNull();
    expect(existsSync(keyFile())).toBe(false);
  });

  it('keeps the key when only the path changes', () => {
    const s = store();
    s.save(input({ apiKey: KEY }));
    expect(s.save(input({ baseUrl: 'http://192.168.1.20:11434/ollama' })).hasApiKey).toBe(true);
    expect(s.apiKey()).toBe(KEY);
  });

  it('keeps the key when the default port is spelled out', () => {
    const s = store();
    s.save(input({ baseUrl: 'https://ollama.example.test', apiKey: KEY }));
    expect(s.save(input({ baseUrl: 'https://ollama.example.test:443/' })).hasApiKey).toBe(true);
  });

  it.each([
    ['host case', 'http://Ollama.Example.test:11434', 'http://ollama.example.TEST:11434/x', true],
    ['an IPv6 literal', 'http://[::1]:11434', 'http://[0:0:0:0:0:0:0:1]:11434/api', true],
    ['an explicit default port', 'http://ollama.example.test', 'http://ollama.example.test:80', true],
    ['a trailing dot', 'http://ollama.example.test:11434', 'http://ollama.example.test.:11434', false],
  ])('normalises the origin for %s', (_label, first, second, kept) => {
    const s = store();
    s.save(input({ baseUrl: first, apiKey: KEY }));
    expect(s.save(input({ baseUrl: second })).hasApiKey).toBe(kept);
    expect(s.apiKey()).toBe(kept ? KEY : null);
  });

  it('answers apiKeyFor only for the origin in force', () => {
    const s = store();
    s.save(input({ apiKey: KEY }));
    expect(s.apiKeyFor('http://192.168.1.20:11434/other')).toBe(KEY);
    expect(s.apiKeyFor('http://192.168.1.21:11434')).toBeNull();
    s.save(input({ baseUrl: null }));
    expect(s.apiKeyFor('http://192.168.1.20:11434')).toBeNull();
  });

  it('stores the new key when the origin changes with a new key', () => {
    const s = store();
    s.save(input({ apiKey: KEY }));
    expect(s.save(input({ baseUrl: 'http://192.168.1.21:11434', apiKey: OTHER_KEY })).hasApiKey).toBe(true);
    expect(s.apiKey()).toBe(OTHER_KEY);
  });
});

describe('vision settings store: environment', () => {
  const env = { ASSETFORGE_VISION_BASE_URL: 'http://127.0.0.1:11500/', ASSETFORGE_VISION_MODEL: 'env-model' };

  it('overrides the stored settings and never sends the stored key', () => {
    store().save(input({ apiKey: KEY }));
    const s = store(env);
    expect(s.view()).toEqual({
      baseUrl: 'http://127.0.0.1:11500',
      timeoutSeconds: 120,
      taggingModel: 'env-model',
      promptModel: 'env-model',
      hasApiKey: false,
      fromEnvironment: true,
      canStoreKey: true,
    });
    expect(s.baseUrl()).toBe('http://127.0.0.1:11500');
    expect(s.defaults()).toEqual({ taggingModel: 'env-model', promptModel: 'env-model' });
    expect(s.apiKey()).toBeNull();
  });

  it('refuses a save', () => {
    const s = store(env);
    expect(codeOf(() => s.save(input()))).toBe('invalid_operation');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('has no models without ASSETFORGE_VISION_MODEL', () => {
    const s = store({ ASSETFORGE_VISION_BASE_URL: 'http://127.0.0.1:11500' });
    expect(s.defaults()).toEqual({ taggingModel: null, promptModel: null });
  });

  it('counts an unusable environment URL as not configured', () => {
    store().save(input());
    const s = store({ ASSETFORGE_VISION_BASE_URL: 'http://u:p@127.0.0.1:11500', ASSETFORGE_VISION_MODEL: 'env-model' });
    expect(s.baseUrl()).toBeNull();
    expect(s.view()).toMatchObject({ baseUrl: null, fromEnvironment: true });
  });

  it('warns once, without the value, about an unusable environment URL', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = store({ ASSETFORGE_VISION_BASE_URL: 'http://u:secret-part@127.0.0.1:11500' });
      s.view();
      s.baseUrl();
      s.defaults();
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
      store(env).view();
      store().view();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
