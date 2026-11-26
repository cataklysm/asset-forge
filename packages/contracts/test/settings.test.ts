import { describe, expect, test } from 'vitest';
import {
  ErrorCodeSchema,
  ListModelsResultSchema,
  SetVisionSettingsSchema,
  VisionModelSchema,
  VisionSettingsViewSchema,
  ipcContract,
} from '../src/index';

const settings = { baseUrl: 'http://127.0.0.1:11500', timeoutSeconds: 120, taggingModel: 'qwen', promptModel: null };

describe('vision settings', () => {
  test('the API key may be absent, null or a string of 1 to 500 characters', () => {
    expect(SetVisionSettingsSchema.safeParse(settings).success).toBe(true);
    expect(SetVisionSettingsSchema.safeParse({ ...settings, apiKey: null }).success).toBe(true);
    expect(SetVisionSettingsSchema.safeParse({ ...settings, apiKey: 'test-key-not-real' }).success).toBe(true);
    expect(SetVisionSettingsSchema.safeParse({ ...settings, apiKey: 'k'.repeat(500) }).success).toBe(true);
    expect(SetVisionSettingsSchema.safeParse({ ...settings, apiKey: '' }).success).toBe(false);
    expect(SetVisionSettingsSchema.safeParse({ ...settings, apiKey: 'k'.repeat(501) }).success).toBe(false);
  });

  test('an absent key stays absent after parsing', () => {
    const parsed = SetVisionSettingsSchema.parse(settings);
    expect(Object.hasOwn(parsed, 'apiKey')).toBe(false);
  });

  test('the timeout is 10 to 600 whole seconds', () => {
    for (const timeoutSeconds of [10, 600]) {
      expect(SetVisionSettingsSchema.safeParse({ ...settings, timeoutSeconds }).success).toBe(true);
    }
    for (const timeoutSeconds of [9, 601, 120.5]) {
      expect(SetVisionSettingsSchema.safeParse({ ...settings, timeoutSeconds }).success, String(timeoutSeconds)).toBe(false);
    }
  });

  test('base URL and models may be unset; an empty model name is refused', () => {
    expect(SetVisionSettingsSchema.safeParse({ ...settings, baseUrl: null, taggingModel: null }).success).toBe(true);
    expect(SetVisionSettingsSchema.safeParse({ ...settings, taggingModel: '' }).success).toBe(false);
  });

  test('the view tells whether a key is stored but never carries one', () => {
    const view = { ...settings, hasApiKey: true, fromEnvironment: false, canStoreKey: true };
    expect(VisionSettingsViewSchema.parse({ ...view, apiKey: 'test-key-not-real' })).toEqual(view);
    expect(VisionSettingsViewSchema.safeParse({ ...view, timeoutSeconds: 9 }).success).toBe(false);
  });

  test('a model list is the models or a job error code', () => {
    expect(VisionModelSchema.safeParse({ name: 'qwen', vision: null }).success).toBe(true);
    expect(ListModelsResultSchema.safeParse({ ok: true, models: [{ name: 'qwen', vision: true }] }).success).toBe(true);
    expect(ListModelsResultSchema.safeParse({ ok: false, code: 'provider_unauthorized' }).success).toBe(true);
    expect(ListModelsResultSchema.safeParse({ ok: false, code: 'busy' }).success).toBe(false);
  });

  test('settings channels and the credential store error exist', () => {
    expect(ipcContract['settings:listVisionModels'].request.safeParse({}).success).toBe(true);
    expect(ipcContract['settings:listVisionModels'].request.safeParse({ refresh: true }).success).toBe(true);
    expect(ipcContract['settings:setVision'].request.safeParse({ ...settings, apiKey: null }).success).toBe(true);
    expect(ErrorCodeSchema.safeParse('credential_store_unavailable').success).toBe(true);
  });
});
