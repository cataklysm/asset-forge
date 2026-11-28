import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MOCK_EDIT_BASIC_MODEL,
  MOCK_EDIT_MODEL,
  MOCK_FENCED_MODEL,
  MOCK_LEGACY_MODEL,
  MOCK_MAX_RECORDED,
  MOCK_MODEL,
  MOCK_PROMPT_BUSY,
  MOCK_PROMPT_FAIL,
  MOCK_PROMPT_NO_BALANCE,
  MOCK_PROMPT_SLOW,
  MOCK_PROMPT_VIOLATION,
  MOCK_PROMPT_VIOLATION_OK,
  MOCK_REASONING_ONLY_MODEL,
  MOCK_SLASH_MODEL,
  MOCK_TEXT_MODEL,
  MOCK_STYLES,
  MOCK_THINKING_MODEL,
  MOCK_VIEWS,
  MOCK_VOCABULARY,
  mockImageDigest,
  startMockProvider,
  type MockProvider,
} from '../../../docker/mock-provider/server.mjs';

const KEY = 'test-key-not-real';

let provider: MockProvider | undefined;

async function start(options?: Parameters<typeof startMockProvider>[0]): Promise<MockProvider> {
  provider = await startMockProvider({ port: 0, ...options });
  return provider;
}

function chat(url: string, image: string | null, model = MOCK_MODEL): Promise<Response> {
  const message = image === null ? { role: 'user', content: 'tag' } : { role: 'user', content: 'tag', images: [image] };
  return fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, format: { type: 'object' }, messages: [message] }),
  });
}

async function tagsOf(response: Response): Promise<string[]> {
  const json = (await response.json()) as { message: { content: string } };
  return (JSON.parse(json.message.content) as { tags: string[] }).tags;
}

const imageA = Buffer.from('image-a').toString('base64');
const imageB = Buffer.from('image-b').toString('base64');

afterEach(async () => {
  await provider?.close();
  provider = undefined;
});

describe('mock provider', () => {
  it('keeps only the latest recorded requests in the same array', async () => {
    const mock = await start({ maxRecorded: 2 });
    const recorded = mock.requests;
    for (const path of ['/a', '/b', '/c']) await (await fetch(`${mock.url}${path}`)).text();
    expect(mock.requests).toBe(recorded);
    expect(mock.requests.map((entry) => entry.path)).toEqual(['/b', '/c']);
    expect(MOCK_MAX_RECORDED).toBeGreaterThanOrEqual(100);
  });

  it('lists a vision model, a text model and one without capabilities', async () => {
    const { url } = await start();
    const response = await fetch(`${url}/api/tags`);
    expect(await response.json()).toEqual({
      models: [
        { name: 'mock-vision', model: 'mock-vision' },
        { name: MOCK_TEXT_MODEL, model: MOCK_TEXT_MODEL },
        { name: MOCK_LEGACY_MODEL, model: MOCK_LEGACY_MODEL },
      ],
    });
  });

  it('shows the capabilities of each model', async () => {
    const { url } = await start();
    const show = async (model: string) => {
      const response = await fetch(`${url}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    expect(await show(MOCK_MODEL)).toMatchObject({ status: 200, body: { capabilities: ['completion', 'vision'] } });
    expect(await show(MOCK_TEXT_MODEL)).toMatchObject({ status: 200, body: { capabilities: ['completion'] } });
    const legacy = await show(MOCK_LEGACY_MODEL);
    expect(legacy.status).toBe(200);
    expect(legacy.body).not.toHaveProperty('capabilities');
    expect((await show('other')).status).toBe(404);
  });

  it('answers a chat without format in plain text, the same for the same image', async () => {
    const { url } = await start();
    const describe = async (image: string) => {
      const response = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MOCK_MODEL,
          stream: false,
          messages: [{ role: 'user', content: 'x', images: [image] }],
        }),
      });
      return ((await response.json()) as { message: { content: string } }).message.content;
    };
    const first = await describe(imageA);
    expect(first.length).toBeGreaterThan(0);
    expect(() => JSON.parse(first) as unknown).toThrow();
    expect(await describe(imageA)).toBe(first);
    expect(await describe(imageB)).not.toBe(first);
  });

  it('requires the bearer key when one is set, and never logs it', async () => {
    const lines: string[] = [];
    const { url } = await start({ apiKey: KEY, log: (line) => void lines.push(line) });
    const auth = { authorization: `Bearer ${KEY}` };
    expect((await fetch(`${url}/api/tags`)).status).toBe(401);
    expect((await fetch(`${url}/api/tags`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${url}/api/tags`, { headers: { authorization: KEY } })).status).toBe(401);
    expect((await chat(url, imageA)).status).toBe(401);
    expect((await fetch(`${url}/api/tags`, { headers: auth })).status).toBe(200);
    const authorized = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({
        model: MOCK_MODEL,
        format: {},
        messages: [{ role: 'user', content: 'x', images: [imageA] }],
      }),
    });
    expect(authorized.status).toBe(200);
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(lines.join('\n')).not.toContain(KEY);
    expect(lines.join('\n')).not.toContain('wrong');
  });

  it('needs no key when none is set', async () => {
    const { url } = await start({ apiKey: '' });
    expect((await fetch(`${url}/api/tags`)).status).toBe(200);
  });

  it('answers the same image with the same eight tags and another image with different ones', async () => {
    const { url } = await start();
    const first = await tagsOf(await chat(url, imageA));
    const again = await tagsOf(await chat(url, imageA));
    const other = await tagsOf(await chat(url, imageB));
    expect(first).toEqual(again);
    expect(other).not.toEqual(first);
    expect(first).toHaveLength(8);
    expect(new Set(first.slice(0, 6)).size).toBe(6);
    expect(first.every((tag) => tag === tag.toLowerCase())).toBe(true);
    expect(first[6]).toMatch(/view|close-up/);
  });

  it('takes the first six tags from the vocabulary, then one view and one style', async () => {
    const { url } = await start();
    for (const image of [imageA, imageB]) {
      const tags = await tagsOf(await chat(url, image));
      expect(tags.slice(0, 6).every((tag) => MOCK_VOCABULARY.includes(tag))).toBe(true);
      expect(MOCK_VIEWS).toContain(tags[6]);
      expect(MOCK_STYLES).toContain(tags[7]);
    }
  });

  it('records a chat image as the digest of its bytes, never as the Base64', async () => {
    const { url, requests } = await start();
    await chat(url, imageA);
    const body = requests[0]?.body as { messages: { images: string[] }[] };
    expect(body.messages[0]!.images).toEqual([mockImageDigest(Buffer.from('image-a'))]);
    expect(JSON.stringify(requests)).not.toContain(imageA);
  });

  it('delays a scripted status failure like an answer', async () => {
    const { url } = await start({ delayMs: 50, failures: [503] });
    const started = performance.now();
    expect((await chat(url, imageA)).status).toBe(503);
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('takes a scripted failure before the model is checked', async () => {
    const { url } = await start({ failures: [503] });
    expect((await chat(url, imageA, 'other')).status).toBe(503);
    expect((await chat(url, imageA, 'other')).status).toBe(404);
    expect((await chat(url, imageA)).status).toBe(200);
  });

  it('answers in the shape of Ollama', async () => {
    const { url } = await start();
    const json = (await (await chat(url, imageA)).json()) as Record<string, unknown>;
    expect(json).toMatchObject({ model: 'mock-vision', done: true, message: { role: 'assistant' } });
    expect(typeof json.created_at).toBe('string');
  });

  it('refuses a request without an image', async () => {
    const { url } = await start();
    const response = await chat(url, null);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error');
  });

  it('refuses another model and an unknown path', async () => {
    const { url } = await start();
    expect((await chat(url, imageA, 'other')).status).toBe(404);
    expect((await fetch(`${url}/api/nothing`)).status).toBe(404);
  });

  it('consumes one failure per chat request', async () => {
    const { url } = await start({ failures: [503, 'invalid'] });
    const first = await chat(url, imageA);
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: 'mock failure' });
    const second = await chat(url, imageA);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { message: { content: string } }).message.content).toBe('not json');
    expect(await tagsOf(await chat(url, imageA))).toHaveLength(8);
  });

  it('hangs on request and still closes', async () => {
    const { url, close } = await start({ failures: ['hang'] });
    const outcome = await Promise.race([
      chat(url, imageA).then(
        () => 'answered',
        () => 'aborted',
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 100)),
    ]);
    expect(outcome).toBe('waiting');
    await close();
  });

  it('delays the answer', async () => {
    const { url } = await start({ delayMs: 50 });
    const started = performance.now();
    await chat(url, imageA);
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('records requests with their body', async () => {
    const { url, requests } = await start();
    await chat(url, imageA);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/api/chat' });
    expect((requests[0]?.body as { model: string }).model).toBe('mock-vision');
  });
});

describe('mock provider, OpenAI endpoints', () => {
  const tagSchema = { type: 'json_schema', json_schema: { name: 'tags', schema: { type: 'object' } } };

  function completions(
    url: string,
    options: { model?: string; image?: string | null; responseFormat?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const { model = MOCK_MODEL, image = imageA, responseFormat, headers = {} } = options;
    const content: unknown[] = [{ type: 'text', text: 'Answer as JSON.' }];
    if (image !== null) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } });
    return fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
      }),
    });
  }

  async function contentOf(response: Response): Promise<string | null> {
    const json = (await response.json()) as { choices: { message: { content: string | null } }[] };
    return json.choices[0]?.message.content ?? null;
  }

  async function ollamaContent(url: string, format: boolean): Promise<string> {
    const response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MOCK_MODEL,
        ...(format ? { format: { type: 'object' } } : {}),
        messages: [{ role: 'user', content: 'x', images: [imageA] }],
      }),
    });
    return ((await response.json()) as { message: { content: string } }).message.content;
  }

  it('lists the models in a fixed order, without changing the Ollama list', async () => {
    const { url } = await start();
    const response = await fetch(`${url}/v1/models`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: 'list',
      data: [
        MOCK_MODEL,
        MOCK_TEXT_MODEL,
        MOCK_LEGACY_MODEL,
        MOCK_THINKING_MODEL,
        MOCK_FENCED_MODEL,
        MOCK_REASONING_ONLY_MODEL,
        MOCK_SLASH_MODEL,
      ].map((id) => ({ id, object: 'model' })),
    });
    expect(MOCK_SLASH_MODEL).toBe('Qwen/Mock-VL:7B');
    const tags = (await (await fetch(`${url}/api/tags`)).json()) as { models: unknown[] };
    expect(tags.models).toHaveLength(3);
  });

  it('answers in the shape of a chat completion', async () => {
    const { url } = await start();
    const json = (await (await completions(url, { responseFormat: tagSchema })).json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant' }, finish_reason: 'stop' }],
    });
    expect(typeof json.id).toBe('string');
  });

  it('answers the same tag JSON and the same text as the Ollama chat for the same image', async () => {
    const { url } = await start();
    const json = await contentOf(await completions(url, { responseFormat: tagSchema }));
    expect(json).toBe(await ollamaContent(url, true));
    const text = await contentOf(await completions(url));
    expect(text).toBe(await ollamaContent(url, false));
    expect(() => JSON.parse(text ?? '') as unknown).toThrow();
    expect(await contentOf(await completions(url, { model: MOCK_SLASH_MODEL, responseFormat: tagSchema }))).toBe(json);
  });

  it('prefixes a think block, fences JSON and answers reasoning only', async () => {
    const { url } = await start();
    const json = await ollamaContent(url, true);
    const text = await ollamaContent(url, false);
    const think = '<think>\nmock reasoning\n</think>\n\n';
    expect(await contentOf(await completions(url, { model: MOCK_THINKING_MODEL, responseFormat: tagSchema }))).toBe(
      think + json,
    );
    expect(await contentOf(await completions(url, { model: MOCK_THINKING_MODEL }))).toBe(think + text);
    expect(await contentOf(await completions(url, { model: MOCK_FENCED_MODEL, responseFormat: tagSchema }))).toBe(
      '```json\n' + json + '\n```',
    );
    expect(await contentOf(await completions(url, { model: MOCK_FENCED_MODEL }))).toBe(text);
    const reasoning = (await (
      await completions(url, { model: MOCK_REASONING_ONLY_MODEL, responseFormat: tagSchema })
    ).json()) as {
      choices: { message: Record<string, unknown> }[];
    };
    expect(reasoning.choices[0]?.message).toEqual({
      role: 'assistant',
      content: null,
      reasoning_content: 'mock reasoning',
    });
  });

  it('refuses an unknown model and a request without an image', async () => {
    const { url } = await start();
    expect((await completions(url, { model: 'other' })).status).toBe(404);
    const noImage = await completions(url, { image: null });
    expect(noImage.status).toBe(400);
    expect(await noImage.json()).toHaveProperty('error');
  });

  it('requires the bearer key when one is set, and never logs it', async () => {
    const lines: string[] = [];
    const { url } = await start({ apiKey: KEY, log: (line) => void lines.push(line) });
    const auth = { authorization: `Bearer ${KEY}` };
    expect((await fetch(`${url}/v1/models`)).status).toBe(401);
    expect((await completions(url, { headers: { authorization: 'Bearer test-key-not-real-2' } })).status).toBe(401);
    expect((await fetch(`${url}/v1/models`, { headers: auth })).status).toBe(200);
    expect((await completions(url, { headers: auth })).status).toBe(200);
    expect(lines).toEqual([
      'GET /v1/models 401',
      'POST /v1/chat/completions 401',
      'GET /v1/models 200',
      'POST /v1/chat/completions 200',
    ]);
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('refuses response_format when asked to, and then answers the tag JSON without it', async () => {
    const { url } = await start({ refuseResponseFormat: true });
    const refused = await completions(url, { responseFormat: tagSchema });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toHaveProperty('error');
    expect(await contentOf(await completions(url))).toBe(await ollamaContent(url, true));
    expect(await contentOf(await completions(url, { model: MOCK_FENCED_MODEL }))).toBe(
      '```json\n' + (await ollamaContent(url, true)) + '\n```',
    );
  });

  it('shares the failure queue with the Ollama chat', async () => {
    const { url } = await start({ failures: [500, 503, 'invalid'] });
    const failed = await completions(url, { responseFormat: tagSchema });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'mock failure' });
    expect((await chat(url, imageA)).status).toBe(503);
    const invalid = await completions(url, { responseFormat: tagSchema });
    expect(invalid.status).toBe(200);
    expect(await contentOf(invalid)).toBe('not json');
    expect(await contentOf(await completions(url, { responseFormat: tagSchema }))).toBe(await ollamaContent(url, true));
  });

  it('delays the answer', async () => {
    const { url } = await start({ delayMs: 50 });
    const started = performance.now();
    await completions(url);
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('records requests with their parsed body', async () => {
    const { url, requests } = await start();
    await completions(url, { responseFormat: tagSchema });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/v1/chat/completions' });
    expect(requests[0]?.body).toMatchObject({ model: MOCK_MODEL, response_format: tagSchema });
  });
});

/** A valid greyscale PNG of the given size; only its IHDR matters to the mock. */
function png(width: number, height: number): Buffer {
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
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Checks the PNG signature, every chunk CRC and the image data, and answers the IHDR size. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let offset = 8;
  const types: string[] = [];
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    expect(bytes.readUInt32BE(offset + 8 + length)).toBe(crc32(bytes.subarray(offset + 4, offset + 8 + length)));
    if (type === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length));
    types.push(type);
    offset += 12 + length;
  }
  expect(types[0]).toBe('IHDR');
  expect(types.at(-1)).toBe('IEND');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const channels = bytes[25] === 2 ? 3 : bytes[25] === 6 ? 4 : 1;
  expect(inflateSync(Buffer.concat(data)).length).toBe(height * (1 + width * channels));
  return { width, height };
}

function form(fields: Record<string, string>, image: Buffer | null = png(32, 32)): FormData {
  const body = new FormData();
  if (image) body.append('image', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'image.png');
  for (const [name, value] of Object.entries(fields)) body.append(name, value);
  return body;
}

describe('mock provider, Venice endpoints', () => {
  const auth = { authorization: `Bearer ${KEY}` };

  function edit(
    url: string,
    fields: Record<string, string>,
    headers: Record<string, string> = auth,
  ): Promise<Response> {
    return fetch(`${url}/api/v1/image/edit`, { method: 'POST', headers, body: form(fields) });
  }

  it('lists both edit models with their constraints', async () => {
    const { url } = await start({ apiKey: KEY });
    const response = await fetch(`${url}/api/v1/models?type=inpaint`, { headers: auth });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { data: { id: string; model_spec: Record<string, unknown> }[] };
    expect(json.data.map((model) => model.id)).toEqual([MOCK_EDIT_MODEL, MOCK_EDIT_BASIC_MODEL]);
    expect(json.data[0]?.model_spec).toMatchObject({
      constraints: {
        aspectRatios: ['1:1', '16:9', '9:16'],
        resolutions: ['1K', '2K', '4K'],
        defaultResolution: '1K',
        promptCharacterLimit: 1500,
      },
      pricing: expect.any(Object) as unknown,
    });
    expect(json.data[1]?.model_spec).not.toHaveProperty('constraints');
    expect(json.data[1]?.model_spec).not.toHaveProperty('pricing');
  });

  it('answers an edit at 16:9 and 2K with a PNG of 128 x 72', async () => {
    const { url, imageRequests } = await start({ apiKey: KEY });
    const fields = {
      prompt: 'a red chair',
      model: MOCK_EDIT_MODEL,
      aspect_ratio: '16:9',
      resolution: '2K',
      output_format: 'png',
      safe_mode: 'true',
    };
    const response = await edit(url, fields);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(pngSize(Buffer.from(await response.arrayBuffer()))).toEqual({ width: 128, height: 72 });
    expect(imageRequests).toEqual([
      { path: '/api/v1/image/edit', authorization: `Bearer ${KEY}`, fields, fileBytes: png(32, 32).length },
    ]);
  });

  it('shapes the edit by resolution and aspect ratio, the same for the same request', async () => {
    const { url } = await start();
    const size = async (fields: Record<string, string>) => {
      const response = await edit(url, { prompt: 'p', model: MOCK_EDIT_MODEL, ...fields }, {});
      return pngSize(Buffer.from(await response.arrayBuffer()));
    };
    expect(await size({})).toEqual({ width: 64, height: 64 });
    expect(await size({ resolution: '4K', aspect_ratio: '9:16' })).toEqual({ width: 144, height: 256 });
    const bytes = async () =>
      Buffer.from(await (await edit(url, { prompt: 'p', model: MOCK_EDIT_MODEL }, {})).arrayBuffer());
    expect(await bytes()).toEqual(await bytes());
  });

  it('refuses an unknown model, a ratio the model does not offer and a missing image', async () => {
    const { url } = await start();
    expect((await edit(url, { prompt: 'p', model: 'other' }, {})).status).toBe(400);
    expect((await edit(url, { prompt: 'p', model: MOCK_EDIT_MODEL, aspect_ratio: '4:3' }, {})).status).toBe(400);
    expect((await edit(url, { prompt: 'p', model: MOCK_EDIT_BASIC_MODEL, aspect_ratio: '4:3' }, {})).status).toBe(200);
    const noImage = await fetch(`${url}/api/v1/image/edit`, {
      method: 'POST',
      body: form({ prompt: 'p', model: MOCK_EDIT_MODEL }, null),
    });
    expect(noImage.status).toBe(400);
  });

  it('answers an upscale x4 of a 64 x 64 PNG with 256 x 256', async () => {
    const { url, imageRequests } = await start({ apiKey: KEY });
    const response = await fetch(`${url}/api/v1/image/upscale`, {
      method: 'POST',
      headers: auth,
      body: form({ scale: '4' }, png(64, 64)),
    });
    expect(response.status).toBe(200);
    expect(pngSize(Buffer.from(await response.arrayBuffer()))).toEqual({ width: 256, height: 256 });
    expect(imageRequests).toEqual([
      {
        path: '/api/v1/image/upscale',
        authorization: `Bearer ${KEY}`,
        fields: { scale: '4' },
        fileBytes: png(64, 64).length,
      },
    ]);
  });

  it('upscales another format from a 32 x 32 base and refuses another scale', async () => {
    const { url } = await start();
    const response = await fetch(`${url}/api/v1/image/upscale`, {
      method: 'POST',
      body: form({ scale: '2' }, Buffer.from('not a png')),
    });
    expect(pngSize(Buffer.from(await response.arrayBuffer()))).toEqual({ width: 64, height: 64 });
    expect((await fetch(`${url}/api/v1/image/upscale`, { method: 'POST', body: form({ scale: '3' }) })).status).toBe(
      400,
    );
  });

  it('answers each trigger prompt with its status', async () => {
    const { url } = await start({ apiKey: KEY });
    const status = async (prompt: string) => {
      const response = await edit(url, { prompt, model: MOCK_EDIT_MODEL });
      await response.arrayBuffer();
      return { status: response.status, violation: response.headers.get('x-venice-is-content-violation') };
    };
    expect(await status(MOCK_PROMPT_NO_BALANCE)).toEqual({ status: 402, violation: null });
    expect(await status(MOCK_PROMPT_VIOLATION)).toEqual({ status: 422, violation: 'true' });
    expect(await status(MOCK_PROMPT_BUSY)).toEqual({ status: 429, violation: null });
    expect(await status(MOCK_PROMPT_FAIL)).toEqual({ status: 500, violation: null });
    expect(await status(MOCK_PROMPT_VIOLATION_OK)).toEqual({ status: 200, violation: 'true' });
  });

  it('holds a slow prompt until it is closed', async () => {
    const { url, close } = await start();
    const pending = edit(url, { prompt: MOCK_PROMPT_SLOW, model: MOCK_EDIT_MODEL }, {}).then(
      (response) => String(response.status),
      () => 'aborted',
    );
    const outcome = await Promise.race([
      pending,
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 100)),
    ]);
    expect(outcome).toBe('waiting');
    await close();
    expect(await pending).not.toBe('waiting');
  });

  it('answers a wrong key with 401', async () => {
    const { url, imageRequests } = await start({ apiKey: KEY });
    const wrong = { authorization: 'Bearer test-key-not-real-2' };
    expect((await edit(url, { prompt: 'p', model: MOCK_EDIT_MODEL }, wrong)).status).toBe(401);
    expect((await fetch(`${url}/api/v1/models?type=inpaint`, { headers: wrong })).status).toBe(401);
    const upscale = await fetch(`${url}/api/v1/image/upscale`, {
      method: 'POST',
      headers: wrong,
      body: form({ scale: '2' }),
    });
    expect(upscale.status).toBe(401);
    expect(imageRequests.map((request) => request.authorization)).toEqual([
      'Bearer test-key-not-real-2',
      'Bearer test-key-not-real-2',
    ]);
  });
});
