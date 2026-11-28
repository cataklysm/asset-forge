import { afterEach, describe, expect, it } from 'vitest';
import { JobError } from '@assetforge/core';
import type { JobErrorCode } from '@assetforge/contracts';
import {
  MOCK_MODEL,
  mockImageDigest,
  startMockProvider,
  type MockFailure,
  type MockProvider,
} from '../../../docker/mock-provider/server.mjs';
import { createOllamaVision, OLLAMA_PROVIDER } from '../src/index.js';
import { refusedUrl, releaseRefusedPorts } from './refused-port.js';

const image = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10, 0x7f, 0x80, 0xfe]);
const schema = {
  type: 'object',
  properties: { tags: { type: 'array', items: { type: 'string' } } },
  required: ['tags'],
};
const prompt = 'Describe the image as tags.';

let provider: MockProvider | undefined;

async function start(failures?: MockFailure[]): Promise<MockProvider> {
  provider = await startMockProvider({ port: 0, failures });
  return provider;
}

afterEach(async () => {
  await releaseRefusedPorts();
  await provider?.close();
  provider = undefined;
});

/** The model is an argument of every call, not an option of the adapter. */
function analyze(
  { model, ...options }: Parameters<typeof createOllamaVision>[0] & { model: string },
  signal = new AbortController().signal,
) {
  return createOllamaVision(options).analyzeImage({ image, prompt, schema, model, signal });
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
    // The mock records the image as the digest of the bytes it decoded from the Base64.
    expect(body.messages[0]!.images[0]).toBe(mockImageDigest(image));
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

  it('keeps no cause that could quote the answer for content or a body that is not JSON', async () => {
    const baseUrl = 'http://127.0.0.1:1';
    const content = JSON.stringify({ message: { content: 'secret-answer-text' } });
    for (const body of [content, 'secret-answer-text']) {
      const error = await failureOf(analyze({ baseUrl, model: MOCK_MODEL, fetch: answering(200, body) }));
      expect((error as JobError).code).toBe('invalid_response');
      expect((error as JobError).cause).toBeUndefined();
    }
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
    const url = await refusedUrl();
    await expectCode(analyze({ baseUrl: url, model: MOCK_MODEL }), 'provider_unreachable', url);
  });

  it('maps a missing answer to provider_timeout', async () => {
    const { url } = await start(['hang']);
    await expectCode(analyze({ baseUrl: url, model: MOCK_MODEL, timeoutMs: 50 }), 'provider_timeout', url);
  });

  it('maps HTTP 200 with an empty body to invalid_response', async () => {
    const baseUrl = 'http://127.0.0.1:1';
    await expectCode(analyze({ baseUrl, model: MOCK_MODEL, fetch: answering(200, '') }), 'invalid_response', baseUrl);
  });

  it('maps a body over the size cap to invalid_response and cancels the stream', async () => {
    const baseUrl = 'http://127.0.0.1:1';
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl: typeof fetch = async () => new Response(stream, { status: 200 });
    await expectCode(analyze({ baseUrl, model: MOCK_MODEL, fetch: fetchImpl }), 'invalid_response', baseUrl);
    expect(cancelled).toBe(true);
  });

  it('maps a content-length over the size cap to invalid_response', async () => {
    const baseUrl = 'http://127.0.0.1:1';
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new TextEncoder().encode('{}'));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const fetchImpl: typeof fetch = async () =>
      new Response(stream, { status: 200, headers: { 'content-length': String(2 * 1024 * 1024) } });
    await expectCode(analyze({ baseUrl, model: MOCK_MODEL, fetch: fetchImpl }), 'invalid_response', baseUrl);
    expect(pulled).toBe(false);
  });

  it('refuses a redirect as provider_rejected without following it', async () => {
    const { url, requests } = await start();
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 307, headers: { location: `${url}/api/chat` } });
    };
    await expectCode(analyze({ baseUrl: url, model: MOCK_MODEL, fetch: fetchImpl }), 'provider_rejected', url);
    expect(calls).toBe(1);
    expect(requests).toHaveLength(0);
  });

  it('does not follow a real redirect response', async () => {
    const { createServer: createHttpServer } = await import('node:http');
    let hits = 0;
    const server = createHttpServer((request, response) => {
      hits += 1;
      response.writeHead(307, { location: '/api/chat' });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await expectCode(analyze({ baseUrl, model: MOCK_MODEL }), 'provider_rejected', baseUrl);
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rethrows a pre-aborted signal and makes no request', async () => {
    const baseUrl = 'http://127.0.0.1:1';
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    };
    const controller = new AbortController();
    const reason = new Error('cancelled before start');
    controller.abort(reason);
    const error = await failureOf(analyze({ baseUrl, model: MOCK_MODEL, fetch: fetchImpl }, controller.signal));
    expect(error).toBe(reason);
    expect(calls).toBe(0);
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
