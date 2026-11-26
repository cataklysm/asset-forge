import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IpcChannel } from '@assetforge/contracts';
import { MOCK_MODEL, startMockProvider, type MockProvider } from '../../../docker/mock-provider/server.mjs';
import { PROVIDER_SETTINGS_FILE } from '../src/main/vision-settings.js';
import { createHarness, TEST_KEY, type Harness } from './analysis-harness.js';

const uuid = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';
const EMPTY_SETTINGS = { baseUrl: null, timeoutSeconds: 120, taggingModel: null, promptModel: null };

let h: Harness | undefined;
let mock: MockProvider | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
  await mock?.close();
  mock = undefined;
});

describe('settings IPC', () => {
  it('reads and saves the settings without an open workspace', async () => {
    h = await createHarness();
    expect(await h.ok('settings:getVision', {})).toEqual({ ...EMPTY_SETTINGS, hasApiKey: false, fromEnvironment: false, canStoreKey: true });
    const saved = await h.ok('settings:setVision', {
      baseUrl: '  http://127.0.0.1:9/  ',
      timeoutSeconds: 60,
      taggingModel: 'tagger',
      promptModel: null,
      apiKey: TEST_KEY,
    });
    expect(saved).toEqual({
      baseUrl: 'http://127.0.0.1:9',
      timeoutSeconds: 60,
      taggingModel: 'tagger',
      promptModel: null,
      hasApiKey: true,
      fromEnvironment: false,
      canStoreKey: true,
    });
    expect(await h.ok('settings:getVision', {})).toEqual(saved);
    expect(await readFile(join(h.userData, PROVIDER_SETTINGS_FILE), 'utf8')).not.toContain(TEST_KEY);

    // A blank base URL is saved as not configured.
    expect(await h.ok('settings:setVision', { ...EMPTY_SETTINGS, baseUrl: '   ' })).toMatchObject({ baseUrl: null, hasApiKey: false });
    for (const response of h.responses) expect(response).not.toContain(TEST_KEY);
  });

  it('refuses an unusable base URL with invalid_operation', async () => {
    h = await createHarness();
    for (const baseUrl of ['nonsense', 'file:///x', 'http://user:pw@127.0.0.1:9', 'http://127.0.0.1:9/?q=1', 'http://127.0.0.1:9/#x']) {
      expect(await h.call('settings:setVision', { ...EMPTY_SETTINGS, baseUrl }), baseUrl).toMatchObject({
        ok: false,
        error: { code: 'invalid_operation' },
      });
    }
    expect((await h.ok('settings:getVision', {})).baseUrl).toBeNull();
  });

  it('lists the models: not configured, from the mock, and the code of a refused key without logging', async () => {
    h = await createHarness();
    expect(await h.ok('settings:listVisionModels', {})).toEqual({ ok: false, code: 'provider_not_configured' });

    mock = await startMockProvider({ port: 0, apiKey: TEST_KEY });
    await h.ok('settings:setVision', { ...EMPTY_SETTINGS, baseUrl: mock.url, apiKey: TEST_KEY });
    const listed = await h.ok('settings:listVisionModels', {});
    expect(listed.ok).toBe(true);
    expect(listed.ok && listed.models).toContainEqual({ name: MOCK_MODEL, vision: true });

    await h.ok('settings:setVision', { ...EMPTY_SETTINGS, baseUrl: mock.url, apiKey: 'wrong-key-not-real' });
    expect(await h.ok('settings:listVisionModels', { refresh: true })).toEqual({ ok: false, code: 'provider_unauthorized' });
    expect(h.logs).toEqual(['Vision provider failed: provider_unauthorized (HTTP 401)']);
    for (const response of h.responses) {
      expect(response).not.toContain(TEST_KEY);
      expect(response).not.toContain('wrong-key-not-real');
    }
  });

  it('shows the environment read-only, with the default timeout and no key', async () => {
    h = await createHarness({ env: { ASSETFORGE_VISION_BASE_URL: 'http://127.0.0.1:9/', ASSETFORGE_VISION_MODEL: 'env-model' } });
    expect(await h.ok('settings:getVision', {})).toEqual({
      baseUrl: 'http://127.0.0.1:9',
      timeoutSeconds: 120,
      taggingModel: 'env-model',
      promptModel: 'env-model',
      hasApiKey: false,
      fromEnvironment: true,
      canStoreKey: true,
    });
    expect(await h.call('settings:setVision', EMPTY_SETTINGS)).toMatchObject({ ok: false, error: { code: 'invalid_operation' } });
  });

  it('answers no_workspace_open on the analysis channels without a workspace', async () => {
    h = await createHarness();
    const requests: [IpcChannel, unknown][] = [
      ['analysis:preview', { target: { kind: 'files', fileIds: [uuid] }, model: MOCK_MODEL }],
      ['analysis:enqueue', { target: { kind: 'files', fileIds: [uuid] }, model: MOCK_MODEL, mode: 'apply', force: false }],
      ['analysis:getProposal', { fileId: uuid }],
      ['analysis:acceptProposal', { fileId: uuid, names: ['red car'] }],
      ['analysis:discardProposal', { fileId: uuid }],
      ['analysis:describe', { requestId: uuid, fileId: uuid, model: MOCK_MODEL }],
      ['analysis:cancelDescribe', { requestId: uuid }],
    ];
    for (const [channel, request] of requests) {
      expect(await h.call(channel, request), channel).toMatchObject({ ok: false, error: { code: 'no_workspace_open' } });
    }
  });

  it('resumes a paused queue when the settings are saved', async () => {
    h = await createHarness();
    await h.ok('workspace:create', { name: 'Settings', rootPath: join(h.base, 'workspace') });
    const fileIds = await h.importImages(2);
    await h.ok('analysis:enqueue', { target: { kind: 'files', fileIds }, model: MOCK_MODEL, mode: 'apply', force: false });
    await h.until((s) => s.paused?.reason === 'provider_not_configured');

    mock = await startMockProvider({ port: 0 });
    await h.ok('settings:setVision', { ...EMPTY_SETTINGS, baseUrl: mock.url });
    expect((await h.ok('jobs:summary', {})).paused).toBeNull();
    await h.until((s) => s.succeeded === 1 && s.queued === 0);
  });
});
