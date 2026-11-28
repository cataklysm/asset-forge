import { describe, expect, test } from 'vitest';
import {
  DEFAULT_PROVIDER_OPTIONS,
  PARALLEL_REQUESTS_DEFAULT,
  PARALLEL_REQUESTS_MAX,
  PARALLEL_REQUESTS_MIN,
  PROVIDER_EXTRA_MAX,
  ProviderOptionsSchema,
  ProviderViewSchema,
  RESERVED_EXTRA_KEYS,
  SaveProviderSchema,
  extraParametersMessage,
  isVisionKind,
  parseExtraParameters,
  purposeOf,
} from '../src/index';

const uuid = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const save = {
  name: 'vLLM',
  baseUrl: 'http://127.0.0.1:11500/v1',
  timeoutSeconds: 120,
  taggingModel: 'qwen',
  promptModel: null,
};
const view = {
  ...save,
  id: uuid,
  kind: 'openai',
  editModel: null,
  hasApiKey: false,
  options: DEFAULT_PROVIDER_OPTIONS,
};

describe('kinds and purposes', () => {
  test('ollama and openai analyse, venice makes images', () => {
    expect(purposeOf('ollama')).toBe('vision');
    expect(purposeOf('openai')).toBe('vision');
    expect(purposeOf('venice')).toBe('image');
  });

  test('the vision kinds are ollama and openai', () => {
    expect(isVisionKind('ollama')).toBe(true);
    expect(isVisionKind('openai')).toBe(true);
    expect(isVisionKind('venice')).toBe(false);
  });
});

describe('request options', () => {
  test('the defaults', () => {
    expect(DEFAULT_PROVIDER_OPTIONS).toEqual({
      temperature: 0,
      thinking: 'default',
      maxTokens: null,
      extra: '',
      parallelRequests: 1,
      structuredOutput: true,
    });
    expect(ProviderOptionsSchema.safeParse(DEFAULT_PROVIDER_OPTIONS).success).toBe(true);
    expect(PROVIDER_EXTRA_MAX).toBe(4000);
  });

  test('the bounds', () => {
    const ok = (patch: object) => ProviderOptionsSchema.safeParse({ ...DEFAULT_PROVIDER_OPTIONS, ...patch }).success;
    expect(ok({ temperature: 2, thinking: 'on', maxTokens: 100_000, extra: 'x'.repeat(4000) })).toBe(true);
    expect(ok({ thinking: 'off', maxTokens: 1 })).toBe(true);
    for (const temperature of [-0.1, 2.1]) expect(ok({ temperature }), String(temperature)).toBe(false);
    for (const maxTokens of [0, 1.5, 100_001]) expect(ok({ maxTokens }), String(maxTokens)).toBe(false);
    expect(ok({ extra: 'x'.repeat(4001) })).toBe(false);
    expect(ok({ thinking: 'auto' })).toBe(false);
  });

  test('parallel requests are an integer from 1 to 64, default 1', () => {
    expect(PARALLEL_REQUESTS_MIN).toBe(1);
    expect(PARALLEL_REQUESTS_MAX).toBe(64);
    expect(PARALLEL_REQUESTS_DEFAULT).toBe(1);
    const ok = (parallelRequests: unknown) =>
      ProviderOptionsSchema.safeParse({ ...DEFAULT_PROVIDER_OPTIONS, parallelRequests }).success;
    for (const value of [1, 8, 64]) expect(ok(value), String(value)).toBe(true);
    for (const value of [0, 65, 1.5, -1, Number.NaN, '4', null]) expect(ok(value), String(value)).toBe(false);
    const { parallelRequests: _p, ...without } = DEFAULT_PROVIDER_OPTIONS;
    expect(ProviderOptionsSchema.safeParse(without).success).toBe(false);
  });

  test('structured output is a boolean and required', () => {
    const ok = (structuredOutput: unknown) =>
      ProviderOptionsSchema.safeParse({ ...DEFAULT_PROVIDER_OPTIONS, structuredOutput }).success;
    expect(ok(false)).toBe(true);
    for (const value of ['true', 1, null]) expect(ok(value), String(value)).toBe(false);
    const { structuredOutput: _s, ...without } = DEFAULT_PROVIDER_OPTIONS;
    expect(ProviderOptionsSchema.safeParse(without).success).toBe(false);
  });
});

describe('extra parameters', () => {
  test('empty or blank text is an empty object', () => {
    expect(parseExtraParameters('', 'ollama')).toEqual({ ok: true, value: {} });
    expect(parseExtraParameters('  \n', 'openai')).toEqual({ ok: true, value: {} });
  });

  test('the text must parse as a plain JSON object', () => {
    for (const text of ['[1]', 'null', '3', '"x"']) {
      expect(parseExtraParameters(text, 'ollama'), text).toEqual({ ok: false, reason: 'not_object' });
    }
    expect(parseExtraParameters('{', 'openai')).toEqual({ ok: false, reason: 'not_json' });
    expect(parseExtraParameters('{"top_p":0.9}', 'openai')).toEqual({ ok: true, value: { top_p: 0.9 } });
  });

  test('every reserved key is refused for its kind', () => {
    expect(RESERVED_EXTRA_KEYS.ollama).toEqual(['model', 'messages', 'stream', 'format']);
    expect(RESERVED_EXTRA_KEYS.openai).toEqual([
      'model',
      'messages',
      'stream',
      'response_format',
      'n',
      'tools',
      'tool_choice',
    ]);
    for (const kind of ['ollama', 'openai'] as const) {
      for (const key of RESERVED_EXTRA_KEYS[kind]) {
        expect(parseExtraParameters(JSON.stringify({ [key]: 1 }), kind), `${kind} ${key}`).toEqual({
          ok: false,
          reason: 'reserved',
          key,
        });
      }
    }
  });

  test('the first reserved key in list order is named', () => {
    expect(parseExtraParameters('{"stream":true,"model":"x"}', 'ollama')).toEqual({
      ok: false,
      reason: 'reserved',
      key: 'model',
    });
  });

  test('keys reserved only for the other kind and nested keys are allowed', () => {
    expect(parseExtraParameters('{"format":1}', 'openai')).toEqual({ ok: true, value: { format: 1 } });
    expect(parseExtraParameters('{"response_format":1}', 'ollama')).toEqual({
      ok: true,
      value: { response_format: 1 },
    });
    expect(parseExtraParameters('{"options":{"model":"x"}}', 'ollama')).toEqual({
      ok: true,
      value: { options: { model: 'x' } },
    });
  });

  test('the fixed messages', () => {
    expect(extraParametersMessage({ ok: false, reason: 'not_json' })).toBe(
      'The extra parameters are not a JSON object',
    );
    expect(extraParametersMessage({ ok: false, reason: 'not_object' })).toBe(
      'The extra parameters are not a JSON object',
    );
    expect(extraParametersMessage({ ok: false, reason: 'reserved', key: 'tool_choice' })).toBe(
      'The extra parameters must not set tool_choice',
    );
  });
});

describe('options on the view and the save request', () => {
  test('a view carries options or null', () => {
    expect(ProviderViewSchema.safeParse(view).success).toBe(true);
    expect(ProviderViewSchema.safeParse({ ...view, kind: 'venice', options: null }).success).toBe(true);
    const { options: _options, ...withoutOptions } = view;
    expect(ProviderViewSchema.safeParse(withoutOptions).success).toBe(false);
  });

  test('a save request may leave options out', () => {
    expect(SaveProviderSchema.safeParse(save).success).toBe(true);
    expect(SaveProviderSchema.safeParse({ ...save, kind: 'openai', options: DEFAULT_PROVIDER_OPTIONS }).success).toBe(
      true,
    );
    expect(
      SaveProviderSchema.safeParse({ ...save, options: { ...DEFAULT_PROVIDER_OPTIONS, temperature: 3 } }).success,
    ).toBe(false);
  });
});
