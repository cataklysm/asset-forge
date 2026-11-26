import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
