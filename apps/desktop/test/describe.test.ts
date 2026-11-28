import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_MODEL, startMockProvider, type MockProvider } from '../../../docker/mock-provider/server.mjs';
import { MAX_SETTLING_RUNS } from '../src/main/describe-controller.js';
import { createHarness, startTwoMocks, TEST_KEY, TEST_KEY_2, type Harness } from './analysis-harness.js';

const ids = {
  a: '0a2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f',
  b: '1b2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f',
  c: '2c2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f',
  d: '3d2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f',
};

let h: Harness;
let mock: MockProvider;

beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
  await mock.close();
});

async function rowCounts(): Promise<{ jobs: number; analyses: number }> {
  return h.manager.read(async (s) => {
    const jobs = (await s.database.jobs.list({ limit: 1, offset: 0 })).total;
    const files = (await h.ok('files:list', { limit: 100, offset: 0, scope: { kind: 'all' } })).items;
    let analyses = 0;
    for (const file of files) if ((await s.database.analyses.get(file.id)) !== null) analyses++;
    return { jobs, analyses };
  });
}

/** Resolves once the mock has received `n` chat requests. */
async function chats(n: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (mock.requests.filter((r) => r.path === '/api/chat').length < n) {
    if (Date.now() > deadline) throw new Error('The mock never got the request');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function chatContents(): string[] {
  return mock.requests
    .filter((r) => r.path === '/api/chat')
    .map((r) => (r.body as { messages: { content: string }[] }).messages[0]!.content);
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Replaces the harness with one whose model JPEG can be held: after `hold()`, the next JPEG waits
 * until `release()`. `entered` resolves once that JPEG was asked for.
 */
async function holdFirstJpeg(): Promise<{ hold(): void; release(): void; entered: Promise<void> }> {
  let armed = false;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  await h.close();
  h = await createHarness({
    images: {
      jpeg: async (path) => {
        if (armed) {
          armed = false;
          enter();
          await held;
        }
        return readFile(path);
      },
    },
  });
  return { hold: () => (armed = true), release, entered };
}

describe('analysis:describe', () => {
  it('runs one request at a time, cancels on request and on close, and writes nothing', async () => {
    mock = await startMockProvider({ port: 0, apiKey: TEST_KEY, failures: ['hang', 'hang'] });
    await h.provider({ url: mock.url, apiKey: TEST_KEY });
    await h.ok('workspace:create', { name: 'Describe', rootPath: join(h.base, 'workspace') });
    const [fileId] = await h.importImages(1);
    const before = await rowCounts();

    // A hangs; B is refused while A runs; cancelling A answers cancelled.
    const first = h.ok('analysis:describe', { requestId: ids.a, fileId: fileId!, model: MOCK_MODEL });
    await chats(1);
    expect(await h.ok('analysis:describe', { requestId: ids.b, fileId: fileId!, model: MOCK_MODEL })).toEqual({
      ok: false,
      code: 'busy',
    });
    expect(await h.ok('analysis:cancelDescribe', { requestId: ids.b })).toEqual({});
    expect(await h.ok('analysis:cancelDescribe', { requestId: ids.a })).toEqual({});
    expect(await first).toEqual({ ok: false, code: 'cancelled' });

    // C hangs; closing the workspace cancels it.
    const third = h.ok('analysis:describe', { requestId: ids.c, fileId: fileId!, model: MOCK_MODEL });
    await chats(2);
    await h.ok('workspace:close', {});
    expect(await third).toEqual({ ok: false, code: 'cancelled' });

    // D answers with the mock's text.
    await h.ok('workspace:open', { rootPath: join(h.base, 'workspace') });
    const answer = await h.ok('analysis:describe', { requestId: ids.d, fileId: fileId!, model: MOCK_MODEL });
    expect(answer.ok).toBe(true);
    expect(answer.ok && answer.text.length).toBeGreaterThan(0);
    const last = mock.requests.filter((r) => r.path === '/api/chat').at(-1)!;
    expect(last.body).toMatchObject({ model: MOCK_MODEL });
    expect((last.body as { format?: unknown }).format).toBeUndefined();

    expect(await rowCounts()).toEqual(before);
    for (const response of h.responses) expect(response).not.toContain(TEST_KEY);
  });

  it('frees the slot on cancel; the cancelled run never answers the next request', async () => {
    const jpeg = await holdFirstJpeg();
    mock = await startMockProvider({ port: 0, apiKey: TEST_KEY });
    await h.provider({ url: mock.url, apiKey: TEST_KEY });
    await h.ok('workspace:create', { name: 'Describe', rootPath: join(h.base, 'workspace') });
    const [fileId] = await h.importImages(1);

    jpeg.hold();
    const first = h.ok('analysis:describe', { requestId: ids.a, fileId: fileId!, model: MOCK_MODEL });
    await jpeg.entered;
    expect(await h.ok('analysis:cancelDescribe', { requestId: ids.a })).toEqual({});
    // A is still waiting for its JPEG, yet B runs at once and gets the provider's answer.
    const second = await h.ok('analysis:describe', { requestId: ids.b, fileId: fileId!, model: MOCK_MODEL });
    expect(second.ok).toBe(true);
    expect(mock.requests.filter((r) => r.path === '/api/chat')).toHaveLength(1);

    jpeg.release();
    expect(await first).toEqual({ ok: false, code: 'cancelled' });
    // The cancelled run stops before the provider; nothing else reaches it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mock.requests.filter((r) => r.path === '/api/chat')).toHaveLength(1);
    expect(await h.ok('analysis:describe', { requestId: ids.c, fileId: fileId!, model: MOCK_MODEL })).toMatchObject({
      ok: true,
    });
  });

  it('answers busy once too many cancelled runs still settle', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let asked = 0;
    await h.close();
    h = await createHarness({
      images: {
        jpeg: async (path) => {
          asked++;
          await held;
          return readFile(path);
        },
      },
    });
    mock = await startMockProvider({ port: 0, apiKey: TEST_KEY });
    await h.provider({ url: mock.url, apiKey: TEST_KEY });
    await h.ok('workspace:create', { name: 'Describe', rootPath: join(h.base, 'workspace') });
    const [fileId] = await h.importImages(1);

    const requestIds = Array.from({ length: MAX_SETTLING_RUNS }, (_, i) => `${i}a2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e70`);
    const cancelled: Promise<unknown>[] = [];
    for (const requestId of requestIds) {
      cancelled.push(h.ok('analysis:describe', { requestId, fileId: fileId!, model: MOCK_MODEL }));
      await until(() => asked === cancelled.length);
      await h.ok('analysis:cancelDescribe', { requestId });
    }
    expect(await h.ok('analysis:describe', { requestId: ids.a, fileId: fileId!, model: MOCK_MODEL })).toEqual({
      ok: false,
      code: 'busy',
    });
    expect(asked).toBe(MAX_SETTLING_RUNS);

    release();
    for (const result of cancelled) expect(await result).toEqual({ ok: false, code: 'cancelled' });
    await h.services.describe.cancelAll();
    expect(await h.ok('analysis:describe', { requestId: ids.b, fileId: fileId!, model: MOCK_MODEL })).toMatchObject({
      ok: true,
    });
  });

  it('refuses new requests while the workspace closes', async () => {
    const jpeg = await holdFirstJpeg();
    mock = await startMockProvider({ port: 0, apiKey: TEST_KEY });
    await h.provider({ url: mock.url, apiKey: TEST_KEY });
    await h.ok('workspace:create', { name: 'Describe', rootPath: join(h.base, 'workspace') });
    const [fileId] = await h.importImages(1);
    const block = vi.spyOn(h.services.describe, 'block');

    // A holds the close step open while it waits for its JPEG.
    jpeg.hold();
    const first = h.ok('analysis:describe', { requestId: ids.a, fileId: fileId!, model: MOCK_MODEL });
    await jpeg.entered;
    const closing = h.ok('workspace:close', {});
    await until(() => block.mock.calls.length > 0);
    expect(h.manager.current()).not.toBeNull();
    expect(await h.ok('analysis:describe', { requestId: ids.b, fileId: fileId!, model: MOCK_MODEL })).toEqual({
      ok: false,
      code: 'cancelled',
    });

    jpeg.release();
    expect(await first).toEqual({ ok: false, code: 'cancelled' });
    await closing;
    const none = await h.call('analysis:describe', { requestId: ids.c, fileId: fileId!, model: MOCK_MODEL });
    expect(none).toMatchObject({ ok: false, error: { code: 'no_workspace_open' } });
    expect(mock.requests.filter((r) => r.path === '/api/chat')).toHaveLength(0);

    await h.ok('workspace:open', { rootPath: join(h.base, 'workspace') });
    expect(await h.ok('analysis:describe', { requestId: ids.d, fileId: fileId!, model: MOCK_MODEL })).toMatchObject({
      ok: true,
    });
  });

  it('maps a provider failure to its code without logging it', async () => {
    mock = await startMockProvider({ port: 0, apiKey: TEST_KEY });
    await h.provider({ url: mock.url, apiKey: TEST_KEY_2 });
    await h.ok('workspace:create', { name: 'Describe', rootPath: join(h.base, 'workspace') });
    const [fileId] = await h.importImages(1);
    expect(await h.ok('analysis:describe', { requestId: ids.a, fileId: fileId!, model: MOCK_MODEL })).toEqual({
      ok: false,
      code: 'provider_unauthorized',
    });
    for (const line of h.logs) expect(line).not.toContain(TEST_KEY_2);
    expect(h.logs.filter((l) => !/^Vision provider \S+ failed: /.test(l))).toEqual([]);
  });

  it('sends the chosen prompt text and remembers it after an answer, also a failed one', async () => {
    mock = await startMockProvider({ port: 0, apiKey: TEST_KEY });
    await h.provider({ url: mock.url, apiKey: TEST_KEY });
    await h.ok('workspace:create', { name: 'Describe', rootPath: join(h.base, 'workspace') });
    const [fileId] = await h.importImages(1);
    const paint = await h.ok('analysisPrompts:save', { purpose: 'image_prompt', name: 'Paint', text: 'Paint it.' });

    expect(
      await h.ok('analysis:describe', { requestId: ids.a, fileId: fileId!, model: MOCK_MODEL, promptId: paint.id }),
    ).toMatchObject({ ok: true });
    expect(chatContents().at(-1)).toBe('Paint it.');
    expect((await h.ok('analysisPrompts:list', {})).lastUsed.imagePrompt).toBe(paint.id);

    // Without an id the prompt used last runs.
    await h.ok('analysis:describe', { requestId: ids.b, fileId: fileId!, model: MOCK_MODEL });
    expect(chatContents().at(-1)).toBe('Paint it.');

    const sketch = await h.ok('analysisPrompts:save', { purpose: 'image_prompt', name: 'Sketch', text: 'Sketch it.' });
    await h.provider({ url: mock.url, apiKey: TEST_KEY_2 });
    expect(
      await h.ok('analysis:describe', { requestId: ids.c, fileId: fileId!, model: MOCK_MODEL, promptId: sketch.id }),
    ).toEqual({
      ok: false,
      code: 'provider_unauthorized',
    });
    expect((await h.ok('analysisPrompts:list', {})).lastUsed.imagePrompt).toBe(sketch.id);
  });

  it('does not remember a prompt that answered busy, that is unknown or that ran without a workspace', async () => {
    mock = await startMockProvider({ port: 0, apiKey: TEST_KEY, failures: ['hang'] });
    await h.provider({ url: mock.url, apiKey: TEST_KEY });
    const paint = await h.ok('analysisPrompts:save', { purpose: 'image_prompt', name: 'Paint', text: 'Paint it.' });
    const tagging = (await h.ok('analysisPrompts:list', {})).prompts.find((p) => p.purpose === 'tagging')!;
    const lastUsed = async () => (await h.ok('analysisPrompts:list', {})).lastUsed.imagePrompt;

    for (const promptId of [paint.id, ids.d]) {
      expect(
        await h.call('analysis:describe', { requestId: ids.a, fileId: ids.b, model: MOCK_MODEL, promptId }),
      ).toMatchObject({
        ok: false,
        error: { code: 'no_workspace_open' },
      });
    }
    expect(await lastUsed()).toBeNull();

    await h.ok('workspace:create', { name: 'Describe', rootPath: join(h.base, 'workspace') });
    const [fileId] = await h.importImages(1);
    for (const promptId of [ids.d, tagging.id]) {
      expect(
        await h.call('analysis:describe', { requestId: ids.a, fileId: fileId!, model: MOCK_MODEL, promptId }),
      ).toEqual({
        ok: false,
        error: { code: 'not_found', message: 'The analysis prompt does not exist' },
      });
    }
    expect(chatContents()).toEqual([]);

    const first = h.ok('analysis:describe', { requestId: ids.a, fileId: fileId!, model: MOCK_MODEL });
    await chats(1);
    expect(
      await h.ok('analysis:describe', { requestId: ids.b, fileId: fileId!, model: MOCK_MODEL, promptId: paint.id }),
    ).toEqual({
      ok: false,
      code: 'busy',
    });
    expect(await lastUsed()).toBeNull();
    await h.ok('analysis:cancelDescribe', { requestId: ids.a });
    expect(await first).toEqual({ ok: false, code: 'cancelled' });
  });

  it('answers not configured without settings and file_unavailable for an unknown file', async () => {
    mock = await startMockProvider({ port: 0 });
    await h.ok('workspace:create', { name: 'Describe', rootPath: join(h.base, 'workspace') });
    const [fileId] = await h.importImages(1);
    expect(await h.ok('analysis:describe', { requestId: ids.a, fileId: fileId!, model: MOCK_MODEL })).toEqual({
      ok: false,
      code: 'provider_not_configured',
    });
    await h.provider({ url: mock.url });
    expect(await h.ok('analysis:describe', { requestId: ids.b, fileId: ids.c, model: MOCK_MODEL })).toEqual({
      ok: false,
      code: 'file_unavailable',
    });
  });
});

describe('analysis:describe with several providers', () => {
  it('runs against the chosen entry with its key and remembers it, but not after busy or an unknown id', async () => {
    const pair = await startTwoMocks({ failuresB: ['hang'] });
    mock = pair.a;
    try {
      const a = await h.provider({ name: 'A', url: pair.a.url, apiKey: TEST_KEY });
      const b = await h.provider({ name: 'B', url: pair.b.url, apiKey: TEST_KEY_2 });
      await h.ok('workspace:create', { name: 'Describe', rootPath: join(h.base, 'workspace') });
      const [fileId] = await h.importImages(1);
      const lastUsed = async () => (await h.ok('providers:list', {})).lastUsedId;
      const chatsOf = (m: MockProvider) => m.requests.filter((r) => r.path === '/api/chat');

      expect(
        await h.ok('analysis:describe', { requestId: ids.a, fileId: fileId!, model: MOCK_MODEL, providerId: a.id }),
      ).toMatchObject({ ok: true });
      expect(chatsOf(pair.a)).toHaveLength(1);
      expect(chatsOf(pair.b)).toHaveLength(0);
      expect(await lastUsed()).toBe(a.id);

      // B hangs; a second request for A answers busy and leaves B as the entry used last.
      const hanging = h.ok('analysis:describe', {
        requestId: ids.b,
        fileId: fileId!,
        model: MOCK_MODEL,
        providerId: b.id,
      });
      const deadline = Date.now() + 5_000;
      while (chatsOf(pair.b).length === 0) {
        if (Date.now() > deadline) throw new Error('B never got the request');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await lastUsed()).toBe(a.id);
      expect(
        await h.ok('analysis:describe', { requestId: ids.c, fileId: fileId!, model: MOCK_MODEL, providerId: a.id }),
      ).toEqual({
        ok: false,
        code: 'busy',
      });
      await h.ok('analysis:cancelDescribe', { requestId: ids.b });
      expect(await hanging).toEqual({ ok: false, code: 'cancelled' });
      expect(await lastUsed()).toBe(b.id);

      // Without an id the entry used last runs.
      expect(await h.ok('analysis:describe', { requestId: ids.d, fileId: fileId!, model: MOCK_MODEL })).toMatchObject({
        ok: true,
      });
      expect(chatsOf(pair.b)).toHaveLength(2);
      expect(
        await h.call('analysis:describe', { requestId: ids.a, fileId: fileId!, model: MOCK_MODEL, providerId: ids.c }),
      ).toEqual({
        ok: false,
        error: { code: 'not_found', message: 'This provider does not exist' },
      });
      expect(await lastUsed()).toBe(b.id);

      for (const r of pair.a.requests) expect(r.headers['authorization']).toBe(`Bearer ${TEST_KEY}`);
      for (const r of pair.b.requests) expect(r.headers['authorization']).toBe(`Bearer ${TEST_KEY_2}`);
      for (const response of h.responses) {
        expect(response).not.toContain(TEST_KEY);
      }
    } finally {
      await pair.b.close();
    }
  });
});
