import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANALYZE_FILE_JOB, DEFAULT_PROVIDER_OPTIONS, type JobSummary, type ProviderView } from '@assetforge/contracts';
import { MOCK_MODEL, startMockProvider, type MockProvider } from '../../../docker/mock-provider/server.mjs';
import { createProviderStore } from '../src/main/provider-store.js';
import { providerLaneLimit } from '../src/main/lane-limits.js';
import {
  createHarness,
  filesBelow,
  NONE_SKIPPED,
  startTwoMocks,
  TEST_KEY,
  TEST_KEY_2,
  type Harness,
} from './analysis-harness.js';
import { FakeCodec } from './fake-codec.js';

const active = (s: JobSummary) => s.queued + s.running + s.waiting;
const page = { limit: 100, offset: 0 };

describe('several vision providers', () => {
  let h: Harness;
  let mocks: Awaited<ReturnType<typeof startTwoMocks>> | undefined;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
    await mocks?.close();
    mocks = undefined;
  });

  const workspaceRoot = () => join(h.base, 'workspace');
  const createWorkspace = () => h.ok('workspace:create', { name: 'Analysis', rootPath: workspaceRoot() });
  const request = (fileIds: string[], providerId?: string) => ({
    target: { kind: 'files' as const, fileIds },
    model: MOCK_MODEL,
    mode: 'apply' as const,
    force: true,
    ...(providerId === undefined ? {} : { providerId }),
  });
  const chats = (mock: MockProvider) => mock.requests.filter((r) => r.path === '/api/chat');
  const laneOf = async (providerId: string) => (await h.ok('jobs:list', { ...page, providerId })).items;
  /** Entry A on mock A with key A and entry B on mock B with key B. */
  async function twoEntries(
    o: Parameters<typeof startTwoMocks>[0] = {},
  ): Promise<{ a: ProviderView; b: ProviderView }> {
    mocks = await startTwoMocks(o);
    const a = await h.provider({ name: 'A', url: mocks.a.url, apiKey: TEST_KEY });
    const b = await h.provider({ name: 'B', url: mocks.b.url, apiKey: TEST_KEY_2 });
    return { a, b };
  }

  it('analyses the jobs of each entry on its own mock, one at a time per entry and both entries at once', async () => {
    const { a, b } = await twoEntries({ delayMs: 300 });
    await createWorkspace();
    const forA = await h.importImages(2, 'a');
    const forB = await h.importImages(2, 'b');
    expect(await h.ok('analysis:enqueue', request(forA, a.id))).toEqual({ enqueued: 2, skipped: NONE_SKIPPED });
    expect(await h.ok('analysis:enqueue', request(forB, b.id))).toEqual({ enqueued: 2, skipped: NONE_SKIPPED });

    await h.until((s) => s.running === 2);
    await h.until((s) => s.succeeded === 4 && active(s) === 0);

    expect(chats(mocks!.a)).toHaveLength(2);
    expect(chats(mocks!.b)).toHaveLength(2);
    for (const r of mocks!.a.requests) expect(r.headers['authorization']).toBe(`Bearer ${TEST_KEY}`);
    for (const r of mocks!.b.requests) expect(r.headers['authorization']).toBe(`Bearer ${TEST_KEY_2}`);
    expect((await laneOf(a.id)).map((j) => j.fileId).sort()).toEqual([...forA].sort());
    expect((await laneOf(b.id)).map((j) => j.fileId).sort()).toEqual([...forB].sort());
    for (const job of await laneOf(a.id)) expect(job).toMatchObject({ providerId: a.id, providerName: 'A' });

    for (const key of [TEST_KEY, TEST_KEY_2]) {
      for (const response of h.responses) expect(response).not.toContain(key);
      for (const line of h.logs) expect(line).not.toContain(key);
    }
    await h.manager.close();
    for (const file of await filesBelow(h.base)) {
      expect(file.text, file.path).not.toContain(TEST_KEY);
      expect(file.text, file.path).not.toContain(TEST_KEY_2);
    }
  });

  it('pauses only the entry whose mock is gone and moves its waiting jobs onto the other one', async () => {
    const { a, b } = await twoEntries();
    await mocks!.a.close();
    await createWorkspace();
    const forA = await h.importImages(4, 'a');
    const forB = await h.importImages(2, 'b');
    await h.ok('analysis:enqueue', request(forA, a.id));
    await h.ok('analysis:enqueue', request(forB, b.id));

    const paused = await h.until((s) => s.paused.length > 0 && s.succeeded === 2);
    expect(paused).toMatchObject({ waiting: 3, queued: 1, running: 0 });
    expect(paused.paused).toEqual([
      { providerId: a.id, providerName: 'A', kind: 'ollama', reason: 'provider_unreachable' },
    ]);
    expect(await h.ok('jobs:waitingByProvider', {})).toEqual([{ providerId: a.id, providerName: 'A', waiting: 4 }]);

    expect(await h.ok('jobs:reroute', { fromProviderId: a.id, toProviderId: b.id, model: MOCK_MODEL })).toEqual({
      moved: 4,
    });
    await h.until((s) => s.succeeded === 6 && active(s) === 0);
    expect(chats(mocks!.b)).toHaveLength(6);
    expect((await laneOf(b.id)).map((j) => j.providerName)).toEqual(Array(6).fill('B'));
    expect(await h.ok('jobs:reroute', { fromProviderId: a.id, toProviderId: b.id, model: MOCK_MODEL })).toEqual({
      moved: 0,
    });
  });

  it('fails the jobs of an entry deleted while no workspace was open and lets them move from its gone id', async () => {
    const { a, b } = await twoEntries({ failuresA: ['hang'] });
    await createWorkspace();
    const fileIds = await h.importImages(3);
    await h.ok('analysis:enqueue', request(fileIds, a.id));
    await h.until((s) => s.running === 1 && chats(mocks!.a).length === 1);
    // Closing puts the hanging job back in the queue; without a workspace nothing guards the delete.
    await h.ok('workspace:close', {});
    expect(await h.ok('providers:delete', { id: a.id })).toEqual({});

    await h.ok('workspace:open', { rootPath: workspaceRoot() });
    const paused = await h.until((s) => s.paused.length > 0);
    expect(paused).toMatchObject({ failed: 1, queued: 2 });
    expect(paused.paused).toEqual([
      { providerId: a.id, providerName: 'A', kind: 'ollama', reason: 'provider_not_configured' },
    ]);
    const [failed] = (await h.ok('jobs:list', { ...page, status: 'failed' })).items;
    expect(failed).toMatchObject({ errorCode: 'provider_not_configured', providerId: a.id, providerName: 'A' });

    // A new entry with the old name is another provider: it gets none of the jobs.
    const again = await h.ok('providers:save', {
      name: 'A',
      baseUrl: mocks!.a.url,
      timeoutSeconds: 30,
      taggingModel: null,
      promptModel: null,
    });
    expect(again.id).not.toBe(a.id);
    expect(await laneOf(again.id)).toEqual([]);
    expect((await h.ok('jobs:summary', {})).paused).toEqual(paused.paused);

    expect(await h.ok('jobs:reroute', { fromProviderId: a.id, toProviderId: b.id, model: MOCK_MODEL })).toEqual({
      moved: 2,
    });
    await h.until((s) => s.succeeded === 2 && active(s) === 0);
    expect(chats(mocks!.b)).toHaveLength(2);
  });

  describe('active jobs without a provider', () => {
    /** One v1, one v2 and one v3 analysis job without a lane, written while no scheduler runs. */
    async function unroutedJobs(): Promise<string[]> {
      await createWorkspace();
      const fileIds = await h.importImages(3);
      await h.ok('workspace:close', {});
      await h.manager.open({ rootPath: workspaceRoot() });
      const payloads = [
        { version: 1 },
        { version: 2, model: 'legacy-model', mode: 'propose' },
        { version: 3, model: MOCK_MODEL, mode: 'apply', prompt: { name: 'Armour', text: 'Only armour.', maxTags: 3 } },
      ];
      await h.manager.read((s) =>
        s.database.jobs.enqueue({
          jobs: payloads.map((payload, i) => ({
            id: randomUUID(),
            type: ANALYZE_FILE_JOB,
            resourceClass: 'local_gpu' as const,
            fileId: fileIds[i]!,
            lane: null,
            payload,
            dedupeKey: `${ANALYZE_FILE_JOB}:${fileIds[i]}`,
          })),
          now: new Date().toISOString(),
        }),
      );
      await h.manager.close();
      return fileIds;
    }
    const payloadsByFile = () =>
      h.manager.read(async (s) => {
        const { items } = await s.database.jobs.list(page);
        const out = new Map<string, unknown>();
        for (const j of items) out.set(j.fileId!, (await s.database.jobs.get(j.id))!.payload);
        return out;
      });

    it('belong to the first entry after opening, with v4 payloads', async () => {
      mocks = await startTwoMocks({ failuresA: ['hang', 'hang', 'hang'] });
      const first = await h.provider({ name: 'First', url: mocks.a.url, apiKey: TEST_KEY, taggingModel: MOCK_MODEL });
      await h.provider({ name: 'Second', url: mocks.b.url, apiKey: TEST_KEY_2 });
      const fileIds = await unroutedJobs();

      await h.ok('workspace:open', { rootPath: workspaceRoot() });
      const jobs = await laneOf(first.id);
      expect(jobs).toHaveLength(3);
      const payloads = await payloadsByFile();
      expect(payloads.get(fileIds[0]!)).toEqual({
        version: 4,
        model: MOCK_MODEL,
        mode: 'apply',
        prompt: null,
        providerName: 'First',
      });
      expect(payloads.get(fileIds[1]!)).toEqual({
        version: 4,
        model: 'legacy-model',
        mode: 'propose',
        prompt: null,
        providerName: 'First',
      });
      expect(payloads.get(fileIds[2]!)).toEqual({
        version: 4,
        model: MOCK_MODEL,
        mode: 'apply',
        prompt: { name: 'Armour', text: 'Only armour.', maxTags: 3 },
        providerName: 'First',
      });
      await h.until((s) => s.running === 1 && chats(mocks!.a).length === 1);
      expect(chats(mocks!.b)).toEqual([]);
    });

    it('run on the first entry: v1 and v3 apply their tags, v2 asks for its own model', async () => {
      mocks = await startTwoMocks();
      await h.provider({ name: 'First', url: mocks.a.url, apiKey: TEST_KEY, taggingModel: MOCK_MODEL });
      const fileIds = await unroutedJobs();

      await h.ok('workspace:open', { rootPath: workspaceRoot() });
      // The v2 job keeps its own model, which the mock does not serve, and is not retried.
      await h.until((s) => s.succeeded === 2 && s.failed === 1 && active(s) === 0);
      const jobs = (await h.ok('jobs:list', page)).items;
      expect(jobs.find((j) => j.fileId === fileIds[1])).toMatchObject({
        status: 'failed',
        errorCode: 'provider_rejected',
      });
      expect(
        chats(mocks.a)
          .map((r) => (r.body as { model: string }).model)
          .sort(),
      ).toEqual(['legacy-model', MOCK_MODEL, MOCK_MODEL].sort());
      const files = (await h.ok('files:list', { ...page, scope: { kind: 'all' } })).items;
      const aiTags = (fileId: string) => files.find((f) => f.id === fileId)!.tags.filter((t) => t.origin === 'ai');
      // v1 runs with the legacy text and limit 20, v3 with the copy of its prompt and its limit.
      expect(aiTags(fileIds[0]!).length).toBeGreaterThan(0);
      expect(aiTags(fileIds[0]!).length).toBeLessThanOrEqual(20);
      expect(aiTags(fileIds[2]!).length).toBeGreaterThan(0);
      expect(aiTags(fileIds[2]!).length).toBeLessThanOrEqual(3);
    });

    it('stay without an entry, fail as not configured on the lane without a provider, and resume there', async () => {
      await unroutedJobs();
      await h.ok('workspace:open', { rootPath: workspaceRoot() });

      const paused = await h.until((s) => s.paused.length > 0);
      expect(paused).toMatchObject({ failed: 1, queued: 2 });
      expect(paused.paused).toEqual([
        { providerId: null, providerName: null, kind: 'ollama', reason: 'provider_not_configured' },
      ]);
      const [failed] = (await h.ok('jobs:list', { ...page, status: 'failed' })).items;
      expect(failed).toMatchObject({ errorCode: 'provider_not_configured', providerId: null });
      for (const payload of (await payloadsByFile()).values())
        expect((payload as { version: number }).version).toBeLessThan(4);

      expect(await h.ok('jobs:resume', { providerId: null })).toEqual({});
      await h.until((s) => s.failed === 2 && s.paused.length === 1);
    });
  });

  it('enqueues on the given entry, else the one used last, else the first, and refuses an unknown one', async () => {
    const { a, b } = await twoEntries({ failuresA: ['hang'], failuresB: ['hang'] });
    await createWorkspace();
    const [f1, f2, f3, f4] = await h.importImages(4);
    expect((await h.ok('providers:list', {})).lastUsedId).toBeNull();

    await h.ok('analysis:enqueue', request([f1!]));
    expect((await laneOf(a.id)).map((j) => j.fileId)).toEqual([f1]);
    expect((await h.ok('providers:list', {})).lastUsedId).toBe(a.id);

    await h.ok('analysis:enqueue', request([f2!], b.id));
    expect((await h.ok('providers:list', {})).lastUsedId).toBe(b.id);
    await h.ok('analysis:enqueue', request([f3!]));
    expect((await laneOf(b.id)).map((j) => j.fileId).sort()).toEqual([f2!, f3!].sort());

    expect(await h.call('analysis:enqueue', request([f4!], randomUUID()))).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'This provider does not exist' },
    });
    expect(
      await h.call('analysis:preview', {
        target: { kind: 'files', fileIds: [f4!] },
        model: MOCK_MODEL,
        providerId: randomUUID(),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect((await h.ok('providers:list', {})).lastUsedId).toBe(b.id);
    expect((await h.ok('jobs:list', page)).total).toBe(3);
  });

  it('refuses to delete an entry while it has an active job and deletes it after cancel all', async () => {
    const { a } = await twoEntries({ failuresA: ['hang'] });
    await createWorkspace();
    await h.ok('analysis:enqueue', request(await h.importImages(2), a.id));
    await h.until((s) => s.running === 1 && s.queued === 1);

    expect(await h.call('providers:delete', { id: a.id })).toEqual({
      ok: false,
      error: { code: 'invalid_operation', message: 'This provider still has active jobs; move or cancel them first' },
    });
    expect((await h.ok('providers:list', {})).providers.map((p) => p.id)).toContain(a.id);

    await h.ok('jobs:cancelAll', {});
    await h.until((s) => active(s) === 0);
    expect(await h.ok('providers:delete', { id: a.id })).toEqual({});
    expect((await h.ok('providers:list', {})).providers.map((p) => p.name)).toEqual(['B']);
  });

  it('resumes the source lane after a move of at least one job and leaves the target lane paused', async () => {
    mocks = await startTwoMocks();
    const a = await h.provider({ name: 'A', url: mocks.a.url, apiKey: TEST_KEY_2 });
    const b = await h.provider({ name: 'B', url: mocks.b.url, apiKey: TEST_KEY });
    await createWorkspace();
    await h.ok('analysis:enqueue', request(await h.importImages(2, 'a'), a.id));
    await h.until((s) => s.paused.length === 1 && s.paused[0]!.providerId === a.id);
    expect(await h.ok('jobs:reroute', { fromProviderId: a.id, toProviderId: b.id, model: MOCK_MODEL })).toEqual({
      moved: 1,
    });
    const summary = await h.until((s) => s.paused.every((p) => p.providerId !== a.id));
    expect(summary.paused.some((p) => p.providerId === a.id)).toBe(false);
  });

  it('leaves a paused source lane paused when a move finds no waiting job', async () => {
    mocks = await startTwoMocks();
    const a = await h.provider({ name: 'A', url: mocks.a.url, apiKey: TEST_KEY_2 });
    const b = await h.provider({ name: 'B', url: mocks.b.url, apiKey: TEST_KEY });
    await createWorkspace();
    await h.ok('analysis:enqueue', request(await h.importImages(1, 'a'), a.id));
    await h.until((s) => s.paused.length === 1 && s.failed === 1);
    expect(await h.ok('jobs:reroute', { fromProviderId: a.id, toProviderId: b.id, model: MOCK_MODEL })).toEqual({
      moved: 0,
    });
    expect((await h.ok('jobs:summary', {})).paused).toEqual([
      { providerId: a.id, providerName: 'A', kind: 'ollama', reason: 'provider_unauthorized' },
    ]);
  });

  it('filters the job list by entry, shows the current name, refuses a move onto the same entry and resumes only the saved entry', async () => {
    mocks = await startTwoMocks();
    // Each entry holds the other mock's key, so both answer 401 and both entries pause at once.
    const a = await h.provider({ name: 'A', url: mocks.a.url, apiKey: TEST_KEY_2 });
    const b = await h.provider({ name: 'B', url: mocks.b.url, apiKey: TEST_KEY });
    await createWorkspace();
    const forA = await h.importImages(2, 'a');
    const forB = await h.importImages(2, 'b');
    await h.ok('analysis:enqueue', request(forA, a.id));
    await h.ok('analysis:enqueue', request(forB, b.id));
    const paused = await h.until((s) => s.paused.length === 2);
    expect([...paused.paused].sort((x, y) => x.providerName!.localeCompare(y.providerName!))).toEqual([
      { providerId: a.id, providerName: 'A', kind: 'ollama', reason: 'provider_unauthorized' },
      { providerId: b.id, providerName: 'B', kind: 'ollama', reason: 'provider_unauthorized' },
    ]);

    expect((await laneOf(a.id)).map((j) => j.fileId).sort()).toEqual([...forA].sort());
    const renamed = await h.ok('providers:save', {
      id: b.id,
      name: 'Renamed',
      baseUrl: b.baseUrl,
      timeoutSeconds: b.timeoutSeconds,
      taggingModel: null,
      promptModel: null,
    });
    expect(renamed).toMatchObject({ id: b.id, name: 'Renamed', hasApiKey: true });
    for (const job of await laneOf(b.id)) expect(job).toMatchObject({ providerId: b.id, providerName: 'Renamed' });
    // Saving B resumed B; it fails 401 again at once and pauses again.
    await h.until((s) => s.failed === 3 && s.paused.length === 2);

    expect(await h.call('jobs:reroute', { fromProviderId: a.id, toProviderId: a.id, model: MOCK_MODEL })).toEqual({
      ok: false,
      error: { code: 'invalid_operation', message: 'Jobs cannot be moved onto the same provider' },
    });
    expect(
      await h.call('jobs:reroute', { fromProviderId: a.id, toProviderId: randomUUID(), model: MOCK_MODEL }),
    ).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'This provider does not exist' },
    });

    await h.provider({ name: 'A', url: mocks.a.url, apiKey: TEST_KEY });
    const summary = await h.until((s) => s.succeeded === 1 && active(s) === 0);
    expect(summary.paused).toEqual([
      { providerId: b.id, providerName: 'Renamed', kind: 'ollama', reason: 'provider_unauthorized' },
    ]);
    expect(chats(mocks.a).filter((r) => r.headers['authorization'] === `Bearer ${TEST_KEY}`)).toHaveLength(1);
  });
});

describe('a vision provider from the environment', () => {
  let h: Harness | undefined;
  let mock: MockProvider | undefined;

  afterEach(async () => {
    await h?.close();
    await mock?.close();
    h = undefined;
    mock = undefined;
  });

  it('queues on the environment entry, runs the jobs without a key and lists them on its lane', async () => {
    mock = await startMockProvider({ port: 0 });
    h = await createHarness({ env: { ASSETFORGE_VISION_BASE_URL: mock.url, ASSETFORGE_VISION_MODEL: MOCK_MODEL } });
    await h.ok('workspace:create', { name: 'Environment', rootPath: join(h.base, 'workspace') });
    const fileIds = await h.importImages(2);
    const request = { target: { kind: 'files' as const, fileIds }, model: MOCK_MODEL, mode: 'apply' as const };

    expect(await h.ok('analysis:enqueue', { ...request, force: false })).toMatchObject({ enqueued: 2 });
    await h.until((s) => s.succeeded === 2 && active(s) === 0);
    const lane = (await h.ok('jobs:list', { ...page, providerId: 'environment' })).items;
    expect(lane.map((j) => j.fileId).sort()).toEqual([...fileIds].sort());
    const chats = mock.requests.filter((r) => r.path === '/api/chat');
    expect(chats).toHaveLength(2);
    expect(chats.some((r) => r.headers['authorization'] !== undefined)).toBe(false);
  });
});

describe('parallel requests per vision provider', () => {
  let h: Harness;
  let mocks: Awaited<ReturnType<typeof startTwoMocks>> | undefined;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
    await mocks?.close();
    mocks = undefined;
  });

  const chats = (mock: MockProvider) => mock.requests.filter((r) => r.path === '/api/chat');
  const request = (fileIds: string[], providerId: string) => ({
    target: { kind: 'files' as const, fileIds },
    model: MOCK_MODEL,
    mode: 'apply' as const,
    force: true,
    providerId,
  });
  const parallel = (parallelRequests: number) => ({ ...DEFAULT_PROVIDER_OPTIONS, parallelRequests });

  it('answers the value of the vision entry for the analysis class and nothing for other classes and lanes', async () => {
    const store = createProviderStore({ userData: h.userData, secrets: new FakeCodec(), env: {} });
    const limit = providerLaneLimit(store);
    const vision = store.save({
      kind: 'openai',
      name: 'vLLM',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutSeconds: 120,
      taggingModel: null,
      promptModel: null,
      options: parallel(8),
    });
    const plain = store.save({
      name: 'Ollama',
      baseUrl: 'http://127.0.0.1:2',
      timeoutSeconds: 120,
      taggingModel: null,
      promptModel: null,
    });
    const venice = store.save({
      kind: 'venice',
      name: 'Venice',
      baseUrl: 'https://v.example.test/api/v1',
      timeoutSeconds: 120,
      taggingModel: null,
      promptModel: null,
    });
    expect(limit('local_gpu', vision.id)).toBe(8);
    expect(limit('local_gpu', plain.id)).toBe(1);
    expect(limit('local_gpu', venice.id)).toBeUndefined();
    expect(limit('local_gpu', randomUUID())).toBeUndefined();
    expect(limit('local_gpu', null)).toBeUndefined();
    expect(limit('remote_api', venice.id)).toBeUndefined();
    expect(limit('remote_api', vision.id)).toBeUndefined();
    expect(limit('io', vision.id)).toBeUndefined();
    store.save({
      id: vision.id,
      kind: 'openai',
      name: 'vLLM',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutSeconds: 120,
      taggingModel: null,
      promptModel: null,
      options: parallel(2),
    });
    expect(limit('local_gpu', vision.id)).toBe(2);
  });

  it('answers one request at a time for the environment entry', () => {
    const store = createProviderStore({
      userData: h.userData,
      secrets: new FakeCodec(),
      env: { ASSETFORGE_VISION_BASE_URL: 'http://127.0.0.1:11500' },
    });
    expect(providerLaneLimit(store)('local_gpu', 'environment')).toBe(1);
  });

  it('starts waiting jobs after a save with a higher value and never aborts one after a lower value', async () => {
    mocks = await startTwoMocks({ failuresA: Array(6).fill('hang') });
    const a = await h.provider({ name: 'A', url: mocks.a.url, apiKey: TEST_KEY });
    await h.ok('workspace:create', { name: 'Parallel', rootPath: join(h.base, 'workspace') });
    await h.ok('analysis:enqueue', request(await h.importImages(6), a.id));
    await h.until((s) => s.running === 1 && chats(mocks!.a).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await h.ok('jobs:summary', {})).running).toBe(1);

    expect((await h.provider({ name: 'A', url: mocks.a.url, options: parallel(3) })).options?.parallelRequests).toBe(3);
    await h.until((s) => s.running === 3 && s.queued === 3 && chats(mocks!.a).length === 3);

    await h.provider({ name: 'A', url: mocks.a.url, options: parallel(2) });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await h.ok('jobs:summary', {})).toMatchObject({ running: 3, queued: 3, cancelled: 0, failed: 0 });
    expect(chats(mocks.a)).toHaveLength(3);

    for (const r of chats(mocks.a)) expect(JSON.stringify(r.body)).not.toContain('parallel');
    for (const response of h.responses.filter((r) => r.includes('"items"'))) expect(response).not.toContain('parallel');
    await h.ok('jobs:cancelAll', {});
    await h.until((s) => s.running === 0);
    await h.manager.close();
    for (const file of await filesBelow(h.base)) {
      if (file.path.endsWith('provider-settings.json')) continue;
      expect(file.text, file.path).not.toContain('parallelRequests');
    }
    for (const line of h.logs) expect(line).not.toContain('parallel');
  });
});
