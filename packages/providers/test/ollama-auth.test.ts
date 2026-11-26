import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { JobError } from '@assetforge/core';
import type { JobErrorCode } from '@assetforge/contracts';
import { MOCK_MODEL, startMockProvider, type MockProvider } from '../../../docker/mock-provider/server.mjs';
import { createOllamaVision } from '../src/index.js';

const KEY = 'test-key-not-real';
const image = new Uint8Array([1, 2, 3, 4]);
const schema = { type: 'object' };
const prompt = 'Tag the image.';
const signal = () => new AbortController().signal;

let provider: MockProvider | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
});

async function start(options?: Parameters<typeof startMockProvider>[0]): Promise<MockProvider> {
  provider = await startMockProvider({ port: 0, ...options });
  return provider;
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch stub that records every call and answers through `answer`. */
function recording(answer: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const call = { url: String(input), init: init ?? {} };
      calls.push(call);
      return answer(call);
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function authorizationOf(call: Call): string | null {
  return new Headers(call.init.headers).get('authorization');
}

/** Answers chat, tags and show like a minimal Ollama. */
function ollamaLike(call: Call): Response {
  if (call.url.endsWith('/api/tags')) return json(200, { models: [{ name: 'm1' }] });
  if (call.url.endsWith('/api/show')) return json(200, { capabilities: ['completion', 'vision'] });
  return json(200, { message: { role: 'assistant', content: '{"tags":["a"]}' } });
}

async function useAllThree(vision: ReturnType<typeof createOllamaVision>): Promise<void> {
  await vision.analyzeImage({ image, prompt, schema, model: 'm1', signal: signal() });
  await vision.describeImage({ image, prompt, model: 'm1', signal: signal() });
  await vision.listModels(signal());
}

describe('authentication', () => {
  it('sends the bearer key on chat, tags and show', async () => {
    const stub = recording(ollamaLike);
    await useAllThree(createOllamaVision({ baseUrl: 'http://127.0.0.1:1', apiKey: () => KEY, fetch: stub.fetch }));
    expect(stub.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/api/chat',
      '/api/chat',
      '/api/tags',
      '/api/show',
    ]);
    for (const call of stub.calls) expect(authorizationOf(call)).toBe(`Bearer ${KEY}`);
  });

  it.each([
    ['returns null', { apiKey: () => null }],
    ['is absent', {}],
  ])('sends no authorization header when the key provider %s', async (_name, options) => {
    const stub = recording(ollamaLike);
    await useAllThree(createOllamaVision({ baseUrl: 'http://127.0.0.1:1', fetch: stub.fetch, ...options }));
    expect(stub.calls).toHaveLength(4);
    for (const call of stub.calls) expect(authorizationOf(call)).toBeNull();
  });

  it('reads the key for every request', async () => {
    const stub = recording(ollamaLike);
    let key: string | null = KEY;
    const vision = createOllamaVision({ baseUrl: 'http://127.0.0.1:1', apiKey: () => key, fetch: stub.fetch });
    await vision.describeImage({ image, prompt, model: 'm1', signal: signal() });
    key = null;
    await vision.describeImage({ image, prompt, model: 'm1', signal: signal() });
    key = 'test-key-not-real-2';
    await vision.describeImage({ image, prompt, model: 'm1', signal: signal() });
    expect(stub.calls.map(authorizationOf)).toEqual([`Bearer ${KEY}`, null, 'Bearer test-key-not-real-2']);
  });

  it('sends the key to the in-process mock', async () => {
    const { url, requests } = await start({ apiKey: KEY });
    await createOllamaVision({ baseUrl: url, apiKey: () => KEY }).analyzeImage({
      image,
      prompt,
      schema,
      model: MOCK_MODEL,
      signal: signal(),
    });
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it.each([401, 403])('maps HTTP %i to provider_unauthorized and reports code and status only', async (status) => {
    const reports: unknown[][] = [];
    const stub = recording(() => json(status, { error: `bad key ${KEY}` }));
    const vision = createOllamaVision({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: () => KEY,
      fetch: stub.fetch,
      onFailure: (...args: unknown[]) => void reports.push(args),
    });
    const error = await failureOf(vision.analyzeImage({ image, prompt, schema, model: 'm1', signal: signal() }));
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe('provider_unauthorized');
    expect((error as JobError).message).not.toContain(KEY);
    expect(JSON.stringify(reports)).not.toContain(KEY);
    expect(reports).toEqual([['provider_unauthorized', status]]);
  });

  it('maps a missing key at the mock to provider_unauthorized', async () => {
    const { url } = await start({ apiKey: KEY });
    const error = await failureOf(
      createOllamaVision({ baseUrl: url }).analyzeImage({ image, prompt, schema, model: MOCK_MODEL, signal: signal() }),
    );
    expect((error as JobError).code).toBe('provider_unauthorized');
  });

  it('reports every failure once, with a null status when there was no answer', async () => {
    const reports: [JobErrorCode, number | null][] = [];
    const onFailure = (code: JobErrorCode, status: number | null) => void reports.push([code, status]);
    const unreachable = createOllamaVision({
      baseUrl: 'http://127.0.0.1:1',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
      onFailure,
    });
    await failureOf(unreachable.describeImage({ image, prompt, model: 'm1', signal: signal() }));
    const unavailable = createOllamaVision({
      baseUrl: 'http://127.0.0.1:1',
      fetch: async () => json(503, {}),
      onFailure,
    });
    await failureOf(unavailable.analyzeImage({ image, prompt, schema, model: 'm1', signal: signal() }));
    const tags = createOllamaVision({ baseUrl: 'http://127.0.0.1:1', fetch: async () => json(500, {}), onFailure });
    await failureOf(tags.listModels(signal()));
    const notJson = createOllamaVision({
      baseUrl: 'http://127.0.0.1:1',
      fetch: async () => json(200, { message: { content: 'not json' } }),
      onFailure,
    });
    await failureOf(notJson.analyzeImage({ image, prompt, schema, model: 'm1', signal: signal() }));
    expect(reports).toEqual([
      ['provider_unreachable', null],
      ['provider_unavailable', 503],
      ['provider_unavailable', 500],
      ['invalid_response', 200],
    ]);
  });

  it.each([
    ['a newline', 'test-key\nnot-real'],
    ['a NUL', 'test-key\0not-real'],
  ])('refuses a key with %s as provider_unauthorized without a cause and without a request', async (_name, key) => {
    const reports: unknown[][] = [];
    const stub = recording(ollamaLike);
    const vision = createOllamaVision({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: () => key,
      fetch: stub.fetch,
      onFailure: (...args: unknown[]) => void reports.push(args),
    });
    const error = await failureOf(vision.describeImage({ image, prompt, model: 'm1', signal: signal() }));
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe('provider_unauthorized');
    expect((error as JobError).cause).toBeUndefined();
    const shown = inspect(error, { depth: 10 });
    for (const part of [key, JSON.stringify(key), 'test-key', 'not-real']) expect(shown).not.toContain(part);
    expect(stub.calls).toHaveLength(0);
    expect(reports).toEqual([['provider_unauthorized', null]]);
  });

  it('keeps a network error that quotes the key out of the thrown error', async () => {
    const vision = createOllamaVision({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: () => KEY,
      fetch: async () => {
        throw new TypeError(`fetch failed: authorization Bearer ${KEY}`);
      },
    });
    const error = await failureOf(vision.describeImage({ image, prompt, model: 'm1', signal: signal() }));
    expect((error as JobError).code).toBe('provider_unreachable');
    expect(inspect(error, { depth: 10 })).not.toContain(KEY);
  });

  it('does not report a caller abort', async () => {
    const reports: unknown[] = [];
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const vision = createOllamaVision({
      baseUrl: 'http://127.0.0.1:1',
      fetch: async (_input, init) => {
        controller.abort(reason);
        throw init?.signal?.reason;
      },
      onFailure: (...args) => void reports.push(args),
    });
    const error = await failureOf(vision.describeImage({ image, prompt, model: 'm1', signal: controller.signal }));
    expect(error).toBe(reason);
    expect(reports).toEqual([]);
  });
});

describe('describeImage', () => {
  it('sends the model, no format, and returns the content as text', async () => {
    const stub = recording(() => json(200, { message: { role: 'assistant', content: 'A wooden chair.' } }));
    const vision = createOllamaVision({ baseUrl: 'http://127.0.0.1:1/', fetch: stub.fetch });
    const text = await vision.describeImage({ image, prompt, model: 'qwen-test', signal: signal() });
    expect(text).toBe('A wooden chair.');
    expect(stub.calls[0]?.url).toBe('http://127.0.0.1:1/api/chat');
    expect(stub.calls[0]?.init.method).toBe('POST');
    expect(stub.calls[0]?.init.redirect).toBe('manual');
    const body = JSON.parse(String(stub.calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('format');
    expect(body).not.toHaveProperty('think');
    expect(body).toMatchObject({ model: 'qwen-test', stream: false, options: { temperature: 0 } });
    const messages = body.messages as { role: string; content: string; images: string[] }[];
    expect(messages).toEqual([{ role: 'user', content: prompt, images: [Buffer.from(image).toString('base64')] }]);
  });

  it.each([
    ['missing content', { message: { role: 'assistant' } }],
    ['non-string content', { message: { content: { text: 'x' } } }],
    ['no message', { done: true }],
  ])('maps %s to invalid_response', async (_name, body) => {
    const vision = createOllamaVision({ baseUrl: 'http://127.0.0.1:1', fetch: async () => json(200, body) });
    const error = await failureOf(vision.describeImage({ image, prompt, model: 'm1', signal: signal() }));
    expect((error as JobError).code).toBe('invalid_response');
  });

  it('answers the mock in plain text', async () => {
    const { url } = await start();
    const text = await createOllamaVision({ baseUrl: url }).describeImage({
      image,
      prompt,
      model: MOCK_MODEL,
      signal: signal(),
    });
    expect(text.length).toBeGreaterThan(0);
    expect(() => JSON.parse(text) as unknown).toThrow();
  });
});

describe('analyzeImage', () => {
  it('sends the model of the call', async () => {
    const stub = recording(ollamaLike);
    const vision = createOllamaVision({ baseUrl: 'http://127.0.0.1:1', fetch: stub.fetch });
    await vision.analyzeImage({ image, prompt, schema, model: 'first', signal: signal() });
    await vision.analyzeImage({ image, prompt, schema, model: 'second', signal: signal() });
    const models = stub.calls.map((call) => (JSON.parse(String(call.init.body)) as { model: string }).model);
    expect(models).toEqual(['first', 'second']);
    const body = JSON.parse(String(stub.calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.format).toEqual(schema);
    expect(body).not.toHaveProperty('think');
  });
});
