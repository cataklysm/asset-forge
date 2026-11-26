import { describe, expect, test } from 'vitest';
import {
  ENVIRONMENT_PROVIDER_ID,
  ErrorCodeSchema,
  ListModelsResultSchema,
  MAX_PROVIDERS,
  PROVIDER_NAME_MAX,
  ProviderListSchema,
  ProviderNameSchema,
  ProviderViewSchema,
  SaveProviderSchema,
  VisionModelSchema,
  ipcContract,
} from '../src/index';

const uuid = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const save = { name: 'RunPod', baseUrl: 'http://127.0.0.1:11500', timeoutSeconds: 120, taggingModel: 'qwen', promptModel: null };
const view = { ...save, id: uuid, hasApiKey: false };

describe('provider entries', () => {
  test('the constants', () => {
    expect(ENVIRONMENT_PROVIDER_ID).toBe('environment');
    expect(PROVIDER_NAME_MAX).toBe(60);
    expect(MAX_PROVIDERS).toBe(10);
  });

  test('a provider name has 1 to 60 characters after trimming', () => {
    expect(ProviderNameSchema.parse('  RunPod ')).toBe('RunPod');
    expect(ProviderNameSchema.safeParse('   ').success).toBe(false);
    expect(ProviderNameSchema.safeParse('n'.repeat(60)).success).toBe(true);
    expect(ProviderNameSchema.safeParse('n'.repeat(61)).success).toBe(false);
  });

  test('a save request needs neither id nor API key', () => {
    expect(SaveProviderSchema.safeParse(save).success).toBe(true);
    expect(Object.hasOwn(SaveProviderSchema.parse(save), 'apiKey')).toBe(false);
    expect(SaveProviderSchema.safeParse({ ...save, id: uuid }).success).toBe(true);
    expect(SaveProviderSchema.safeParse({ ...save, id: 'environment' }).success).toBe(true);
    expect(SaveProviderSchema.safeParse({ ...save, id: 'x' }).success).toBe(false);
    expect(ipcContract['providers:save'].request.safeParse(save).success).toBe(true);
  });

  test('the API key may be absent, null or a string of 1 to 500 characters', () => {
    expect(SaveProviderSchema.safeParse({ ...save, apiKey: null }).success).toBe(true);
    expect(SaveProviderSchema.safeParse({ ...save, apiKey: 'test-key-not-real' }).success).toBe(true);
    expect(SaveProviderSchema.safeParse({ ...save, apiKey: 'k'.repeat(500) }).success).toBe(true);
    expect(SaveProviderSchema.safeParse({ ...save, apiKey: '' }).success).toBe(false);
    expect(SaveProviderSchema.safeParse({ ...save, apiKey: 'k'.repeat(501) }).success).toBe(false);
  });

  test('name and base URL are length-bounded; the host applies their rules', () => {
    expect(SaveProviderSchema.safeParse({ ...save, name: '' }).success).toBe(true);
    expect(SaveProviderSchema.safeParse({ ...save, name: 'n'.repeat(201) }).success).toBe(false);
    expect(SaveProviderSchema.safeParse({ ...save, baseUrl: 'u'.repeat(2001) }).success).toBe(false);
    expect(SaveProviderSchema.safeParse({ ...save, baseUrl: null }).success).toBe(false);
  });

  test('the timeout is 10 to 600 whole seconds', () => {
    for (const timeoutSeconds of [10, 600]) {
      expect(SaveProviderSchema.safeParse({ ...save, timeoutSeconds }).success).toBe(true);
    }
    for (const timeoutSeconds of [9, 601, 120.5]) {
      expect(SaveProviderSchema.safeParse({ ...save, timeoutSeconds }).success, String(timeoutSeconds)).toBe(false);
    }
  });

  test('models may be unset; an empty model name is refused', () => {
    expect(SaveProviderSchema.safeParse({ ...save, taggingModel: null }).success).toBe(true);
    expect(SaveProviderSchema.safeParse({ ...save, taggingModel: '' }).success).toBe(false);
  });

  test('the view tells whether a key is stored but never carries one', () => {
    expect(ProviderViewSchema.parse({ ...view, apiKey: 'test-key-not-real' })).toEqual(view);
    expect(ProviderViewSchema.safeParse({ ...view, timeoutSeconds: 9 }).success).toBe(false);
    expect(ProviderViewSchema.safeParse({ ...view, name: '' }).success).toBe(false);
  });

  test('the list holds at most 10 entries', () => {
    const list = (n: number) => ({
      providers: Array.from({ length: n }, () => view),
      lastUsedId: null,
      fromEnvironment: false,
      canStoreKey: true,
    });
    expect(ProviderListSchema.safeParse(list(0)).success).toBe(true);
    expect(ProviderListSchema.safeParse(list(10)).success).toBe(true);
    expect(ProviderListSchema.safeParse(list(11)).success).toBe(false);
    expect(ProviderListSchema.safeParse({ ...list(1), lastUsedId: 'environment' }).success).toBe(true);
    expect(ipcContract['providers:list'].response.safeParse(list(1)).success).toBe(true);
  });

  test('a model list is the models or a job error code', () => {
    expect(VisionModelSchema.safeParse({ name: 'qwen', vision: null }).success).toBe(true);
    expect(ListModelsResultSchema.safeParse({ ok: true, models: [{ name: 'qwen', vision: true }] }).success).toBe(true);
    expect(ListModelsResultSchema.safeParse({ ok: false, code: 'provider_unauthorized' }).success).toBe(true);
    expect(ListModelsResultSchema.safeParse({ ok: false, code: 'busy' }).success).toBe(false);
    const models = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `m${i}`, vision: null }));
    expect(ListModelsResultSchema.safeParse({ ok: true, models: models(100) }).success).toBe(true);
    expect(ListModelsResultSchema.safeParse({ ok: true, models: models(101) }).success).toBe(false);
  });

  test('provider channels replace the settings channels', () => {
    const channels = Object.keys(ipcContract);
    expect(channels).not.toContain('settings:getVision');
    expect(channels).not.toContain('settings:setVision');
    expect(channels).not.toContain('settings:listVisionModels');
    expect(ipcContract['providers:list'].request.safeParse({}).success).toBe(true);
    expect(ipcContract['providers:delete'].request.safeParse({ id: uuid }).success).toBe(true);
    expect(ipcContract['providers:delete'].request.safeParse({}).success).toBe(false);
    const listModels = ipcContract['providers:listModels'].request;
    expect(listModels.safeParse({ providerId: 'environment' }).success).toBe(true);
    expect(listModels.safeParse({ providerId: uuid, refresh: true }).success).toBe(true);
    expect(listModels.safeParse({}).success).toBe(false);
  });

  test('the credential store and provider configuration errors exist', () => {
    expect(ErrorCodeSchema.safeParse('credential_store_unavailable').success).toBe(true);
    expect(ErrorCodeSchema.safeParse('provider_not_configured').success).toBe(true);
  });
});
