import { describe, expect, it } from 'vitest';
import type { VisionRequestOptions } from '@assetforge/contracts';
import { composeBody, DEFAULT_REQUEST_OPTIONS, ollamaFixedFields, openAiFixedFields } from '../src/index.js';

const with_ = (o: Partial<VisionRequestOptions>): VisionRequestOptions => ({ ...DEFAULT_REQUEST_OPTIONS, ...o });

describe('DEFAULT_REQUEST_OPTIONS', () => {
  it('is temperature 0, default thinking, no length limit, no extra fields', () => {
    expect(DEFAULT_REQUEST_OPTIONS).toEqual({ temperature: 0, thinking: 'default', maxTokens: null, extra: {} });
  });
});

describe('ollamaFixedFields', () => {
  it('maps the defaults to options.temperature 0 only', () => {
    expect(ollamaFixedFields(DEFAULT_REQUEST_OPTIONS)).toEqual({ options: { temperature: 0 } });
  });

  it('maps temperature and maxTokens into options', () => {
    expect(ollamaFixedFields(with_({ temperature: 0.7, maxTokens: 512 }))).toEqual({
      options: { temperature: 0.7, num_predict: 512 },
    });
  });

  it('maps thinking off and on to think, default to no think key', () => {
    expect(ollamaFixedFields(with_({ thinking: 'off' }))).toEqual({ options: { temperature: 0 }, think: false });
    expect(ollamaFixedFields(with_({ thinking: 'on' }))).toEqual({ options: { temperature: 0 }, think: true });
    expect(Object.hasOwn(ollamaFixedFields(with_({ thinking: 'default' })), 'think')).toBe(false);
  });
});

describe('openAiFixedFields', () => {
  it('maps the defaults to temperature 0 only', () => {
    expect(openAiFixedFields(DEFAULT_REQUEST_OPTIONS)).toEqual({ temperature: 0 });
  });

  it('maps maxTokens to max_tokens', () => {
    expect(openAiFixedFields(with_({ maxTokens: 512 }))).toEqual({ temperature: 0, max_tokens: 512 });
  });

  it('maps thinking off and on to chat_template_kwargs, default to no such key', () => {
    expect(openAiFixedFields(with_({ thinking: 'off' }))).toEqual({
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(openAiFixedFields(with_({ thinking: 'on' }))).toEqual({
      temperature: 0,
      chat_template_kwargs: { enable_thinking: true },
    });
    expect(Object.hasOwn(openAiFixedFields(with_({ thinking: 'default' })), 'chat_template_kwargs')).toBe(false);
  });
});

describe('composeBody', () => {
  it('lets extra replace a fixed scalar', () => {
    expect(composeBody({ temperature: 0 }, { temperature: 0.9 }, {}, [])).toEqual({ temperature: 0.9 });
  });

  it('merges an object under a deep key one level deep', () => {
    const fixed = { options: { temperature: 0 } };
    expect(composeBody(fixed, { options: { top_p: 0.9 } }, {}, ['options'])).toEqual({
      options: { temperature: 0, top_p: 0.9 },
    });
    expect(composeBody(fixed, { options: { temperature: 1 } }, {}, ['options'])).toEqual({
      options: { temperature: 1 },
    });
  });

  it('replaces a deep key when extra carries a non-object there', () => {
    expect(composeBody({ options: { temperature: 0 } }, { options: 5 }, {}, ['options'])).toEqual({ options: 5 });
    expect(composeBody({ options: { temperature: 0 } }, { options: [1] }, {}, ['options'])).toEqual({ options: [1] });
  });

  it('replaces an object under a key that is not deep', () => {
    expect(composeBody({ options: { temperature: 0 } }, { options: { top_p: 0.9 } }, {}, [])).toEqual({
      options: { top_p: 0.9 },
    });
  });

  it('lets the own fields win over an extra that carries them', () => {
    const own = { model: 'm', stream: false, messages: [{ role: 'user' }], format: { type: 'object' } };
    const extra = { model: 'evil', stream: true, messages: [], format: 'json', keep_alive: '5m' };
    expect(composeBody({ options: { temperature: 0 } }, extra, own, ['options'])).toEqual({
      options: { temperature: 0 },
      keep_alive: '5m',
      ...own,
    });
  });

  it('does not change its arguments', () => {
    const fixed = { options: { temperature: 0 } };
    composeBody(fixed, { options: { top_p: 0.9 } }, {}, ['options']);
    expect(fixed).toEqual({ options: { temperature: 0 } });
  });
});
