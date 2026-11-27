import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { JobError } from '@assetforge/core';
import type { JobErrorCode } from '@assetforge/contracts';
import {
  MOCK_FENCED_MODEL,
  MOCK_LEGACY_MODEL,
  MOCK_MODEL,
  MOCK_REASONING_ONLY_MODEL,
  MOCK_SLASH_MODEL,
  MOCK_TEXT_MODEL,
  MOCK_THINKING_MODEL,
  startMockProvider,
  type MockProvider,
} from '../../../docker/mock-provider/server.mjs';
import { createOpenAiVision, OPENAI_PROVIDER, stripThinking, type OpenAiVisionOptions } from '../src/index.js';

const KEY = 'test-key-not-real';
const image = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10, 0x7f, 0x80, 0xfe]);
const schema = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } }, required: ['tags'] };
const prompt = 'Describe the image as tags.';
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

type Report = [JobErrorCode, number | null];

/** An adapter whose failures are recorded in `reports`. */
function vision(options: OpenAiVisionOptions): { adapter: ReturnType<typeof createOpenAiVision>; reports: Report[] } {
  const reports: Report[] = [];
  const adapter = createOpenAiVision({ ...options, onFailure: (code, status) => void reports.push([code, status]) });
  return { adapter, reports };
}

function analyze(adapter: ReturnType<typeof createOpenAiVision>, model = MOCK_MODEL, callerSignal = signal()) {
  return adapter.analyzeImage({ image, prompt, schema, model, signal: callerSignal });
}

function describeWith(adapter: ReturnType<typeof createOpenAiVision>, model = MOCK_MODEL, callerSignal = signal()) {
  return adapter.describeImage({ image, prompt, model, signal: callerSignal });
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

async function expectCode(promise: Promise<unknown>, code: JobErrorCode): Promise<void> {
  const error = await failureOf(promise);
  expect(error).toBeInstanceOf(JobError);
  expect((error as JobError).code).toBe(code);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

interface Call {
  url: string;
  init: RequestInit;
}

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

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

const STUB_BASE = 'http://127.0.0.1:1/v1';

describe('openai vision adapter', () => {
  it('names its provider', () => {
    expect(OPENAI_PROVIDER).toBe('openai');
  });

  it('tags through /chat/completions with a json_schema response format', async () => {
    const { url, requests } = await start();
    const { adapter, reports } = vision({ baseUrl: `${url}/v1` });
    const result = (await analyze(adapter)) as { tags: string[] };
    expect(result.tags).toHaveLength(8);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/v1/chat/completions' });
    expect(requests[0]!.headers.authorization).toBeUndefined();
    const body = requests[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      model: MOCK_MODEL,
      stream: false,
      temperature: 0,
      response_format: { type: 'json_schema', json_schema: { name: 'tags', strict: true, schema } },
    });
    expect(body).not.toHaveProperty('chat_template_kwargs');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from(image).toString('base64')}` } },
        ],
      },
    ]);
    expect(reports).toEqual([]);
  });

  it('describes with plain text and no response format', async () => {
    const { url, requests } = await start();
    const { adapter } = vision({ baseUrl: `${url}/v1` });
    const text = await describeWith(adapter);
    expect(text.length).toBeGreaterThan(0);
    expect(() => JSON.parse(text) as unknown).toThrow();
    expect(requests[0]!.body).not.toHaveProperty('response_format');
  });

  it('maps the request options and keeps its own fields over extra', async () => {
    const { url, requests } = await start();
    const { adapter } = vision({
      baseUrl: `${url}/v1`,
      requestOptions: {
        temperature: 0.3,
        thinking: 'off',
        maxTokens: 200,
        extra: { top_p: 0.9, chat_template_kwargs: { foo: 1 } },
      },
    });
    await analyze(adapter);
    expect(requests[0]!.body).toMatchObject({
      temperature: 0.3,
      max_tokens: 200,
      top_p: 0.9,
      chat_template_kwargs: { enable_thinking: false, foo: 1 },
    });
  });

  it('never lets extra change the model, messages, stream or response format', async () => {
    const stub = recording(() => json(200, { choices: [{ message: { content: '{"tags":["a"]}' } }] }));
    const adapter = createOpenAiVision({
      baseUrl: STUB_BASE,
      fetch: stub.fetch,
      requestOptions: {
        temperature: 0,
        thinking: 'default',
        maxTokens: null,
        extra: { model: 'other', messages: [], stream: true, response_format: { type: 'text' } },
      },
    });
    await analyze(adapter, 'm1');
    await describeWith(adapter, 'm1');
    const tagging = bodyOf(stub.calls[0]!);
    expect(tagging.model).toBe('m1');
    expect(tagging.stream).toBe(false);
    expect(tagging.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'tags', strict: true, schema } });
    expect((tagging.messages as unknown[]).length).toBe(1);
    const describing = bodyOf(stub.calls[1]!);
    expect(describing.model).toBe('m1');
    expect(describing.stream).toBe(false);
    expect((describing.messages as unknown[]).length).toBe(1);
  });

  it('lists and sends a model name with a slash and a colon verbatim', async () => {
    const { url, requests } = await start();
    const { adapter } = vision({ baseUrl: `${url}/v1` });
    const models = await adapter.listModels(signal());
    expect(models).toEqual(
      [
        MOCK_MODEL,
        MOCK_TEXT_MODEL,
        MOCK_LEGACY_MODEL,
        MOCK_THINKING_MODEL,
        MOCK_FENCED_MODEL,
        MOCK_REASONING_ONLY_MODEL,
        MOCK_SLASH_MODEL,
      ].map((name) => ({ name, vision: null })),
    );
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/v1/models' });
    const result = (await analyze(adapter, MOCK_SLASH_MODEL)) as { tags: string[] };
    expect(result.tags).toHaveLength(8);
    expect((requests[1]!.body as { model: string }).model).toBe(MOCK_SLASH_MODEL);
  });

  it('maps a model list without a data array to invalid_response', async () => {
    const { adapter, reports } = vision({ baseUrl: STUB_BASE, fetch: async () => json(200, { models: [] }) });
    await expectCode(adapter.listModels(signal()), 'invalid_response');
    expect(reports).toEqual([['invalid_response', 200]]);
  });

  it('keeps at most 100 valid model ids', async () => {
    const data = [{ id: '' }, { id: 7 }, ...Array.from({ length: 120 }, (_, index) => ({ id: `model-${index}` }))];
    const { adapter } = vision({ baseUrl: STUB_BASE, fetch: async () => json(200, { data }) });
    const models = await adapter.listModels(signal());
    expect(models).toHaveLength(100);
    expect(models[0]).toEqual({ name: 'model-0', vision: null });
  });

  it.each([`/v1/`, `/v1`])('uses the base URL <mock>%s as given', async (suffix) => {
    const { url, requests } = await start();
    const { adapter } = vision({ baseUrl: `${url}${suffix}` });
    await analyze(adapter);
    expect(requests[0]!.path).toBe('/v1/chat/completions');
  });

  it('guesses no path: a base URL without /v1 fails as provider_rejected', async () => {
    const { url, requests } = await start();
    const { adapter, reports } = vision({ baseUrl: url });
    await expectCode(analyze(adapter), 'provider_rejected');
    expect(requests.map((request) => request.path)).toEqual(['/chat/completions']);
    expect(reports).toEqual([['provider_rejected', 404]]);
  });

  it('removes a leading think block', async () => {
    const { url } = await start();
    const { adapter } = vision({ baseUrl: `${url}/v1` });
    const result = (await analyze(adapter, MOCK_THINKING_MODEL)) as { tags: string[] };
    expect(result.tags).toHaveLength(8);
    const text = await describeWith(adapter, MOCK_THINKING_MODEL);
    expect(text).not.toContain('<think>');
    expect(text).not.toContain('mock reasoning');
    expect(text).toBe(await describeWith(adapter, MOCK_MODEL));
  });

  it('parses a JSON answer inside a code fence', async () => {
    const { url } = await start();
    const { adapter } = vision({ baseUrl: `${url}/v1` });
    const result = (await analyze(adapter, MOCK_FENCED_MODEL)) as { tags: string[] };
    expect(result.tags).toHaveLength(8);
  });

  it.each([
    ['analyze', (adapter: ReturnType<typeof createOpenAiVision>) => analyze(adapter, MOCK_REASONING_ONLY_MODEL)],
    ['describe', (adapter: ReturnType<typeof createOpenAiVision>) => describeWith(adapter, MOCK_REASONING_ONLY_MODEL)],
  ])('ignores reasoning_content: %s without content is invalid_response', async (_name, call) => {
    const { url } = await start();
    const { adapter, reports } = vision({ baseUrl: `${url}/v1` });
    await expectCode(call(adapter), 'invalid_response');
    expect(reports).toEqual([['invalid_response', 200]]);
  });

  it.each([
    ['an empty content', { choices: [{ message: { content: '' } }] }],
    ['a content of only a think block', { choices: [{ message: { content: '<think>x</think>  ' } }] }],
    ['missing choices', { id: 'x' }],
    ['a non-string content', { choices: [{ message: { content: { text: 'x' } } }] }],
  ])('maps %s to invalid_response', async (_name, answer) => {
    for (const run of [analyze, describeWith]) {
      const { adapter, reports } = vision({ baseUrl: STUB_BASE, fetch: async () => json(200, answer) });
      await expectCode(run(adapter, 'm1'), 'invalid_response');
      expect(reports).toEqual([['invalid_response', 200]]);
    }
  });

  it.each([
    ['plain text', 'a chair'],
    ['an unclosed think block', '<think>{"tags":["a"]}'],
    ['two code fences', '```json\n{"tags":["a"]}\n```\n```json\n{"tags":["b"]}\n```'],
    ['text around a fence', 'Here:\n```json\n{"tags":["a"]}\n```'],
  ])('maps tagging content of %s to invalid_response', async (_name, content) => {
    const { adapter, reports } = vision({
      baseUrl: STUB_BASE,
      fetch: async () => json(200, { choices: [{ message: { content } }] }),
    });
    await expectCode(analyze(adapter, 'm1'), 'invalid_response');
    expect(reports).toEqual([['invalid_response', 200]]);
  });

  it('parses a fence without a language word', async () => {
    const { adapter } = vision({
      baseUrl: STUB_BASE,
      fetch: async () => json(200, { choices: [{ message: { content: '  ```\n{"tags":["a"]}\n```  ' } }] }),
    });
    expect(await analyze(adapter, 'm1')).toEqual({ tags: ['a'] });
  });

  it('returns an unclosed think block unchanged from describe', async () => {
    const { adapter } = vision({
      baseUrl: STUB_BASE,
      fetch: async () => json(200, { choices: [{ message: { content: ' <think>still thinking ' } }] }),
    });
    expect(await describeWith(adapter, 'm1')).toBe('<think>still thinking');
  });
});

describe('stripThinking', () => {
  it.each([
    ['a leading block', '<think>x</think>answer', 'answer'],
    ['leading whitespace', '  \n<think>\nx\n</think>\n\nanswer', '\n\nanswer'],
    ['no block', 'answer', 'answer'],
    ['an unclosed block', '<think>answer', '<think>answer'],
    ['a block in the middle', 'answer <think>x</think> more', 'answer <think>x</think> more'],
    ['only the first block', '<think>a</think>b<think>c</think>', 'b<think>c</think>'],
  ])('handles %s', (_name, input, output) => {
    expect(stripThinking(input)).toBe(output);
  });
});

describe('servers without structured output', () => {
  it('repeats a tagging request once without response_format and remembers the model', async () => {
    const { url, requests } = await start({ refuseResponseFormat: true });
    const { adapter, reports } = vision({ baseUrl: `${url}/v1` });
    const first = (await analyze(adapter)) as { tags: string[] };
    expect(first.tags).toHaveLength(8);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body).toHaveProperty('response_format');
    expect(requests[1]!.body).not.toHaveProperty('response_format');

    const second = (await analyze(adapter)) as { tags: string[] };
    expect(second).toEqual(first);
    expect(requests).toHaveLength(3);
    expect(requests[2]!.body).not.toHaveProperty('response_format');
    expect(reports).toEqual([]);
  });

  it('remembers the model per adapter instance and per model', async () => {
    const { url, requests } = await start({ refuseResponseFormat: true });
    await analyze(vision({ baseUrl: `${url}/v1` }).adapter);
    const { adapter } = vision({ baseUrl: `${url}/v1` });
    await analyze(adapter);
    expect(requests).toHaveLength(4);
    await analyze(adapter, MOCK_SLASH_MODEL);
    expect(requests).toHaveLength(6);
    expect(requests[4]!.body).toHaveProperty('response_format');
  });

  it('reports only the second failure when both attempts are refused', async () => {
    const stub = recording(() => json(400, { error: 'bad request' }));
    const { adapter, reports } = vision({ baseUrl: STUB_BASE, fetch: stub.fetch });
    await expectCode(analyze(adapter, 'm1'), 'provider_rejected');
    expect(stub.calls).toHaveLength(2);
    expect(bodyOf(stub.calls[0]!)).toHaveProperty('response_format');
    expect(bodyOf(stub.calls[1]!)).not.toHaveProperty('response_format');
    expect(reports).toEqual([['provider_rejected', 400]]);
    // A refused fallback is not remembered.
    await failureOf(analyze(adapter, 'm1'));
    expect(bodyOf(stub.calls[2]!)).toHaveProperty('response_format');
  });

  it('takes the failure of the second attempt as the result', async () => {
    let call = 0;
    const { adapter, reports } = vision({
      baseUrl: STUB_BASE,
      fetch: async () => (++call === 1 ? json(400, {}) : json(503, {})),
    });
    await expectCode(analyze(adapter, 'm1'), 'provider_unavailable');
    expect(call).toBe(2);
    expect(reports).toEqual([['provider_unavailable', 503]]);
  });

  it.each([
    ['describe on 400', 400, 'describe', 'provider_rejected'],
    ['tagging on 404', 404, 'analyze', 'provider_rejected'],
    ['tagging on 422', 422, 'analyze', 'provider_rejected'],
    ['tagging on 500', 500, 'analyze', 'provider_unavailable'],
  ] as const)('does not repeat %s', async (_name, status, kind, code) => {
    const stub = recording(() => json(status, {}));
    const { adapter, reports } = vision({ baseUrl: STUB_BASE, fetch: stub.fetch });
    await expectCode(kind === 'describe' ? describeWith(adapter, 'm1') : analyze(adapter, 'm1'), code);
    expect(stub.calls).toHaveLength(1);
    expect(reports).toEqual([[code, status]]);
  });

  it('does not repeat an invalid tagging answer and reports it once', async () => {
    const stub = recording(() => json(200, { choices: [{ message: { content: 'nope' } }] }));
    const { adapter, reports } = vision({ baseUrl: STUB_BASE, fetch: stub.fetch });
    await expectCode(analyze(adapter, 'm1'), 'invalid_response');
    expect(stub.calls).toHaveLength(1);
    expect(reports).toEqual([['invalid_response', 200]]);
  });
});

describe('transport parity with the ollama adapter', () => {
  const answer = () => json(200, { choices: [{ message: { content: '{"tags":["a"]}' } }] });

  it('sends the key as a bearer token on chat and models', async () => {
    const stub = recording((call) => (call.url.endsWith('/models') ? json(200, { data: [{ id: 'm1' }] }) : answer()));
    const adapter = createOpenAiVision({ baseUrl: STUB_BASE, apiKey: () => KEY, fetch: stub.fetch });
    await analyze(adapter, 'm1');
    await describeWith(adapter, 'm1');
    await adapter.listModels(signal());
    expect(stub.calls.map((call) => call.url)).toEqual([
      `${STUB_BASE}/chat/completions`,
      `${STUB_BASE}/chat/completions`,
      `${STUB_BASE}/models`,
    ]);
    for (const call of stub.calls) expect(new Headers(call.init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('sends no authorization header without a key', async () => {
    const stub = recording(answer);
    await analyze(createOpenAiVision({ baseUrl: STUB_BASE, apiKey: () => null, fetch: stub.fetch }), 'm1');
    expect(new Headers(stub.calls[0]!.init.headers).get('authorization')).toBeNull();
  });

  it('sends the key to the in-process mock and maps a missing key to provider_unauthorized', async () => {
    const { url, requests } = await start({ apiKey: KEY });
    await analyze(createOpenAiVision({ baseUrl: `${url}/v1`, apiKey: () => KEY }));
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    const { adapter, reports } = vision({ baseUrl: `${url}/v1` });
    await expectCode(analyze(adapter), 'provider_unauthorized');
    expect(reports).toEqual([['provider_unauthorized', 401]]);
  });

  it.each([
    [429, 'provider_unavailable'],
    [500, 'provider_unavailable'],
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    const { url } = await start({ failures: [status] });
    const { adapter, reports } = vision({ baseUrl: `${url}/v1` });
    await expectCode(analyze(adapter), code);
    expect(reports).toEqual([[code, status]]);
  });

  it('refuses a redirect as provider_rejected without following it', async () => {
    const stub = recording(() => new Response(null, { status: 307, headers: { location: 'http://127.0.0.1:2/' } }));
    const { adapter, reports } = vision({ baseUrl: STUB_BASE, fetch: stub.fetch });
    await expectCode(describeWith(adapter, 'm1'), 'provider_rejected');
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.init.redirect).toBe('manual');
    expect(reports).toEqual([['provider_rejected', 307]]);
  });

  it('maps a missing answer to provider_timeout', async () => {
    const { url } = await start({ failures: ['hang'] });
    const { adapter, reports } = vision({ baseUrl: `${url}/v1`, timeoutMs: 50 });
    await expectCode(analyze(adapter), 'provider_timeout');
    expect(reports).toEqual([['provider_timeout', null]]);
  });

  it('bounds the model list by the list timeout', async () => {
    const { adapter } = vision({
      baseUrl: STUB_BASE,
      listTimeoutMs: 50,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error), { once: true });
        }),
    });
    await expectCode(adapter.listModels(signal()), 'provider_timeout');
  });

  it('rethrows the caller abort and reports nothing', async () => {
    const { url } = await start({ failures: ['hang'] });
    const { adapter, reports } = vision({ baseUrl: `${url}/v1` });
    const controller = new AbortController();
    const reason = new Error('cancelled by caller');
    setTimeout(() => controller.abort(reason), 20);
    const error = await failureOf(analyze(adapter, MOCK_MODEL, controller.signal));
    expect(error).toBe(reason);
    expect(reports).toEqual([]);
  });

  it('maps a closed port to provider_unreachable', async () => {
    const url = await closedPortUrl();
    const { adapter, reports } = vision({ baseUrl: `${url}/v1` });
    await expectCode(analyze(adapter), 'provider_unreachable');
    expect(reports).toEqual([['provider_unreachable', null]]);
  });
});
