import { afterEach, describe, expect, it } from 'vitest';
import type { VisionRequestOptions } from '@assetforge/contracts';
import { MOCK_MODEL, startMockProvider, type MockProvider } from '../../../docker/mock-provider/server.mjs';
import { createOllamaVision } from '../src/index.js';

const image = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10, 0x7f, 0x80, 0xfe]);
const schema = {
  type: 'object',
  properties: { tags: { type: 'array', items: { type: 'string' } } },
  required: ['tags'],
};
const prompt = 'Describe the image as tags.';

let provider: MockProvider | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
});

async function sentBody(requestOptions: VisionRequestOptions | undefined, kind: 'tag' | 'describe') {
  provider = await startMockProvider({ port: 0 });
  const vision = createOllamaVision({ baseUrl: provider.url, ...(requestOptions ? { requestOptions } : {}) });
  const signal = new AbortController().signal;
  if (kind === 'tag') await vision.analyzeImage({ image, prompt, schema, model: MOCK_MODEL, signal });
  else await vision.describeImage({ image, prompt, model: MOCK_MODEL, signal });
  expect(provider.requests).toHaveLength(1);
  return provider.requests[0]!.body as Record<string, unknown>;
}

describe('ollama request options', () => {
  it('sends the same tagging body as before when no options are given', async () => {
    const body = await sentBody(undefined, 'tag');
    expect(Object.keys(body).sort()).toEqual(['format', 'messages', 'model', 'options', 'stream']);
    expect(body.options).toEqual({ temperature: 0 });
    expect(body.format).toEqual(schema);
    expect(body.stream).toBe(false);
  });

  it('sends the same describe body without format when no options are given', async () => {
    const body = await sentBody(undefined, 'describe');
    expect(Object.keys(body).sort()).toEqual(['messages', 'model', 'options', 'stream']);
    expect(body.options).toEqual({ temperature: 0 });
  });

  it('applies temperature, thinking, maxTokens and extra fields', async () => {
    const body = await sentBody(
      { temperature: 0.4, thinking: 'off', maxTokens: 300, extra: { keep_alive: '5m', options: { top_p: 0.8 } } },
      'tag',
    );
    expect(body.think).toBe(false);
    expect(body.keep_alive).toBe('5m');
    expect(body.options).toEqual({ temperature: 0.4, num_predict: 300, top_p: 0.8 });
    expect(body.format).toEqual(schema);
  });

  it('never lets extra override the model or stream', async () => {
    const body = await sentBody(
      { temperature: 0, thinking: 'default', maxTokens: null, extra: { model: 'evil', stream: true } },
      'describe',
    );
    expect(body.model).toBe(MOCK_MODEL);
    expect(body.stream).toBe(false);
  });
});
