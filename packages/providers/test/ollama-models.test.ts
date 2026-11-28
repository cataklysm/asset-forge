import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobError } from '@assetforge/core';
import { startMockProvider, type MockProvider } from '../../../docker/mock-provider/server.mjs';
import { createOllamaVision } from '../src/index.js';

const BASE = 'http://127.0.0.1:1';
const signal = () => new AbortController().signal;

let provider: MockProvider | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await provider?.close();
  provider = undefined;
});

interface Call {
  path: string;
  init: RequestInit;
  model: string | null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Never answers; rejects with the request signal's reason once it aborts. */
function hanging(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (init.signal?.aborted) reject(init.signal.reason as Error);
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error), { once: true });
  });
}

/** A fetch stub: `tags` answers `/api/tags`, `show` answers `/api/show` per model. */
function server(
  tags: () => Response | Promise<Response>,
  show: (model: string, init: RequestInit) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      const model = init.body ? (JSON.parse(String(init.body)) as { model: string }).model : null;
      calls.push({ path, init, model });
      return path === '/api/tags' ? tags() : show(model ?? '', init);
    },
  };
}

const names = (count: number) => Array.from({ length: count }, (_, index) => `model-${String(index).padStart(3, '0')}`);

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('listModels', () => {
  it('asks /api/tags, then /api/show per model, and reads the capabilities', async () => {
    const stub = server(
      () => json(200, { models: [{ name: 'eyes' }, { name: 'text' }, { name: 'old' }] }),
      (model) =>
        model === 'eyes'
          ? json(200, { capabilities: ['completion', 'vision'] })
          : model === 'text'
            ? json(200, { capabilities: ['completion'] })
            : json(200, { modelfile: '' }),
    );
    const models = await createOllamaVision({ baseUrl: `${BASE}/`, fetch: stub.fetch }).listModels(signal());
    expect(models).toEqual([
      { name: 'eyes', vision: true },
      { name: 'text', vision: false },
      { name: 'old', vision: null },
    ]);
    expect(stub.calls[0]).toMatchObject({ path: '/api/tags', model: null });
    expect(stub.calls[0]?.init.method ?? 'GET').toBe('GET');
    const shows = stub.calls.slice(1);
    expect(shows.map((call) => call.path)).toEqual(['/api/show', '/api/show', '/api/show']);
    expect(shows.map((call) => call.init.method)).toEqual(['POST', 'POST', 'POST']);
    expect(shows.map((call) => JSON.parse(String(call.init.body)) as unknown)).toEqual([
      { model: 'eyes' },
      { model: 'text' },
      { model: 'old' },
    ]);
    for (const call of stub.calls) expect(call.init.redirect).toBe('manual');
  });

  it.each([
    ['500', () => json(500, {})],
    ['404', () => json(404, { error: 'not found' })],
    ['401', () => json(401, {})],
    ['403', () => json(403, {})],
    ['a redirect', () => new Response(null, { status: 307, headers: { location: '/elsewhere' } })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['capabilities that are not a list', () => json(200, { capabilities: 'vision' })],
    ['an unreachable server', () => Promise.reject(new TypeError('fetch failed'))],
  ])('gives vision null for a show answering %s and still resolves', async (_name, failing) => {
    const stub = server(
      () => json(200, { models: [{ name: 'a' }, { name: 'b' }] }),
      (model) => (model === 'a' ? failing() : json(200, { capabilities: ['vision'] })),
    );
    const models = await createOllamaVision({ baseUrl: BASE, fetch: stub.fetch }).listModels(signal());
    expect(models).toEqual([
      { name: 'a', vision: null },
      { name: 'b', vision: true },
    ]);
  });

  it('reports a failing /api/tags but stays silent about swallowed show failures', async () => {
    const reports: unknown[][] = [];
    const onFailure = (...args: unknown[]) => void reports.push(args);
    const shows = server(
      () => json(200, { models: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }),
      (model) => (model === 'a' ? json(403, {}) : model === 'b' ? json(500, {}) : Promise.reject(new TypeError('x'))),
    );
    const models = await createOllamaVision({ baseUrl: BASE, fetch: shows.fetch, onFailure }).listModels(signal());
    expect(models.map((model) => model.vision)).toEqual([null, null, null]);
    expect(reports).toEqual([]);
    const tags = server(
      () => json(401, {}),
      () => json(200, {}),
    );
    await failureOf(createOllamaVision({ baseUrl: BASE, fetch: tags.fetch, onFailure }).listModels(signal()));
    expect(reports).toEqual([['provider_unauthorized', 401]]);
  });

  it('gives each show its own 10 s limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stub = server(
      () => json(200, { models: [{ name: 'slow' }, { name: 'quick' }] }),
      (model, init) => (model === 'slow' ? hanging(init) : json(200, { capabilities: [] })),
    );
    const listed = createOllamaVision({
      baseUrl: BASE,
      fetch: stub.fetch,
      timeoutMs: 600_000,
      listTimeoutMs: 600_000,
    }).listModels(signal());
    let settled = false;
    void listed.finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(9_900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await expect(listed).resolves.toEqual([
      { name: 'slow', vision: null },
      { name: 'quick', vision: false },
    ]);
  });

  it('applies the overall timeout to /api/tags', async () => {
    const stub = server(
      () => hanging(stub.calls[0]!.init),
      () => json(200, {}),
    );
    const error = await failureOf(
      createOllamaVision({ baseUrl: BASE, fetch: stub.fetch, timeoutMs: 30 }).listModels(signal()),
    );
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe('provider_timeout');
  });

  it('bounds the whole call: tags at once, shows never answering', async () => {
    const stub = server(
      () => json(200, { models: [{ name: 'a' }, { name: 'b' }] }),
      (_model, init) => hanging(init),
    );
    const reports: [string, number | null][] = [];
    const started = Date.now();
    const error = await failureOf(
      createOllamaVision({
        baseUrl: BASE,
        fetch: stub.fetch,
        listTimeoutMs: 50,
        onFailure: (c, s) => reports.push([c, s]),
      }).listModels(signal()),
    );
    expect((error as JobError).code).toBe('provider_timeout');
    expect(Date.now() - started).toBeLessThan(500);
    expect(reports).toEqual([['provider_timeout', null]]);
  });

  it('bounds a /api/tags that never answers', async () => {
    const stub = server(
      () => hanging(stub.calls[0]!.init),
      () => json(200, {}),
    );
    const reports: string[] = [];
    const error = await failureOf(
      createOllamaVision({
        baseUrl: BASE,
        fetch: stub.fetch,
        listTimeoutMs: 50,
        onFailure: (c) => reports.push(c),
      }).listModels(signal()),
    );
    expect((error as JobError).code).toBe('provider_timeout');
    expect(reports).toEqual(['provider_timeout']);
  });

  it.each([
    [5_000, 5_000],
    [120_000, 10_000],
  ])('defaults the list bound for timeoutMs %i to %i ms', async (timeoutMs, bound) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stub = server(
      () => hanging(stub.calls[0]!.init),
      () => json(200, {}),
    );
    const listed = failureOf(createOllamaVision({ baseUrl: BASE, fetch: stub.fetch, timeoutMs }).listModels(signal()));
    let settled = false;
    void listed.finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(bound - 100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(((await listed) as JobError).code).toBe('provider_timeout');
  });

  it.each([
    [401, 'provider_unauthorized'],
    [403, 'provider_unauthorized'],
    [503, 'provider_unavailable'],
    [400, 'provider_rejected'],
  ] as const)('fails the call when /api/tags answers %i', async (status, code) => {
    const stub = server(
      () => json(status, {}),
      () => json(200, {}),
    );
    const error = await failureOf(createOllamaVision({ baseUrl: BASE, fetch: stub.fetch }).listModels(signal()));
    expect((error as JobError).code).toBe(code);
    expect(stub.calls).toHaveLength(1);
  });

  it.each([
    ['no models list', { tags: [] }],
    ['a body that is not an object', ['x']],
  ])('maps a tags answer with %s to invalid_response', async (_name, body) => {
    const stub = server(
      () => json(200, body),
      () => json(200, {}),
    );
    const error = await failureOf(createOllamaVision({ baseUrl: BASE, fetch: stub.fetch }).listModels(signal()));
    expect((error as JobError).code).toBe('invalid_response');
  });

  it('skips entries without a usable name', async () => {
    const stub = server(
      () =>
        json(200, { models: [{ name: '' }, { model: 'x' }, { name: 7 }, { name: 'n'.repeat(201) }, { name: 'ok' }] }),
      () => json(200, { capabilities: ['vision'] }),
    );
    const models = await createOllamaVision({ baseUrl: BASE, fetch: stub.fetch }).listModels(signal());
    expect(models).toEqual([{ name: 'ok', vision: true }]);
  });

  it('asks at most 100 models', async () => {
    const all = names(101);
    const stub = server(
      () => json(200, { models: all.map((name) => ({ name })) }),
      () => json(200, { capabilities: ['vision'] }),
    );
    const models = await createOllamaVision({ baseUrl: BASE, fetch: stub.fetch }).listModels(signal());
    expect(models.map((model) => model.name)).toEqual(all.slice(0, 100));
    expect(stub.calls.filter((call) => call.path === '/api/show')).toHaveLength(100);
  });

  it('never has more than 4 show calls in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const stub = server(
      () => json(200, { models: names(12).map((name) => ({ name })) }),
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return json(200, { capabilities: [] });
      },
    );
    const models = await createOllamaVision({ baseUrl: BASE, fetch: stub.fetch }).listModels(signal());
    expect(models).toHaveLength(12);
    expect(peak).toBe(4);
  });

  it('caps the tags answer at 1 MiB', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(chunk),
      cancel: () => void (cancelled = true),
    });
    const stub = server(
      () => new Response(stream, { status: 200 }),
      () => json(200, {}),
    );
    const error = await failureOf(createOllamaVision({ baseUrl: BASE, fetch: stub.fetch }).listModels(signal()));
    expect((error as JobError).code).toBe('invalid_response');
    expect(cancelled).toBe(true);
  });

  it('caps every show answer at 1 MiB', async () => {
    const stub = server(
      () => json(200, { models: [{ name: 'big' }] }),
      () =>
        new Response(JSON.stringify({ capabilities: ['vision'], padding: ' '.repeat(1024 * 1024) }), {
          status: 200,
        }),
    );
    const models = await createOllamaVision({ baseUrl: BASE, fetch: stub.fetch }).listModels(signal());
    expect(models).toEqual([{ name: 'big', vision: null }]);
  });

  it('rethrows a caller abort during the shows', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const stub = server(
      () => json(200, { models: [{ name: 'a' }] }),
      (_model, init) => {
        controller.abort(reason);
        return hanging(init);
      },
    );
    const error = await failureOf(
      createOllamaVision({ baseUrl: BASE, fetch: stub.fetch }).listModels(controller.signal),
    );
    expect(error).toBe(reason);
  });

  it('reads the three kinds of model from the mock', async () => {
    provider = await startMockProvider({ port: 0 });
    const models = await createOllamaVision({ baseUrl: provider.url }).listModels(signal());
    expect(models).toHaveLength(3);
    expect(new Set(models.map((model) => model.vision))).toEqual(new Set([true, false, null]));
  });
});
