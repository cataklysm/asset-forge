import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_MODEL, startMockProvider, type MockProvider } from '../../../docker/mock-provider/server.mjs';
import { createHarness, TEST_KEY, type Harness } from './analysis-harness.js';

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
    await h.ok('settings:setVision', { baseUrl: mock.url, timeoutSeconds: 30, taggingModel: null, promptModel: null, apiKey: TEST_KEY });
    await h.ok('workspace:create', { name: 'Describe', rootPath: join(h.base, 'workspace') });
    const [fileId] = await h.importImages(1);
    const before = await rowCounts();

    // A hangs; B is refused while A runs; cancelling A answers cancelled.
    const first = h.ok('analysis:describe', { requestId: ids.a, fileId: fileId!, model: MOCK_MODEL });
    await chats(1);
    expect(await h.ok('analysis:describe', { requestId: ids.b, fileId: fileId!, model: MOCK_MODEL })).toEqual({ ok: false, code: 'busy' });
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
    await h.ok('settings:setVision', { baseUrl: mock.url, timeoutSeconds: 30, taggingModel: null, promptModel: null, apiKey: TEST_KEY });
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
    expect(await h.ok('analysis:describe', { requestId: ids.c, fileId: fileId!, model: MOCK_MODEL })).toMatchObject({ ok: true });
  });

  it('refuses new requests while the workspace closes', async () => {
    const jpeg = await holdFirstJpeg();
    mock = await startMockProvider({ port: 0, apiKey: TEST_KEY });
    await h.ok('settings:setVision', { baseUrl: mock.url, timeoutSeconds: 30, taggingModel: null, promptModel: null, apiKey: TEST_KEY });
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
    expect(await h.ok('analysis:describe', { requestId: ids.d, fileId: fileId!, model: MOCK_MODEL })).toMatchObject({ ok: true });
  });

  it('maps a provider failure to its code without logging it', async () => {
    mock = await startMockProvider({ port: 0, apiKey: TEST_KEY });
    await h.ok('settings:setVision', { baseUrl: mock.url, timeoutSeconds: 30, taggingModel: null, promptModel: null, apiKey: 'wrong-key-not-real' });
    await h.ok('workspace:create', { name: 'Describe', rootPath: join(h.base, 'workspace') });
    const [fileId] = await h.importImages(1);
    expect(await h.ok('analysis:describe', { requestId: ids.a, fileId: fileId!, model: MOCK_MODEL })).toEqual({
      ok: false,
      code: 'provider_unauthorized',
    });
    for (const line of h.logs) expect(line).not.toContain('wrong-key-not-real');
    expect(h.logs.filter((l) => !l.startsWith('Vision provider failed:'))).toEqual([]);
  });

  it('answers not configured without settings and file_unavailable for an unknown file', async () => {
    mock = await startMockProvider({ port: 0 });
    await h.ok('workspace:create', { name: 'Describe', rootPath: join(h.base, 'workspace') });
    const [fileId] = await h.importImages(1);
    expect(await h.ok('analysis:describe', { requestId: ids.a, fileId: fileId!, model: MOCK_MODEL })).toEqual({
      ok: false,
      code: 'provider_not_configured',
    });
    await h.ok('settings:setVision', { baseUrl: mock.url, timeoutSeconds: 30, taggingModel: null, promptModel: null });
    expect(await h.ok('analysis:describe', { requestId: ids.b, fileId: ids.c, model: MOCK_MODEL })).toEqual({
      ok: false,
      code: 'file_unavailable',
    });
  });
});
