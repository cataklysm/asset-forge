import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import { crc32, deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_ANSWER_MAX_BYTES, type JobErrorCode } from '@assetforge/contracts';
import { JobError, type ImageInput, type ImageProvider } from '@assetforge/core';
import {
  MOCK_EDIT_BASIC_MODEL,
  MOCK_EDIT_MODEL,
  MOCK_PROMPT_BUSY,
  MOCK_PROMPT_FAIL,
  MOCK_PROMPT_NO_BALANCE,
  MOCK_PROMPT_SLOW,
  MOCK_PROMPT_VIOLATION,
  MOCK_PROMPT_VIOLATION_OK,
  startMockProvider,
  type MockProvider,
} from '../../../docker/mock-provider/server.mjs';
import { createVeniceImage } from '../src/index.js';
import { refusedUrl, releaseRefusedPorts } from './refused-port.js';

const KEY = 'test-key-not-real';
const signal = () => new AbortController().signal;

const providers: MockProvider[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await releaseRefusedPorts();
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

async function start(options?: Parameters<typeof startMockProvider>[0]): Promise<MockProvider> {
  const provider = await startMockProvider({ port: 0, apiKey: KEY, ...options });
  providers.push(provider);
  return provider;
}

/** A plain HTTP server on an ephemeral port. */
async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A base URL whose connection is refused for the whole test. */
function closedPort(): Promise<string> {
  return refusedUrl('/api/v1');
}

function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 128)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

const input: ImageInput = { data: png(32, 32), mimeType: 'image/png' };

async function bytesOf(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sizeOf(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

async function codeOf(promise: Promise<unknown>): Promise<JobErrorCode> {
  const error = await failureOf(promise);
  expect(error).toBeInstanceOf(JobError);
  return (error as JobError).code;
}

function edit(adapter: ImageProvider, overrides: Partial<Parameters<ImageProvider['editImage']>[0]> = {}) {
  return adapter.editImage({
    image: input,
    model: MOCK_EDIT_MODEL,
    prompt: 'a red chair',
    aspectRatio: null,
    resolution: null,
    safeMode: true,
    signal: signal(),
    ...overrides,
  });
}

/** An adapter on the in-process mock with the right key. */
async function onMock(options: Partial<Parameters<typeof createVeniceImage>[0]> = {}) {
  const mock = await start();
  const failures: unknown[][] = [];
  const adapter = createVeniceImage({
    baseUrl: `${mock.url}/api/v1`,
    timeoutMs: 5_000,
    apiKey: () => KEY,
    onFailure: (...args) => void failures.push(args),
    ...options,
  });
  return { mock, adapter, failures };
}

/** An adapter whose fetch answers with `answer`. */
function stubbed(
  answer: () => Response | Promise<Response>,
  options: Partial<Parameters<typeof createVeniceImage>[0]> = {},
) {
  const failures: unknown[][] = [];
  const adapter = createVeniceImage({
    baseUrl: 'http://127.0.0.1:1/api/v1',
    timeoutMs: 5_000,
    apiKey: () => KEY,
    onFailure: (...args) => void failures.push(args),
    fetch: async () => answer(),
    ...options,
  });
  return { adapter, failures };
}

function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: 'x' }), {
    status: code,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fetchFailure(code: string): () => never {
  return () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code}`), { code }) });
  };
}

describe('Venice image adapter, requests', () => {
  it('sends an edit as multipart with the bearer key and streams the PNG', async () => {
    const { mock, adapter } = await onMock();
    const result = await edit(adapter, { aspectRatio: '16:9', resolution: '2K' });
    expect(result.mimeType).toBe('image/png');
    expect(sizeOf(await bytesOf(result.stream))).toEqual({ width: 128, height: 72 });
    expect(mock.imageRequests).toEqual([
      {
        path: '/api/v1/image/edit',
        authorization: `Bearer ${KEY}`,
        fields: {
          prompt: 'a red chair',
          model: MOCK_EDIT_MODEL,
          aspect_ratio: '16:9',
          resolution: '2K',
          output_format: 'png',
          safe_mode: 'true',
        },
        fileBytes: input.data.byteLength,
      },
    ]);
  });

  it('leaves out a null aspect ratio and resolution and sends safe mode off', async () => {
    const { mock, adapter } = await onMock();
    await bytesOf((await edit(adapter, { safeMode: false })).stream);
    expect(mock.imageRequests[0]?.fields).toEqual({
      prompt: 'a red chair',
      model: MOCK_EDIT_MODEL,
      output_format: 'png',
      safe_mode: 'false',
    });
  });

  it('sends the image with its own type', async () => {
    const seen: { type: string; size: number }[] = [];
    const { adapter } = stubbed(
      () => new Response(new Uint8Array(png(1, 1)), { headers: { 'content-type': 'image/png' } }),
      {
        fetch: async (_url, init) => {
          const image = (init?.body as FormData).get('image') as Blob;
          seen.push({ type: image.type, size: image.size });
          return new Response(new Uint8Array(png(1, 1)), { headers: { 'content-type': 'image/png' } });
        },
      },
    );
    const jpeg: ImageInput = { data: new Uint8Array([0xff, 0xd8, 0xff, 1, 2]), mimeType: 'image/jpeg' };
    await bytesOf((await edit(adapter, { image: jpeg })).stream);
    await bytesOf(
      (await adapter.upscaleImage({ image: { ...jpeg, mimeType: 'image/webp' }, scale: 2, signal: signal() })).stream,
    );
    expect(seen).toEqual([
      { type: 'image/jpeg', size: 5 },
      { type: 'image/webp', size: 5 },
    ]);
  });

  it('sends an upscale with image and scale only', async () => {
    const { mock, adapter } = await onMock();
    const result = await adapter.upscaleImage({
      image: { data: png(64, 64), mimeType: 'image/png' },
      scale: 4,
      signal: signal(),
    });
    expect(result.mimeType).toBe('image/png');
    expect(sizeOf(await bytesOf(result.stream))).toEqual({ width: 256, height: 256 });
    expect(mock.imageRequests).toEqual([
      {
        path: '/api/v1/image/upscale',
        authorization: `Bearer ${KEY}`,
        fields: { scale: '4' },
        fileBytes: png(64, 64).byteLength,
      },
    ]);
  });

  it('never puts the key into a body', async () => {
    const mock = await start();
    const bodies: string[] = [];
    const adapter = createVeniceImage({
      baseUrl: `${mock.url}/api/v1`,
      timeoutMs: 5_000,
      apiKey: () => KEY,
      fetch: async (url, init) => {
        const request = new Request(url, init);
        bodies.push(await request.clone().text());
        return fetch(request);
      },
    });
    await bytesOf((await edit(adapter, { aspectRatio: '1:1', resolution: '1K' })).stream);
    await bytesOf((await adapter.upscaleImage({ image: input, scale: 2, signal: signal() })).stream);
    await adapter.listEditModels(signal());
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toContain('a red chair');
    for (const body of bodies) expect(body).not.toContain(KEY);
    expect(mock.requests.map((request) => request.headers.authorization)).toEqual([
      `Bearer ${KEY}`,
      `Bearer ${KEY}`,
      `Bearer ${KEY}`,
    ]);
  });

  it('reads the key for every request and sends none when there is none', async () => {
    let key: string | null = KEY;
    const { mock, adapter } = await onMock({ apiKey: () => key });
    await bytesOf((await adapter.upscaleImage({ image: input, scale: 2, signal: signal() })).stream);
    key = 'test-key-not-real-2';
    expect(await codeOf(adapter.upscaleImage({ image: input, scale: 2, signal: signal() }))).toBe(
      'provider_unauthorized',
    );
    key = null;
    expect(await codeOf(adapter.upscaleImage({ image: input, scale: 2, signal: signal() }))).toBe(
      'provider_unauthorized',
    );
    expect(mock.imageRequests.map((request) => request.authorization)).toEqual([
      `Bearer ${KEY}`,
      'Bearer test-key-not-real-2',
      null,
    ]);
  });

  it('refuses a key that cannot be sent without sending anything', async () => {
    const calls: unknown[] = [];
    const { adapter, failures } = stubbed(() => status(200), {
      apiKey: () => 'bad\nkey',
      fetch: async () => {
        calls.push(1);
        return status(200);
      },
    });
    const error = await failureOf(edit(adapter));
    expect((error as JobError).code).toBe('provider_unauthorized');
    expect(String((error as JobError).cause ?? '')).not.toContain('bad');
    expect(calls).toEqual([]);
    expect(failures).toEqual([['provider_unauthorized', null]]);
  });

  it('never follows a redirect, so the second server never sees the key', async () => {
    const second = await start();
    const first = await serve((req, res) => {
      res.writeHead(307, { location: `${second.url}${req.url ?? '/'}` });
      res.end();
    });
    const failures: unknown[][] = [];
    const adapter = createVeniceImage({
      baseUrl: `${first}/api/v1`,
      timeoutMs: 5_000,
      apiKey: () => KEY,
      onFailure: (...args) => void failures.push(args),
    });
    expect(await codeOf(edit(adapter))).toBe('provider_rejected');
    expect(await codeOf(adapter.upscaleImage({ image: input, scale: 2, signal: signal() }))).toBe('provider_rejected');
    expect(await codeOf(adapter.listEditModels(signal()))).toBe('provider_rejected');
    expect(second.requests).toEqual([]);
    expect(second.imageRequests).toEqual([]);
    expect(failures).toEqual([
      ['provider_rejected', 307],
      ['provider_rejected', 307],
      ['provider_rejected', 307],
    ]);
  });
});

describe('Venice image adapter, error mapping', () => {
  it('maps a refused connection to provider_unreachable', async () => {
    const failures: unknown[][] = [];
    const adapter = createVeniceImage({
      baseUrl: await closedPort(),
      timeoutMs: 5_000,
      apiKey: () => KEY,
      onFailure: (...args) => void failures.push(args),
    });
    expect(await codeOf(edit(adapter))).toBe('provider_unreachable');
    expect(await codeOf(adapter.upscaleImage({ image: input, scale: 2, signal: signal() }))).toBe(
      'provider_unreachable',
    );
    expect(failures).toEqual([
      ['provider_unreachable', null],
      ['provider_unreachable', null],
    ]);
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'])(
    'maps %s in the cause chain to provider_unreachable',
    async (code) => {
      const { adapter } = stubbed(fetchFailure(code));
      expect(await codeOf(edit(adapter))).toBe('provider_unreachable');
      const nested = stubbed(() => {
        throw new TypeError('fetch failed', {
          cause: new Error('outer', { cause: Object.assign(new Error('inner'), { code }) }),
        });
      });
      expect(await codeOf(nested.adapter.upscaleImage({ image: input, scale: 2, signal: signal() }))).toBe(
        'provider_unreachable',
      );
    },
  );

  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE'])(
    'maps any other fetch failure (%s) to provider_outcome_unknown',
    async (code) => {
      const { adapter, failures } = stubbed(fetchFailure(code));
      expect(await codeOf(edit(adapter))).toBe('provider_outcome_unknown');
      expect(await codeOf(adapter.upscaleImage({ image: input, scale: 2, signal: signal() }))).toBe(
        'provider_outcome_unknown',
      );
      expect(failures).toEqual([
        ['provider_outcome_unknown', null],
        ['provider_outcome_unknown', null],
      ]);
    },
  );

  it('maps a timeout to provider_outcome_unknown', async () => {
    const { adapter, failures } = await onMock({ timeoutMs: 100 });
    const started = performance.now();
    expect(await codeOf(edit(adapter, { prompt: MOCK_PROMPT_SLOW }))).toBe('provider_outcome_unknown');
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(failures).toEqual([['provider_outcome_unknown', null]]);
  });

  it.each([
    [MOCK_PROMPT_FAIL, 'provider_outcome_unknown', 500],
    [MOCK_PROMPT_NO_BALANCE, 'provider_insufficient_balance', 402],
    [MOCK_PROMPT_VIOLATION, 'provider_content_refused', 422],
    [MOCK_PROMPT_BUSY, 'provider_unavailable', 429],
  ] as const)('maps the mock prompt %s to %s', async (prompt, code, httpStatus) => {
    const { adapter, failures } = await onMock();
    expect(await codeOf(edit(adapter, { prompt }))).toBe(code);
    expect(failures).toEqual([[code, httpStatus]]);
  });

  it('maps a 200 with the content-violation header to provider_content_refused', async () => {
    const { adapter, failures } = await onMock();
    expect(await codeOf(edit(adapter, { prompt: MOCK_PROMPT_VIOLATION_OK }))).toBe('provider_content_refused');
    expect(failures).toEqual([['provider_content_refused', 200]]);
  });

  it('maps a wrong key to provider_unauthorized', async () => {
    const { adapter, failures } = await onMock({ apiKey: () => 'test-key-not-real-2' });
    expect(await codeOf(edit(adapter))).toBe('provider_unauthorized');
    expect(failures).toEqual([['provider_unauthorized', 401]]);
  });

  it('maps a parameter the model does not offer (400 from the mock) to provider_rejected', async () => {
    const { adapter, failures } = await onMock();
    expect(await codeOf(edit(adapter, { aspectRatio: '4:3' }))).toBe('provider_rejected');
    expect(failures).toEqual([['provider_rejected', 400]]);
  });

  it.each([
    [401, 'provider_unauthorized'],
    [403, 'provider_unauthorized'],
    [402, 'provider_insufficient_balance'],
    [422, 'provider_content_refused'],
    [400, 'provider_rejected'],
    [413, 'provider_rejected'],
    [429, 'provider_unavailable'],
    [503, 'provider_unavailable'],
    [404, 'provider_rejected'],
    [409, 'provider_rejected'],
    [415, 'provider_rejected'],
    [500, 'provider_outcome_unknown'],
    [502, 'provider_outcome_unknown'],
    [504, 'provider_outcome_unknown'],
    [301, 'provider_rejected'],
  ] as const)('maps status %i to %s for edit and upscale', async (httpStatus, code) => {
    const { adapter, failures } = stubbed(() => status(httpStatus));
    expect(await codeOf(edit(adapter))).toBe(code);
    expect(await codeOf(adapter.upscaleImage({ image: input, scale: 4, signal: signal() }))).toBe(code);
    expect(failures).toEqual([
      [code, httpStatus],
      [code, httpStatus],
    ]);
  });

  it.each([200, 400, 429, 500])(
    'maps the content-violation header on status %i to provider_content_refused',
    async (httpStatus) => {
      const { adapter, failures } = stubbed(() => status(httpStatus, { 'x-venice-is-content-violation': 'true' }));
      expect(await codeOf(adapter.upscaleImage({ image: input, scale: 2, signal: signal() }))).toBe(
        'provider_content_refused',
      );
      expect(failures).toEqual([['provider_content_refused', httpStatus]]);
    },
  );

  it('maps an answer that is not an image to provider_outcome_unknown', async () => {
    const { adapter, failures } = stubbed(() => status(200));
    expect(await codeOf(edit(adapter))).toBe('provider_outcome_unknown');
    expect(failures).toEqual([['provider_outcome_unknown', 200]]);
  });

  it('maps a cut stream to provider_outcome_unknown on the answer stream', async () => {
    const { adapter, failures } = stubbed(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024));
              controller.error(new Error('socket hang up'));
            },
          }),
          { headers: { 'content-type': 'image/png' } },
        ),
    );
    const { stream } = await edit(adapter);
    expect(await codeOf(bytesOf(stream))).toBe('provider_outcome_unknown');
    expect(failures).toEqual([['provider_outcome_unknown', 200]]);
  });

  it('cuts an answer streaming past the cap with provider_outcome_unknown', async () => {
    const chunk = new Uint8Array(1024 ** 2);
    let sent = 0;
    let cancelled = false;
    const { adapter, failures } = stubbed(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              // Far more than the cap, so only a cancel can end the source early.
              if (sent >= 200) return controller.close();
              sent += 1;
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'image/png' } },
        ),
    );
    const { stream } = await adapter.upscaleImage({ image: input, scale: 4, signal: signal() });
    let received = 0;
    const error = await failureOf(
      (async () => {
        for await (const part of stream) received += (part as Buffer).length;
      })(),
    );
    expect((error as JobError).code).toBe('provider_outcome_unknown');
    expect(received).toBeLessThanOrEqual(IMAGE_ANSWER_MAX_BYTES);
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(sent).toBeLessThan(200);
    expect(failures).toEqual([['provider_outcome_unknown', 200]]);
  });

  it.each(['image/svg+xml', 'image/gif', 'text/html'])(
    'maps a 200 answer of type %s to provider_outcome_unknown',
    async (type) => {
      const { adapter, failures } = stubbed(
        () => new Response(new Uint8Array(png(1, 1)), { headers: { 'content-type': type } }),
      );
      expect(await codeOf(edit(adapter))).toBe('provider_outcome_unknown');
      expect(failures).toEqual([['provider_outcome_unknown', 200]]);
    },
  );

  it.each([
    ['image/png', 'image/png'],
    ['image/jpeg', 'image/jpeg'],
    ['image/webp; charset=binary', 'image/webp'],
    [null, 'image/png'],
  ])('accepts a 200 answer of type %s', async (type, mimeType) => {
    const { adapter } = stubbed(() => {
      const response = new Response(new Uint8Array(png(1, 1)));
      if (type === null) response.headers.delete('content-type');
      else response.headers.set('content-type', type);
      return response;
    });
    const result = await adapter.upscaleImage({ image: input, scale: 2, signal: signal() });
    expect(result.mimeType).toBe(mimeType);
    await bytesOf(result.stream);
  });

  it('maps a throwing key supplier to internal_error without a cause and sends nothing', async () => {
    const calls: unknown[] = [];
    const { adapter, failures } = stubbed(() => status(200), {
      apiKey: () => {
        throw new Error(`store failed ${KEY}`);
      },
      fetch: async () => {
        calls.push(1);
        return status(200);
      },
    });
    for (const pending of [
      edit(adapter),
      adapter.upscaleImage({ image: input, scale: 2, signal: signal() }),
      adapter.listEditModels(signal()),
    ]) {
      const error = (await failureOf(pending)) as JobError;
      expect(error).toBeInstanceOf(JobError);
      expect(error.code).toBe('internal_error');
      expect(error.cause).toBeUndefined();
      expect(error.message).not.toContain(KEY);
    }
    expect(calls).toEqual([]);
    expect(failures).toEqual([
      ['internal_error', null],
      ['internal_error', null],
      ['internal_error', null],
    ]);
  });

  it('refuses a declared length past the cap before reading', async () => {
    const { adapter, failures } = stubbed(
      () =>
        new Response(new Uint8Array(4), {
          headers: { 'content-type': 'image/png', 'content-length': String(IMAGE_ANSWER_MAX_BYTES + 1) },
        }),
    );
    expect(await codeOf(edit(adapter))).toBe('provider_outcome_unknown');
    expect(failures).toEqual([['provider_outcome_unknown', 200]]);
  });

  it('rejects with the caller reason on abort and reports nothing', async () => {
    const { adapter, failures } = await onMock();
    const controller = new AbortController();
    const pending = edit(adapter, { prompt: MOCK_PROMPT_SLOW, signal: controller.signal });
    const reason = new Error('cancelled');
    setTimeout(() => controller.abort(reason), 20);
    expect(await failureOf(pending)).toBe(reason);
    expect(failures).toEqual([]);
  });

  it('gives onFailure only the code and the status', async () => {
    const onFailure = vi.fn();
    const { adapter } = await onMock({ onFailure });
    await failureOf(edit(adapter, { prompt: MOCK_PROMPT_NO_BALANCE }));
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]).toEqual(['provider_insufficient_balance', 402]);
  });

  it('keeps the key out of every error', async () => {
    const { adapter } = stubbed(() => {
      throw new TypeError(`fetch failed ${KEY}`, { cause: Object.assign(new Error(KEY), { code: 'ECONNRESET' }) });
    });
    const error = (await failureOf(edit(adapter))) as JobError;
    expect(error.message).not.toContain(KEY);
    expect(error.cause).toBeUndefined();
  });
});

describe('Venice image adapter, edit models', () => {
  it('maps both mock models', async () => {
    const { mock, adapter } = await onMock();
    expect(await adapter.listEditModels(signal())).toEqual([
      {
        name: MOCK_EDIT_MODEL,
        aspectRatios: ['1:1', '16:9', '9:16'],
        resolutions: ['1K', '2K', '4K'],
        defaultResolution: '1K',
        promptCharacterLimit: 1500,
        price: '$0.04',
      },
      {
        name: MOCK_EDIT_BASIC_MODEL,
        aspectRatios: null,
        resolutions: null,
        defaultResolution: null,
        promptCharacterLimit: null,
        price: null,
      },
    ]);
    expect(mock.requests).toMatchObject([
      { method: 'GET', path: '/api/v1/models', headers: { authorization: `Bearer ${KEY}` } },
    ]);
  });

  it('asks for the inpaint models', async () => {
    const urls: string[] = [];
    const { adapter } = stubbed(() => status(200), {
      fetch: async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
      },
    });
    expect(await adapter.listEditModels(signal())).toEqual([]);
    expect(urls).toEqual(['http://127.0.0.1:1/api/v1/models?type=inpaint']);
  });

  it('turns malformed constraints into null and skips entries without a usable id', async () => {
    const body = {
      data: [
        {
          id: 'odd',
          model_spec: {
            constraints: {
              aspectRatios: 'all',
              resolutions: [1, 2],
              defaultResolution: 7,
              promptCharacterLimit: -3,
            },
            pricing: { usd: 'free' },
          },
        },
        {
          id: 'flat-price',
          model_spec: { constraints: { promptCharacterLimit: 2.5, resolutions: [] }, pricing: { usd: 0.1 } },
        },
        { id: 'no-spec' },
        { id: '' },
        { name: 'no id' },
        null,
      ],
    };
    const { adapter } = stubbed(
      () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
    const nulls = {
      aspectRatios: null,
      resolutions: null,
      defaultResolution: null,
      promptCharacterLimit: null,
      price: null,
    };
    expect(await adapter.listEditModels(signal())).toEqual([
      { name: 'odd', ...nulls },
      { name: 'flat-price', ...nulls, price: '$0.10' },
      { name: 'no-spec', ...nulls },
    ]);
  });

  it('answers invalid_response for an answer without a model list', async () => {
    const { adapter, failures } = stubbed(
      () => new Response('not json', { headers: { 'content-type': 'application/json' } }),
    );
    expect(await codeOf(adapter.listEditModels(signal()))).toBe('invalid_response');
    const other = stubbed(() => new Response('{"models":[]}', { headers: { 'content-type': 'application/json' } }));
    expect(await codeOf(other.adapter.listEditModels(signal()))).toBe('invalid_response');
    expect(failures).toEqual([['invalid_response', 200]]);
  });

  it.each([
    [401, 'provider_unauthorized'],
    [429, 'provider_unavailable'],
    [500, 'provider_unavailable'],
    [404, 'provider_rejected'],
  ] as const)('maps status %i of the list to %s', async (httpStatus, code) => {
    const { adapter, failures } = stubbed(() => status(httpStatus));
    expect(await codeOf(adapter.listEditModels(signal()))).toBe(code);
    expect(failures).toEqual([[code, httpStatus]]);
  });

  it('maps an unreachable list to provider_unreachable', async () => {
    const adapter = createVeniceImage({ baseUrl: await closedPort(), timeoutMs: 5_000, apiKey: () => KEY });
    expect(await codeOf(adapter.listEditModels(signal()))).toBe('provider_unreachable');
  });

  /** A fetch that only ends when its signal aborts. */
  const hanging: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });

  it('bounds the list by the timeout and answers provider_timeout', async () => {
    const { adapter, failures } = stubbed(() => status(200), { fetch: hanging, timeoutMs: 100 });
    expect(await codeOf(adapter.listEditModels(signal()))).toBe('provider_timeout');
    expect(failures).toEqual([['provider_timeout', null]]);
  });

  it('bounds the list by LIST_MODELS_TIMEOUT_MS when the timeout is longer', async () => {
    vi.useFakeTimers();
    const { adapter } = stubbed(() => status(200), { fetch: hanging, timeoutMs: 600_000 });
    const outcome = codeOf(adapter.listEditModels(signal()));
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe('provider_timeout');
  });

  it('rejects with the caller reason on abort', async () => {
    const { adapter, failures } = stubbed(() => status(200), { fetch: hanging });
    const controller = new AbortController();
    const pending = adapter.listEditModels(controller.signal);
    const reason = new Error('cancelled');
    controller.abort(reason);
    expect(await failureOf(pending)).toBe(reason);
    expect(failures).toEqual([]);
  });
});
