import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_MODEL, startMockProvider, type MockProvider } from '../../../docker/mock-provider/server.mjs';

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
    body: JSON.stringify({ model, stream: false, messages: [message] }),
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
  it('lists the mock model', async () => {
    const { url } = await start();
    const response = await fetch(`${url}/api/tags`);
    expect(await response.json()).toEqual({ models: [{ name: 'mock-vision', model: 'mock-vision' }] });
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
