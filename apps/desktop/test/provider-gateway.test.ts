import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SaveProvider } from '@assetforge/contracts';
import { JobError, type VisionProvider } from '@assetforge/core';
import { createOllamaVision, createOpenAiVision, createVeniceImage, type OllamaVisionOptions, type VeniceImageOptions } from '@assetforge/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MOCK_EDIT_BASIC_MODEL,
  MOCK_EDIT_MODEL,
  MOCK_MODEL,
  startMockProvider,
  type MockProvider,
} from '../../../docker/mock-provider/server.mjs';
import { createProviderGateway } from '../src/main/provider-gateway.js';
import { createProviderStore, type ProviderStore } from '../src/main/provider-store.js';
import { FakeCodec } from './fake-codec.js';

const KEY = 'test-key-not-real';
const OTHER_KEY = 'test-key-not-real-2';
const UNKNOWN = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';

let dir: string;
let store: ProviderStore;
let lines: string[];
let mocks: MockProvider[];

const input = (o: Partial<SaveProvider> = {}): SaveProvider => ({
  name: 'A',
  baseUrl: 'http://192.168.1.20:11434',
  timeoutSeconds: 60,
  taggingModel: 'tagger',
  promptModel: null,
  ...o,
});
const signal = () => new AbortController().signal;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-provider-gateway-'));
  store = createProviderStore({ userData: dir, secrets: new FakeCodec(), env: {} });
  lines = [];
  mocks = [];
});
afterEach(async () => {
  for (const mock of mocks) await mock.close();
  await rm(dir, { recursive: true, force: true });
});

async function mock(apiKey?: string): Promise<MockProvider> {
  const m = await startMockProvider({ port: 0, ...(apiKey === undefined ? {} : { apiKey }) });
  mocks.push(m);
  return m;
}

const authorizations = (m: MockProvider) => m.requests.map((r) => r.headers.authorization ?? null);

describe('provider gateway against two mock providers', () => {
  it('sends each entry only its own key, and no key after an entry moves to the other address', async () => {
    const mockA = await mock(KEY);
    const mockB = await mock(OTHER_KEY);
    const g = createProviderGateway({ store, createVision: { ollama: createOllamaVision, openai: createOpenAiVision }, createImage: createVeniceImage, log: (l) => lines.push(l) });
    const a = store.save(input({ name: 'A', baseUrl: mockA.url, apiKey: KEY }));
    const b = store.save(input({ name: 'B', baseUrl: mockB.url, apiKey: OTHER_KEY }));

    expect(await g.models(a.id, true, signal())).toMatchObject({ ok: true });
    expect(await g.models(b.id, true, signal())).toMatchObject({ ok: true });
    expect(mockA.requests.length).toBeGreaterThan(0);
    expect(mockB.requests.length).toBeGreaterThan(0);
    expect(new Set(authorizations(mockA))).toEqual(new Set([`Bearer ${KEY}`]));
    expect(new Set(authorizations(mockB))).toEqual(new Set([`Bearer ${OTHER_KEY}`]));

    const staleA = g.vision(a.id)!;
    store.save(input({ id: a.id, name: 'A', baseUrl: mockB.url }));
    const before = mockB.requests.length;
    expect(await g.models(a.id, true, signal())).toEqual({ ok: false, code: 'provider_unauthorized' });
    const fromA = mockB.requests.slice(before);
    expect(fromA.length).toBeGreaterThan(0);
    for (const request of fromA) expect(request.headers.authorization).toBeUndefined();

    // The adapter built before the save still points at mock A and no longer gets A's key.
    const beforeStale = mockA.requests.length;
    await expect(staleA.listModels(signal())).rejects.toBeInstanceOf(JobError);
    const fromStale = mockA.requests.slice(beforeStale);
    expect(fromStale.length).toBeGreaterThan(0);
    for (const request of fromStale) expect(request.headers.authorization).toBeUndefined();

    // B is untouched.
    expect(await g.models(b.id, true, signal())).toMatchObject({ ok: true, models: expect.arrayContaining([{ name: MOCK_MODEL, vision: true }]) });
    expect(mockA.requests.some((r) => r.headers.authorization === `Bearer ${OTHER_KEY}`)).toBe(false);
    expect(lines.join('\n')).not.toContain('test-key-not-real');
  });

  it('lists the models of an openai entry from the mock with its key', async () => {
    const m = await mock(KEY);
    const g = createProviderGateway({ store, createVision: { ollama: createOllamaVision, openai: createOpenAiVision }, createImage: createVeniceImage, log: (l) => lines.push(l) });
    const a = store.save(input({ kind: 'openai', baseUrl: `${m.url}/v1`, apiKey: KEY }));
    const result = await g.models(a.id, true, signal());
    expect(result).toMatchObject({ ok: true, models: expect.arrayContaining([{ name: MOCK_MODEL, vision: null }]) });
    expect(m.requests.map((r) => r.path)).toEqual(['/v1/models']);
    expect(authorizations(m)).toEqual([`Bearer ${KEY}`]);
  });

  it('sends no key from a deleted entry to an entry recreated for the same address', async () => {
    const m = await mock(KEY);
    const g = createProviderGateway({ store, createVision: { ollama: createOllamaVision, openai: createOpenAiVision }, createImage: createVeniceImage, log: (l) => lines.push(l) });
    const old = store.save(input({ baseUrl: m.url, apiKey: KEY }));
    const stale = g.vision(old.id)!;
    store.delete(old.id);
    store.save(input({ name: 'New', baseUrl: m.url, apiKey: OTHER_KEY }));
    await expect(stale.listModels(signal())).rejects.toBeInstanceOf(JobError);
    expect(m.requests.length).toBeGreaterThan(0);
    for (const request of m.requests) expect(request.headers.authorization).toBeUndefined();
  });
});

describe('provider gateway with a fake adapter', () => {
  let created: OllamaVisionOptions[];
  /** The factory kind of every adapter built, in the order of `created`. */
  let kinds: string[];
  let listCalls: Map<string, number>;
  let listResult: (baseUrl: string) => Promise<{ name: string; vision: boolean | null }[]>;

  const fakeCreate = (options: OllamaVisionOptions): VisionProvider => fakeAdapter('ollama', options);
  const fakeCreateOpenAi = (options: OllamaVisionOptions): VisionProvider => fakeAdapter('openai', options);
  function fakeAdapter(kind: string, options: OllamaVisionOptions): VisionProvider {
    created.push(options);
    kinds.push(kind);
    return {
      analyzeImage: async () => ({}),
      describeImage: async () => '',
      listModels: async () => {
        listCalls.set(options.baseUrl, (listCalls.get(options.baseUrl) ?? 0) + 1);
        return listResult(options.baseUrl);
      },
    };
  }
  const gateway = () => createProviderGateway({ store, createVision: { ollama: fakeCreate, openai: fakeCreateOpenAi }, createImage: createVeniceImage, log: (l) => lines.push(l) });
  const calls = (baseUrl: string) => listCalls.get(baseUrl) ?? 0;

  beforeEach(() => {
    created = [];
    kinds = [];
    listCalls = new Map();
    listResult = async () => [{ name: 'tagger', vision: true }];
  });

  const openaiInput = (o: Partial<SaveProvider> = {}): SaveProvider =>
    input({ kind: 'openai', name: 'vLLM', baseUrl: 'http://192.168.1.40:8000/v1', ...o });

  it('builds an openai entry with the openai factory and an ollama entry with the ollama one', () => {
    const o = store.save(input());
    const a = store.save(openaiInput({ apiKey: KEY }));
    const g = gateway();
    expect(g.vision(a.id)).not.toBeNull();
    expect(g.vision(o.id)).not.toBeNull();
    expect(kinds).toEqual(['openai', 'ollama']);
    expect(created.map((c) => c.baseUrl)).toEqual(['http://192.168.1.40:8000/v1', 'http://192.168.1.20:11434']);
    expect(created[0]!.apiKey!()).toBe(KEY);
  });

  it('hands the factory the parsed request options and rebuilds the adapter when they change', () => {
    const a = store.save(openaiInput({ options: { temperature: 0.4, thinking: 'on', maxTokens: 300, extra: '{"top_k":20}', parallelRequests: 8 } }));
    const o = store.save(input());
    const g = gateway();
    const first = g.vision(a.id);
    g.vision(o.id);
    expect(created[0]!.requestOptions).toEqual({ temperature: 0.4, thinking: 'on', maxTokens: 300, extra: { top_k: 20 } });
    expect(created[1]!.requestOptions).toEqual({ temperature: 0, thinking: 'default', maxTokens: null, extra: {} });
    store.save(openaiInput({ id: a.id, options: { temperature: 1, thinking: 'off', maxTokens: null, extra: '', parallelRequests: 1 } }));
    const rebuilt = g.vision(a.id);
    expect(rebuilt).not.toBe(first);
    expect(kinds).toEqual(['openai', 'ollama', 'openai']);
    expect(created[2]!.requestOptions).toEqual({ temperature: 1, thinking: 'off', maxTokens: null, extra: {} });
  });

  it('builds an entry whose stored extra parameters fail the rule with no extra parameters', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const entry = { id, kind: 'openai', name: 'vLLM', baseUrl: 'http://192.168.1.40:8000/v1', timeoutSeconds: 60, taggingModel: 'tagger', promptModel: null, editModel: null };
    const options = { temperature: 0.4, thinking: 'on', maxTokens: 300, extra: '{"n":2,"top_k":20}' };
    writeFileSync(
      join(dir, 'provider-settings.json'),
      JSON.stringify({ version: 4, providers: [{ ...entry, options }], lastUsed: { vision: null, image: null }, adoptLegacyKey: null }),
    );
    store = createProviderStore({ userData: dir, secrets: new FakeCodec(), env: {} });
    expect(gateway().vision(id)).not.toBeNull();
    expect(created[0]!.requestOptions).toEqual({ temperature: 0.4, thinking: 'on', maxTokens: 300, extra: {} });
    expect(lines.join('\n')).not.toContain('top_k');
  });

  it('lists the models of an openai entry', async () => {
    const a = store.save(openaiInput());
    listResult = async () => [{ name: 'qwen', vision: null }];
    expect(await gateway().models(a.id, false, signal())).toEqual({ ok: true, models: [{ name: 'qwen', vision: null }] });
    expect(kinds).toEqual(['openai']);
  });

  it('builds one adapter per entry and hands the key over as a function', () => {
    const a = store.save(input({ apiKey: KEY }));
    const b = store.save(input({ name: 'B', baseUrl: 'http://192.168.1.30:11434', timeoutSeconds: 30 }));
    const g = gateway();
    const first = g.vision(a.id);
    expect(first).not.toBeNull();
    expect(g.vision(a.id)).toBe(first);
    expect(g.vision(b.id)).not.toBe(first);
    expect(created.map((o) => [o.baseUrl, o.timeoutMs])).toEqual([
      ['http://192.168.1.20:11434', 60_000],
      ['http://192.168.1.30:11434', 30_000],
    ]);
    expect(created[0]!.apiKey!()).toBe(KEY);
    expect(created[1]!.apiKey!()).toBeNull();
    expect(JSON.stringify(created)).not.toContain(KEY);
  });

  it('answers null for no id, an unknown id and a deleted entry', () => {
    const a = store.save(input());
    const g = gateway();
    expect(g.vision(null)).toBeNull();
    expect(g.vision(UNKNOWN)).toBeNull();
    g.vision(a.id);
    store.delete(a.id);
    expect(g.vision(a.id)).toBeNull();
  });

  it('rebuilds only the entry that changed; a stale adapter gets no key for the new origin', () => {
    const a = store.save(input({ apiKey: KEY }));
    const b = store.save(input({ name: 'B', baseUrl: 'http://192.168.1.30:11434', apiKey: OTHER_KEY }));
    const g = gateway();
    const adapterA = g.vision(a.id);
    const adapterB = g.vision(b.id);
    const staleOptions = created[0]!;
    store.save(input({ id: a.id, baseUrl: 'http://192.168.1.21:11434', apiKey: KEY }));
    expect(staleOptions.apiKey!()).toBeNull();
    expect(g.vision(b.id)).toBe(adapterB);
    const rebuilt = g.vision(a.id);
    expect(rebuilt).not.toBe(adapterA);
    expect(created[2]!.baseUrl).toBe('http://192.168.1.21:11434');
    expect(created[2]!.apiKey!()).toBe(KEY);
  });

  it('keeps handing the key to an adapter whose origin is unchanged by a path-only change', () => {
    const a = store.save(input({ apiKey: KEY }));
    gateway().vision(a.id);
    store.save(input({ id: a.id, baseUrl: 'http://192.168.1.20:11434/ollama' }));
    expect(created[0]!.apiKey!()).toBe(KEY);
  });

  it('logs the id and the code, never the URL or the key', () => {
    const a = store.save(input({ apiKey: KEY }));
    gateway().vision(a.id);
    created[0]!.onFailure!('provider_unauthorized', 401);
    created[0]!.onFailure!('provider_unreachable', null);
    expect(lines).toEqual([
      `Vision provider ${a.id} failed: provider_unauthorized (HTTP 401)`,
      `Vision provider ${a.id} failed: provider_unreachable`,
    ]);
    for (const line of lines) {
      expect(line).not.toContain('192.168');
      expect(line).not.toContain(KEY);
    }
  });

  it('caches the model list per entry until that entry changes or a refresh', async () => {
    const a = store.save(input());
    const b = store.save(input({ name: 'B', baseUrl: 'http://192.168.1.30:11434' }));
    const g = gateway();
    expect(await g.models(a.id, false, signal())).toEqual({ ok: true, models: [{ name: 'tagger', vision: true }] });
    await g.models(a.id, false, signal());
    await g.models(b.id, false, signal());
    expect(calls(a.baseUrl)).toBe(1);
    expect(calls(b.baseUrl)).toBe(1);
    await g.models(a.id, true, signal());
    expect(calls(a.baseUrl)).toBe(2);
    store.save(input({ id: a.id, timeoutSeconds: 90 }));
    await g.models(a.id, false, signal());
    await g.models(b.id, false, signal());
    expect(calls(a.baseUrl)).toBe(3);
    expect(calls(b.baseUrl)).toBe(1);
  });

  it('throws not_found for an unknown id', async () => {
    await expect(gateway().models(UNKNOWN, false, signal())).rejects.toMatchObject({
      code: 'not_found',
      message: 'This provider does not exist',
    });
  });

  it('turns a JobError into its code and does not cache the failure', async () => {
    const a = store.save(input());
    listResult = async () => {
      throw new JobError('provider_unauthorized');
    };
    const g = gateway();
    expect(await g.models(a.id, false, signal())).toEqual({ ok: false, code: 'provider_unauthorized' });
    listResult = async () => [{ name: 'x', vision: null }];
    expect(await g.models(a.id, false, signal())).toEqual({ ok: true, models: [{ name: 'x', vision: null }] });
    expect(calls(a.baseUrl)).toBe(2);
  });

  it('rethrows anything that is not a JobError', async () => {
    const a = store.save(input());
    listResult = async () => {
      throw new Error('boom');
    };
    await expect(gateway().models(a.id, false, signal())).rejects.toThrow('boom');
  });

  it('does not cache a list that belongs to an earlier build of the entry', async () => {
    const a = store.save(input());
    let release!: () => void;
    listResult = () => new Promise((resolve) => (release = () => resolve([{ name: 'old', vision: true }])));
    const g = gateway();
    const pending = g.models(a.id, false, signal());
    store.save(input({ id: a.id, baseUrl: 'http://192.168.1.21:11434' }));
    release();
    await pending;
    listResult = async () => [{ name: 'new', vision: true }];
    expect(await g.models(a.id, false, signal())).toEqual({ ok: true, models: [{ name: 'new', vision: true }] });
  });

  it('refuses a model list of a venice entry', async () => {
    const v = store.save(veniceInput());
    await expect(gateway().models(v.id, false, signal())).rejects.toMatchObject({
      code: 'invalid_operation',
      message: 'This provider cannot analyse images',
    });
    expect(created).toEqual([]);
  });
});

const veniceInput = (o: Partial<SaveProvider> = {}): SaveProvider =>
  input({ kind: 'venice', name: 'Venice', baseUrl: 'https://api.venice.ai/api/v1', editModel: MOCK_EDIT_MODEL, ...o });

describe('provider gateway: image adapters', () => {
  let createdImage: VeniceImageOptions[];
  let createdVision: OllamaVisionOptions[];

  const recordingImage = (options: VeniceImageOptions) => {
    createdImage.push(options);
    return createVeniceImage(options);
  };
  const recordingVision = (options: OllamaVisionOptions) => {
    createdVision.push(options);
    return createOllamaVision(options);
  };
  const gateway = () => createProviderGateway({ store, createVision: { ollama: recordingVision, openai: recordingVision }, createImage: recordingImage, log: (l) => lines.push(l) });
  const veniceUrl = (m: MockProvider) => `${m.url}/api/v1`;

  beforeEach(() => {
    createdImage = [];
    createdVision = [];
  });

  it('builds one image adapter per venice entry and none for ollama entries', () => {
    const o = store.save(input());
    const v = store.save(veniceInput({ apiKey: KEY, timeoutSeconds: 45 }));
    const g = gateway();
    expect(g.image(null)).toBeNull();
    expect(g.image(UNKNOWN)).toBeNull();
    expect(g.image(o.id)).toBeNull();
    expect(g.vision(v.id)).toBeNull();
    const adapter = g.image(v.id);
    expect(adapter).not.toBeNull();
    expect(g.image(v.id)).toBe(adapter);
    expect(createdVision).toEqual([]);
    expect(createdImage.map((c) => [c.baseUrl, c.timeoutMs])).toEqual([['https://api.venice.ai/api/v1', 45_000]]);
    expect(createdImage[0]!.apiKey()).toBe(KEY);
    expect(JSON.stringify(createdImage)).not.toContain('test-key-not-real');
    store.delete(v.id);
    expect(g.image(v.id)).toBeNull();
  });

  it('logs image failures with the id and the code only', () => {
    const v = store.save(veniceInput({ apiKey: KEY }));
    gateway().image(v.id);
    createdImage[0]!.onFailure!('provider_insufficient_balance', 402);
    createdImage[0]!.onFailure!('provider_unreachable', null);
    expect(lines).toEqual([
      `Image provider ${v.id} failed: provider_insufficient_balance (HTTP 402)`,
      `Image provider ${v.id} failed: provider_unreachable`,
    ]);
  });

  it('lists the edit models against the mock, cached until a refresh', async () => {
    const m = await mock(KEY);
    const v = store.save(veniceInput({ baseUrl: veniceUrl(m), apiKey: KEY }));
    const g = gateway();
    const first = await g.imageModels(v.id, false, signal());
    expect(first.ok).toBe(true);
    expect(first.ok && first.models.map((x) => x.name)).toEqual([MOCK_EDIT_MODEL, MOCK_EDIT_BASIC_MODEL]);
    const count = m.requests.length;
    expect(count).toBeGreaterThan(0);
    expect(await g.imageModels(v.id, false, signal())).toEqual(first);
    expect(m.requests.length).toBe(count);
    expect(await g.imageModels(v.id, true, signal())).toEqual(first);
    expect(m.requests.length).toBeGreaterThan(count);
    expect(new Set(authorizations(m))).toEqual(new Set([`Bearer ${KEY}`]));
    expect(JSON.stringify(first)).not.toContain('test-key-not-real');
    expect(lines.join('\n')).not.toContain('test-key-not-real');
  });

  it('does not cache a failed list', async () => {
    const m = await mock(KEY);
    const v = store.save(veniceInput({ baseUrl: veniceUrl(m) }));
    const g = gateway();
    expect(await g.imageModels(v.id, false, signal())).toEqual({ ok: false, code: 'provider_unauthorized' });
    expect(lines).toEqual([`Image provider ${v.id} failed: provider_unauthorized (HTTP 401)`]);
    // The key is read per request: a key stored without a save (so no change event) is used at once.
    mkdirSync(join(dir, 'credentials'), { recursive: true });
    writeFileSync(join(dir, 'credentials', `vision-api-key-${v.id}`), new FakeCodec().encrypt(KEY));
    const again = await g.imageModels(v.id, false, signal());
    expect(again.ok && again.models.map((x) => x.name)).toEqual([MOCK_EDIT_MODEL, MOCK_EDIT_BASIC_MODEL]);
  });

  it('drops the adapter and the key when a venice entry moves to another origin', async () => {
    const mockA = await mock(KEY);
    const mockB = await mock(KEY);
    const v = store.save(veniceInput({ baseUrl: veniceUrl(mockA), apiKey: KEY }));
    const g = gateway();
    const stale = g.image(v.id)!;
    expect(await g.imageModels(v.id, false, signal())).toMatchObject({ ok: true });
    store.save(veniceInput({ id: v.id, baseUrl: veniceUrl(mockB) }));
    expect(store.apiKeyFor(v.id, veniceUrl(mockA))).toBeNull();
    expect(store.apiKeyFor(v.id, veniceUrl(mockB))).toBeNull();
    const rebuilt = g.image(v.id);
    expect(rebuilt).not.toBe(stale);
    expect(createdImage.map((c) => c.baseUrl)).toEqual([veniceUrl(mockA), veniceUrl(mockB)]);
    // The cached list belonged to the old entry: the next call asks mock B, without a key.
    expect(await g.imageModels(v.id, false, signal())).toEqual({ ok: false, code: 'provider_unauthorized' });
    expect(mockB.requests.length).toBeGreaterThan(0);
    for (const request of mockB.requests) expect(request.headers.authorization).toBeUndefined();
    // The stale adapter still points at mock A and gets no key any more.
    const before = mockA.requests.length;
    await expect(stale.listEditModels(signal())).rejects.toBeInstanceOf(JobError);
    const fromStale = mockA.requests.slice(before);
    expect(fromStale.length).toBeGreaterThan(0);
    for (const request of fromStale) expect(request.headers.authorization).toBeUndefined();
  });

  it('answers not_found for an unknown id and refuses an ollama entry', async () => {
    const o = store.save(input());
    const g = gateway();
    await expect(g.imageModels(UNKNOWN, false, signal())).rejects.toMatchObject({ code: 'not_found', message: 'This provider does not exist' });
    await expect(g.imageModels(o.id, false, signal())).rejects.toMatchObject({
      code: 'invalid_operation',
      message: 'This provider cannot generate images',
    });
  });

  it('does not cache an image list that belongs to an earlier build of the entry', async () => {
    const v = store.save(veniceInput());
    let release!: () => void;
    let answer = () =>
      new Promise<{ name: string }[]>((resolve) => (release = () => resolve([{ name: 'old' }])));
    const fakeImage = () => ({
      listEditModels: async () =>
        (await answer()).map((x) => ({ ...x, aspectRatios: null, resolutions: null, defaultResolution: null, promptCharacterLimit: null, price: null })),
      editImage: async () => {
        throw new Error('unused');
      },
      upscaleImage: async () => {
        throw new Error('unused');
      },
    });
    const g = createProviderGateway({ store, createVision: { ollama: createOllamaVision, openai: createOpenAiVision }, createImage: fakeImage, log: (l) => lines.push(l) });
    const pending = g.imageModels(v.id, false, signal());
    store.save(veniceInput({ id: v.id, timeoutSeconds: 200 }));
    release();
    await pending;
    answer = async () => [{ name: 'new' }];
    const next = await g.imageModels(v.id, false, signal());
    expect(next.ok && next.models.map((x) => x.name)).toEqual(['new']);
  });
});
