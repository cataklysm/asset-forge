import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcChannel, IpcRequest, IpcResponse, IpcResult } from '@assetforge/contracts';
import { createOllamaVision } from '@assetforge/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MOCK_MODEL, startMockProvider, type MockProvider } from '../../../docker/mock-provider/server.mjs';
import { dispatch, type IpcHandlers } from '../src/main/ipc.js';
import { createProviderGateway } from '../src/main/provider-gateway.js';
import { createProviderHandlers } from '../src/main/provider-handlers.js';
import { createProviderStore, PROVIDER_SETTINGS_FILE } from '../src/main/provider-store.js';
import { FakeCodec } from './fake-codec.js';

const KEY = 'test-key-not-real';
const UNKNOWN = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';

let dir: string;
let mock: MockProvider | undefined;
let responses: string[];
let lines: string[];
let activeJobs: Set<string>;
let guardCalls: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-provider-ipc-'));
  responses = [];
  lines = [];
  activeJobs = new Set();
  guardCalls = [];
});
afterEach(async () => {
  await mock?.close();
  mock = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** The provider handlers alone, behind the IPC validation; there is no workspace manager at all. */
function harness(env: NodeJS.ProcessEnv = {}) {
  const store = createProviderStore({ userData: dir, secrets: new FakeCodec(), env });
  const gateway = createProviderGateway({ store, create: createOllamaVision, log: (l) => lines.push(l) });
  const handlers = createProviderHandlers(store, gateway, {
    hasActiveJobs: async (id) => {
      guardCalls.push(id);
      return activeJobs.has(id);
    },
  });
  const call = async (channel: IpcChannel, request: unknown): Promise<IpcResult<unknown>> => {
    const result = await dispatch(handlers as unknown as IpcHandlers, channel, request);
    responses.push(JSON.stringify(result));
    return result;
  };
  const ok = async <C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> => {
    const result = await call(channel, request);
    if (!result.ok) throw new Error(`${channel} failed: ${result.error.code}`);
    return result.value as IpcResponse<C>;
  };
  return { store, call, ok };
}

const entry = (o: Partial<IpcRequest<'providers:save'>> = {}): IpcRequest<'providers:save'> => ({
  name: 'Local',
  baseUrl: 'http://127.0.0.1:9',
  timeoutSeconds: 60,
  taggingModel: 'tagger',
  promptModel: null,
  ...o,
});

describe('provider IPC', () => {
  it('lists, saves, lists models and deletes without a workspace', async () => {
    mock = await startMockProvider({ port: 0, apiKey: KEY });
    const h = harness();
    expect(await h.ok('providers:list', {})).toEqual({ providers: [], lastUsedId: null, fromEnvironment: false, canStoreKey: true });
    const saved = await h.ok('providers:save', entry({ name: '  Pod  ', baseUrl: `  ${mock.url}/  `, apiKey: KEY }));
    expect(saved).toEqual({
      id: expect.any(String),
      name: 'Pod',
      baseUrl: mock.url,
      timeoutSeconds: 60,
      taggingModel: 'tagger',
      promptModel: null,
      hasApiKey: true,
    });
    expect((await h.ok('providers:list', {})).providers).toEqual([saved]);
    const listed = await h.ok('providers:listModels', { providerId: saved.id });
    expect(listed.ok && listed.models).toContainEqual({ name: MOCK_MODEL, vision: true });
    expect(await h.ok('providers:delete', { id: saved.id })).toEqual({});
    expect(guardCalls).toEqual([saved.id]);
    expect((await h.ok('providers:list', {})).providers).toEqual([]);
    expect(await readFile(join(dir, PROVIDER_SETTINGS_FILE), 'utf8')).not.toContain(KEY);
    for (const response of responses) expect(response).not.toContain(KEY);
  });

  it('refuses to delete an entry with active jobs and keeps it', async () => {
    const h = harness();
    const saved = await h.ok('providers:save', entry());
    activeJobs.add(saved.id);
    expect(await h.call('providers:delete', { id: saved.id })).toEqual({
      ok: false,
      error: { code: 'invalid_operation', message: 'This provider still has active jobs; move or cancel them first' },
    });
    expect((await h.ok('providers:list', {})).providers.map((p) => p.id)).toEqual([saved.id]);
  });

  it('answers not_found for an unknown id on delete and listModels', async () => {
    const h = harness();
    expect(await h.call('providers:delete', { id: UNKNOWN })).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'This provider does not exist' },
    });
    expect(await h.call('providers:listModels', { providerId: UNKNOWN })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(guardCalls).toEqual([]);
  });

  it('validates the requests', async () => {
    const h = harness();
    expect(await h.call('providers:save', entry({ timeoutSeconds: 5 }))).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await h.call('providers:save', entry({ id: 'not-a-uuid' }))).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await h.call('providers:delete', { id: 'x' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await h.call('providers:listModels', {})).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await h.call('providers:save', entry({ name: 'n'.repeat(61) }))).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect((await h.ok('providers:list', {})).providers).toEqual([]);
  });

  it('answers adapter failures as a code and logs them with the id only', async () => {
    mock = await startMockProvider({ port: 0, apiKey: KEY });
    const h = harness();
    const saved = await h.ok('providers:save', entry({ baseUrl: mock.url, apiKey: 'test-key-not-real-2' }));
    expect(await h.ok('providers:listModels', { providerId: saved.id, refresh: true })).toEqual({ ok: false, code: 'provider_unauthorized' });
    expect(lines).toEqual([`Vision provider ${saved.id} failed: provider_unauthorized (HTTP 401)`]);
    for (const response of responses) expect(response).not.toContain('test-key-not-real');
  });

  it('shows the environment entry read-only', async () => {
    const h = harness({ ASSETFORGE_VISION_BASE_URL: 'http://127.0.0.1:9/', ASSETFORGE_VISION_MODEL: 'env-model' });
    expect(await h.ok('providers:list', {})).toEqual({
      providers: [
        {
          id: 'environment',
          name: 'Environment',
          baseUrl: 'http://127.0.0.1:9',
          timeoutSeconds: 120,
          taggingModel: 'env-model',
          promptModel: 'env-model',
          hasApiKey: false,
        },
      ],
      lastUsedId: null,
      fromEnvironment: true,
      canStoreKey: true,
    });
    expect(await h.call('providers:save', entry())).toMatchObject({ ok: false, error: { code: 'invalid_operation' } });
    expect(await h.call('providers:delete', { id: 'environment' })).toMatchObject({ ok: false, error: { code: 'invalid_operation' } });
    expect(guardCalls).toEqual([]);
  });
});
