import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { JobError } from '@assetforge/core';
import type { JobErrorCode } from '@assetforge/contracts';
import { MOCK_MODEL, startMockProvider, type MockFailure, type MockProvider } from '../../../docker/mock-provider/server.mjs';
import { createOllamaVision, OLLAMA_PROVIDER } from '../src/index.js';

const image = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10, 0x7f, 0x80, 0xfe]);
const schema = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } }, required: ['tags'] };
const prompt = 'Describe the image as tags.';

let provider: MockProvider | undefined;

async function start(failures?: MockFailure[]): Promise<MockProvider> {
  provider = await startMockProvider({ port: 0, failures });
  return provider;
}

afterEach(async () => {
  await provider?.close();
  provider = undefined;
});

function analyze(options: Parameters<typeof createOllamaVision>[0], signal = new AbortController().signal) {
  return createOllamaVision(options).analyzeImage({ image, prompt, schema, signal });
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

async function expectCode(promise: Promise<unknown>, code: JobErrorCode, baseUrl: string): Promise<void> {
  const error = await failureOf(promise);
  expect(error).toBeInstanceOf(JobError);
  expect((error as JobError).code).toBe(code);
  expect((error as JobError).message).not.toContain(baseUrl);
}

function answering(status: number, body: string): typeof fetch {
  return async () => new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

describe('ollama vision adapter', () => {
  it('names its provider', () => {
    expect(OLLAMA_PROVIDER).toBe('ollama');
  });

  it('sends the chat request Ollama expects, without authentication', async () => {
    const { url, requests } = await start();
    await analyze({ baseUrl: url, model: MOCK_MODEL });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request).toMatchObject({ method: 'POST', path: '/api/chat' });
    expect(request.headers.authorization).toBeUndefined();
    const body = request.body as {
      model: string;
      stream: boolean;
      format: unknown;
      options: { temperature: number };
      messages: { role: string; content: string; images: string[] }[];
    };
    expect(body.model).toBe(MOCK_MODEL);
    expect(body.stream).toBe(false);
    expect(body.format).toEqual(schema);
    expect(body.options.temperature).toBe(0);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ role: 'user', content: prompt });
    expect(body.messages[0]!.images).toHaveLength(1);
    expect(new Uint8Array(Buffer.from(body.messages[0]!.images[0]!, 'base64'))).toEqual(image);
  });

  it('accepts a base URL with a trailing slash', async () => {
    const { url, requests } = await start();
    await analyze({ baseUrl: `${url}/`, model: MOCK_MODEL });
    expect(requests[0]?.path).toBe('/api/chat');
  });

  it('returns the parsed content', async () => {
    const { url } = await start();
    const result = (await analyze({ baseUrl: url, model: MOCK_MODEL })) as { tags: string[] };
    expect(result.tags).toHaveLength(8);
    expect(result.tags.every((tag) => typeof tag === 'string')).toBe(true);
  });

  it.each([503, 429])('maps HTTP %i to provider_unavailable', async (status) => {
    const { url } = await start([status]);
    await expectCode(analyze({ baseUrl: url, model: MOCK_MODEL }), 'provider_unavailable', url);
  });

  it('maps HTTP 400 to provider_rejected', async () => {
    const { url } = await start([400]);
    await expectCode(analyze({ baseUrl: url, model: MOCK_MODEL }), 'provider_rejected', url);
  });

  it('maps an unknown model (404) to provider_rejected', async () => {
    const { url } = await start();
    await expectCode(analyze({ baseUrl: url, model: 'other-model' }), 'provider_rejected', url);
  });

  it('maps content that is not JSON to invalid_response', async () => {
    const { url } = await start(['invalid']);
    await expectCode(analyze({ baseUrl: url, model: MOCK_MODEL }), 'invalid_response', url);
  });

  it('maps a body without message content to invalid_response', async () => {
    const baseUrl = 'http://127.0.0.1:1';
    await expectCode(
      analyze({ baseUrl, model: MOCK_MODEL, fetch: answering(200, '{ "error": "x" }') }),
      'invalid_response',
      baseUrl,
    );
  });

  it('maps a body that is not JSON to invalid_response', async () => {
    const baseUrl = 'http://127.0.0.1:1';
    await expectCode(
      analyze({ baseUrl, model: MOCK_MODEL, fetch: answering(200, '<html>') }),
      'invalid_response',
      baseUrl,
    );
  });

  it('maps a closed port to provider_unreachable', async () => {
    const url = await closedPortUrl();
    await expectCode(analyze({ baseUrl: url, model: MOCK_MODEL }), 'provider_unreachable', url);
  });

  it('maps a missing answer to provider_timeout', async () => {
    const { url } = await start(['hang']);
    await expectCode(analyze({ baseUrl: url, model: MOCK_MODEL, timeoutMs: 50 }), 'provider_timeout', url);
  });

  it('rethrows the caller abort, not a job error', async () => {
    const { url } = await start(['hang']);
    const controller = new AbortController();
    const reason = new Error('cancelled by caller');
    setTimeout(() => controller.abort(reason), 20);
    const error = await failureOf(analyze({ baseUrl: url, model: MOCK_MODEL }, controller.signal));
    expect(error).not.toBeInstanceOf(JobError);
    expect(error).toBe(reason);
  });
});
