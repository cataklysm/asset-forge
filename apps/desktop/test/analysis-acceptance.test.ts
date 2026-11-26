import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANALYZE_FILE_JOB, type IpcChannel, type IpcRequest, type IpcResponse, type JobSummary } from '@assetforge/contracts';
import type { WorkspaceManager } from '@assetforge/core';
import { createPauseGate, DEFAULT_LIMITS } from '@assetforge/jobs';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { createOllamaVision, OLLAMA_PROVIDER } from '@assetforge/providers';
import { MOCK_MODEL, startMockProvider, type MockProvider } from '../../../docker/mock-provider/server.mjs';
import { createWorkspaceManager } from '../src/main/composition.js';
import { createWorkspaceHandlers, dispatch } from '../src/main/ipc.js';
import { createJobHost } from '../src/main/job-host.js';
import { createHarness, filesBelow, NONE_SKIPPED, TEST_KEY, type Harness } from './analysis-harness.js';
import { servicesWithPrompts } from './idle-job-host.js';

/** The tags the mock answers for these image bytes. */
async function mockTagsOf(mock: MockProvider, bytes: Uint8Array, headers: Record<string, string> = {}): Promise<string[]> {
  const response = await fetch(`${mock.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      model: MOCK_MODEL,
      stream: false,
      format: { type: 'object' },
      messages: [{ role: 'user', content: 'tag', images: [Buffer.from(bytes).toString('base64')] }],
    }),
  });
  const json = (await response.json()) as { message: { content: string } };
  return (JSON.parse(json.message.content) as { tags: string[] }).tags;
}

const active = (s: JobSummary) => s.queued + s.running + s.waiting;

describe('phase 4a acceptance', () => {
  let base: string;
  let manager: WorkspaceManager;
  let mock: MockProvider;
  /** The phase 4a request shape in the phase 4b contract: an explicit file list, applied. */
  const filesRequest = (fileIds: string[]) => ({ target: { kind: 'files' as const, fileIds }, model: MOCK_MODEL, mode: 'apply' as const, force: true });

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'af-analysis-accept-'));
    manager = createWorkspaceManager({ userDataPath: join(base, 'userData'), migrationsFolder: MIGRATIONS_FOLDER });
    mock = await startMockProvider({ port: 0, delayMs: 150 });
  });
  afterEach(async () => {
    await manager.close();
    await mock.close();
    await rm(base, { recursive: true, force: true });
  });

  it('analyses a batch through cancel, retry and a close mid-batch without touching manual tags', async () => {
    const adapter = createOllamaVision({ baseUrl: mock.url });
    const jobHost = createJobHost({
      manager,
      gateway: { current: () => adapter },
      images: { jpeg: (path) => readFile(path) },
      provider: OLLAMA_PROVIDER,
      defaultModel: () => MOCK_MODEL,
      pause: createPauseGate({}),
      limits: { ...DEFAULT_LIMITS, local_gpu: 1 },
    });
    // While held, opening a workspace does not start its scheduler.
    let holdScheduler = false;
    const handlers = createWorkspaceHandlers(
      manager,
      {
        pickDirectory: async () => null,
        pickFiles: async () => [],
        confirmRemoveWorkspace: async () => 'cancel',
        confirmRemoveWorkflow: async () => false,
      },
      {
        openPath: async () => '',
        showItemInFolder: () => {},
        workspaceOpened: () => (holdScheduler ? Promise.resolve() : jobHost.workspaceOpened()),
        workspaceClosing: () => jobHost.workspaceClosing(),
      },
      jobHost,
      servicesWithPrompts(join(base, 'userData')),
    );
    const call = async <C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> => {
      const result = await dispatch(handlers, channel, request);
      if (!result.ok) throw new Error(`${channel} failed: ${result.error.code}`);
      return result.value as IpcResponse<C>;
    };
    const until = async (check: (s: JobSummary) => boolean): Promise<JobSummary> => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const summary = await call('jobs:summary', {});
        if (check(summary)) return summary;
        if (Date.now() > deadline) throw new Error(`Timed out; last summary ${JSON.stringify(summary)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    try {
      // Six small PNGs with different content.
      const workspaceRoot = join(base, 'workspace');
      const sources = join(base, 'sources');
      await mkdir(sources, { recursive: true });
      const paths: string[] = [];
      for (let i = 0; i < 6; i++) {
        const path = join(sources, `image-${i}.png`);
        const background = { r: i * 40, g: 255 - i * 40, b: (i * 90) % 256 };
        await writeFile(path, await sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer());
        paths.push(path);
      }
      await call('workspace:create', { name: 'Analysis', rootPath: workspaceRoot });
      const imported = await call('files:import', { sourcePaths: paths });
      const fileIds = imported.map((r) => r.file!.id);

      // Two manual tags: one the mock will also return for that image, one it will not.
      const overlapping = (await mockTagsOf(mock, await readFile(paths[0]!)))[0]!;
      await call('files:addTag', { fileId: fileIds[0]!, name: overlapping });
      await call('files:addTag', { fileId: fileIds[1]!, name: 'hand picked' });
      const manual = new Map([
        [fileIds[0]!, overlapping],
        [fileIds[1]!, 'hand picked'],
      ]);

      expect(await call('analysis:enqueue', filesRequest(fileIds))).toEqual({ enqueued: 6, skipped: NONE_SKIPPED });

      // Cancel all while the batch runs.
      await until((s) => s.succeeded >= 1);
      await call('jobs:cancelAll', {});
      const afterCancel = await until((s) => active(s) === 0);
      expect(afterCancel.cancelled).toBeGreaterThanOrEqual(1);

      // Retry the cancelled ones and close the workspace while the next one runs.
      expect(await call('jobs:retryFailed', {})).toEqual({ retried: afterCancel.cancelled });
      await until((s) => s.running === 1);
      const [interrupted] = (await call('jobs:list', { limit: 10, offset: 0, status: 'running' })).items;
      expect(interrupted).toBeDefined();
      await call('workspace:close', {});

      // Reopen without starting the scheduler: the interrupted job is back in the queue, its run not counted.
      holdScheduler = true;
      await call('workspace:open', { rootPath: workspaceRoot });
      expect((await call('jobs:summary', {})).running).toBe(0);
      const jobs = (await call('jobs:list', { limit: 10, offset: 0 })).items;
      expect(jobs.find((j) => j.id === interrupted!.id)).toMatchObject({ status: 'queued', attempt: 0 });

      holdScheduler = false;
      await jobHost.workspaceOpened();
      await until((s) => s.succeeded === 6 && active(s) === 0);

      // Every file has the mock's eight tags as AI tags, minus the one it carries manually.
      const files = (await call('files:list', { limit: 10, offset: 0, scope: { kind: 'all' } })).items;
      expect(files).toHaveLength(6);
      for (const file of files) {
        const expected = (await mockTagsOf(mock, await readFile(paths[fileIds.indexOf(file.id)]!))).filter(
          (name) => name !== manual.get(file.id),
        );
        const ai = file.tags.filter((t) => t.origin === 'ai').map((t) => t.name);
        expect(ai.sort()).toEqual(expected.sort());
        const own = manual.get(file.id);
        const manualTags = file.tags.filter((t) => t.origin === 'manual').map((t) => t.name);
        expect(manualTags).toEqual(own === undefined ? [] : [own]);
        if (own !== undefined) expect(file.tags.filter((t) => t.name === own)).toHaveLength(1);
      }
      expect(files.find((f) => f.id === fileIds[0])!.tags.filter((t) => t.origin === 'ai')).toHaveLength(7);

      for (const fileId of fileIds) {
        expect(await manager.read((s) => s.database.analyses.get(fileId))).toMatchObject({ model: 'mock-vision' });
      }
      expect(mock.requests.some((r) => r.headers['authorization'] !== undefined)).toBe(false);
    } finally {
      await jobHost.workspaceClosing();
    }
  });
});

describe('phase 4b acceptance', () => {
  const WRONG_KEY = 'wrong-key-not-real';
  let h: Harness;
  let mock: MockProvider | undefined;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
    await mock?.close();
    mock = undefined;
  });

  /** Saves the mock as the provider; no default models, so every job runs with the model it was enqueued with. */
  const configure = (url: string, apiKey?: string | null) =>
    h.ok('settings:setVision', {
      baseUrl: url,
      timeoutSeconds: 30,
      taggingModel: null,
      promptModel: null,
      ...(apiKey === undefined ? {} : { apiKey }),
    });
  const createWorkspace = () => h.ok('workspace:create', { name: 'Analysis', rootPath: join(h.base, 'workspace') });
  const filesOf = async () => (await h.ok('files:list', { limit: 100, offset: 0, scope: { kind: 'all' } })).items;

  /** The key occurs in no IPC response, no file below the test directory (database, settings) and no log line. */
  async function expectNoKeyAnywhere(key: string): Promise<void> {
    for (const response of h.responses) expect(response).not.toContain(key);
    for (const line of h.logs) expect(line).not.toContain(key);
    await h.manager.close();
    for (const file of await filesBelow(h.base)) expect(file.text, file.path).not.toContain(key);
  }

  it('analyses a file filter with the chosen model, skips what it analysed and redoes it on force', async () => {
    mock = await startMockProvider({ port: 0, apiKey: TEST_KEY });
    expect(await configure(mock.url, TEST_KEY)).toMatchObject({ baseUrl: mock.url, hasApiKey: true });
    const listed = await h.ok('settings:listVisionModels', {});
    expect(listed).toMatchObject({ ok: true });
    expect(listed.ok && listed.models).toContainEqual({ name: MOCK_MODEL, vision: true });

    await createWorkspace();
    const fileIds = await h.importImages(3);
    const target = { kind: 'fileFilter' as const, filter: { scope: { kind: 'inbox' as const } } };
    expect(await h.ok('analysis:preview', { target, model: MOCK_MODEL })).toEqual({
      analysable: 3,
      alreadyAnalysed: 0,
      alreadyQueued: 0,
      notAnalysable: 0,
    });

    const request = { target, model: MOCK_MODEL, mode: 'apply' as const, force: false };
    expect(await h.ok('analysis:enqueue', request)).toEqual({ enqueued: 3, skipped: NONE_SKIPPED });
    await h.until((s) => s.succeeded === 3);
    for (const file of await filesOf()) expect(file.tags.filter((t) => t.origin === 'ai').length).toBeGreaterThan(0);
    for (const fileId of fileIds) {
      expect(await h.manager.read((s) => s.database.analyses.get(fileId))).toMatchObject({ provider: OLLAMA_PROVIDER, model: MOCK_MODEL });
    }

    expect(await h.ok('analysis:preview', { target, model: MOCK_MODEL })).toMatchObject({ analysable: 0, alreadyAnalysed: 3 });
    expect(await h.ok('analysis:enqueue', request)).toEqual({ enqueued: 0, skipped: { ...NONE_SKIPPED, alreadyAnalysed: 3 } });
    expect(await h.ok('analysis:enqueue', { ...request, force: true })).toEqual({ enqueued: 3, skipped: NONE_SKIPPED });
    await h.until((s) => s.succeeded === 6);

    const chats = mock.requests.filter((r) => r.path === '/api/chat');
    expect(chats).toHaveLength(6);
    for (const chat of chats) expect(chat.body).toMatchObject({ model: MOCK_MODEL });
    // The mock got the key on every request, and it is the only origin there is.
    for (const r of mock.requests) expect(r.headers['authorization']).toBe(`Bearer ${TEST_KEY}`);
    await expectNoKeyAnywhere(TEST_KEY);
  });

  it('keeps a proposal across reopening and applies only the accepted subset', async () => {
    mock = await startMockProvider({ port: 0, apiKey: TEST_KEY });
    await configure(mock.url, TEST_KEY);
    await createWorkspace();
    const [fileId] = await h.importImages(1);
    const propose = { target: { kind: 'files' as const, fileIds: [fileId!] }, model: MOCK_MODEL, mode: 'propose' as const, force: false };

    expect(await h.ok('analysis:enqueue', propose)).toEqual({ enqueued: 1, skipped: NONE_SKIPPED });
    await h.until((s) => s.succeeded === 1);
    const { proposal, job } = await h.ok('analysis:getProposal', { fileId: fileId! });
    expect(proposal).toMatchObject({ model: MOCK_MODEL, stale: false });
    expect(proposal!.tags).toHaveLength(8);
    expect(job).toMatchObject({ fileId, status: 'succeeded', type: ANALYZE_FILE_JOB });
    const [file] = await filesOf();
    expect(file).toMatchObject({ hasProposal: true });
    expect(file!.tags).toEqual([]);

    await h.ok('workspace:close', {});
    await h.ok('workspace:open', { rootPath: join(h.base, 'workspace') });
    expect((await h.ok('analysis:getProposal', { fileId: fileId! })).proposal).toEqual(proposal);

    const chosen = proposal!.tags.slice(0, 2);
    expect(await h.ok('analysis:acceptProposal', { fileId: fileId!, names: chosen.map((t) => t.displayName) })).toEqual({});
    const [after] = await filesOf();
    expect(after!.tags.map((t) => ({ name: t.name, origin: t.origin })).sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      chosen.map((t) => ({ name: t.name, origin: 'ai' })).sort((a, b) => a.name.localeCompare(b.name)),
    );
    expect(after).toMatchObject({ hasProposal: false });
    expect((await h.ok('analysis:getProposal', { fileId: fileId! })).proposal).toBeNull();
    expect(await h.manager.read((s) => s.database.analyses.get(fileId!))).toMatchObject({ model: MOCK_MODEL });
    // Gone: nothing to accept any more.
    expect(await h.call('analysis:acceptProposal', { fileId: fileId!, names: [chosen[0]!.name] })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });

    // A second proposal can be discarded, and the file counts as not analysed by its model again only through file_analysis.
    await h.ok('analysis:enqueue', propose);
    await h.until((s) => s.succeeded === 2);
    expect((await h.ok('analysis:getProposal', { fileId: fileId! })).proposal).not.toBeNull();
    expect(await h.ok('analysis:discardProposal', { fileId: fileId! })).toEqual({});
    expect(await h.ok('analysis:discardProposal', { fileId: fileId! })).toEqual({});
    expect((await h.ok('analysis:getProposal', { fileId: fileId! })).proposal).toBeNull();
    await expectNoKeyAnywhere(TEST_KEY);
  });

  it('pauses on a wrong key across reopening and drains the queue once the right key is saved', async () => {
    mock = await startMockProvider({ port: 0, apiKey: TEST_KEY });
    await configure(mock.url, WRONG_KEY);
    await createWorkspace();
    const fileIds = await h.importImages(3);
    const request = { target: { kind: 'files' as const, fileIds }, model: MOCK_MODEL, mode: 'apply' as const, force: false };
    expect(await h.ok('analysis:enqueue', request)).toMatchObject({ enqueued: 3 });

    const paused = await h.until((s) => s.paused !== null);
    expect(paused).toMatchObject({ paused: { reason: 'provider_unauthorized' }, failed: 1, queued: 2, running: 0 });
    const [failed] = (await h.ok('jobs:list', { limit: 10, offset: 0, status: 'failed' })).items;
    expect(failed).toMatchObject({ errorCode: 'provider_unauthorized' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await h.ok('jobs:summary', {})).toMatchObject({ queued: 2, failed: 1 });
    expect(h.logs).toContain('Vision provider failed: provider_unauthorized (HTTP 401)');

    await h.ok('workspace:close', {});
    await h.ok('workspace:open', { rootPath: join(h.base, 'workspace') });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await h.ok('jobs:summary', {})).toMatchObject({ paused: { reason: 'provider_unauthorized' }, queued: 2 });

    expect(await configure(mock.url, TEST_KEY)).toMatchObject({ hasApiKey: true });
    expect((await h.ok('jobs:summary', {})).paused).toBeNull();
    await h.until((s) => s.succeeded === 2 && s.queued === 0);
    await expectNoKeyAnywhere(TEST_KEY);
    for (const line of h.logs) expect(line).not.toContain(WRONG_KEY);
  });

  it('pauses after three runs with the provider stopped and continues on resume', async () => {
    mock = await startMockProvider({ port: 0 });
    const url = mock.url;
    const port = Number(new URL(url).port);
    await configure(url);
    await mock.close();
    mock = undefined;
    await createWorkspace();
    const fileIds = await h.importImages(4);
    await h.ok('analysis:enqueue', { target: { kind: 'files', fileIds }, model: MOCK_MODEL, mode: 'apply', force: false });

    const paused = await h.until((s) => s.paused !== null);
    expect(paused).toMatchObject({ paused: { reason: 'provider_unreachable' }, waiting: 3, queued: 1, running: 0 });
    for (const job of (await h.ok('jobs:list', { limit: 10, offset: 0, status: 'retry_wait' })).items) {
      expect(job).toMatchObject({ attempt: 1, errorCode: 'provider_unreachable' });
    }

    mock = await startMockProvider({ port });
    expect(await h.ok('jobs:resume', {})).toEqual({});
    expect((await h.ok('jobs:summary', {})).paused).toBeNull();
    await h.until((s) => s.succeeded === 1 && s.queued === 0);
  });

  it('runs a queued phase 4a job with the tagging default', async () => {
    mock = await startMockProvider({ port: 0 });
    await h.ok('settings:setVision', { baseUrl: mock.url, timeoutSeconds: 30, taggingModel: MOCK_MODEL, promptModel: null });
    await createWorkspace();
    const [fileId] = await h.importImages(1);
    await h.manager.read((s) =>
      s.database.jobs.enqueue({
        jobs: [{ id: randomUUID(), type: ANALYZE_FILE_JOB, resourceClass: 'local_gpu', fileId: fileId!, payload: { version: 1 }, dedupeKey: `${ANALYZE_FILE_JOB}:${fileId}` }],
        now: new Date().toISOString(),
      }),
    );
    h.services.jobHost.wake();
    await h.until((s) => s.succeeded === 1);
    expect(await h.manager.read((s) => s.database.analyses.get(fileId!))).toMatchObject({ model: MOCK_MODEL });
  });

  it('fails a job as not configured without settings and environment, and pauses', async () => {
    expect(h.services.gateway.current()).toBeNull();
    expect(await h.ok('settings:getVision', {})).toMatchObject({ baseUrl: null, taggingModel: null, promptModel: null, fromEnvironment: false });
    await createWorkspace();
    const fileIds = await h.importImages(2);
    await h.ok('analysis:enqueue', { target: { kind: 'files', fileIds }, model: MOCK_MODEL, mode: 'apply', force: false });
    const summary = await h.until((s) => s.paused !== null);
    expect(summary).toMatchObject({ paused: { reason: 'provider_not_configured' }, failed: 1, queued: 1 });
    const [failed] = (await h.ok('jobs:list', { limit: 10, offset: 0, status: 'failed' })).items;
    expect(failed).toMatchObject({ errorCode: 'provider_not_configured' });
  });

  it('drops the key when the origin changes, so another server never receives it', async () => {
    mock = await startMockProvider({ port: 0, apiKey: TEST_KEY });
    const other = await startMockProvider({ port: 0 });
    try {
      await configure(mock.url, TEST_KEY);
      expect(await h.ok('settings:listVisionModels', {})).toMatchObject({ ok: true });
      expect(await configure(other.url)).toMatchObject({ baseUrl: other.url, hasApiKey: false });
      expect(await h.ok('settings:listVisionModels', {})).toMatchObject({ ok: true });
      expect(other.requests.length).toBeGreaterThan(0);
      for (const r of other.requests) expect(r.headers['authorization']).toBeUndefined();
      for (const r of mock.requests) expect(r.headers['authorization']).toBe(`Bearer ${TEST_KEY}`);
      await expectNoKeyAnywhere(TEST_KEY);
    } finally {
      await other.close();
    }
  });
});

describe('editable prompts acceptance', () => {
  let h: Harness;
  let mock: MockProvider;

  beforeEach(async () => {
    h = await createHarness();
    mock = await startMockProvider({ port: 0 });
    await h.ok('settings:setVision', { baseUrl: mock.url, timeoutSeconds: 30, taggingModel: null, promptModel: null });
    await h.ok('workspace:create', { name: 'Analysis', rootPath: join(h.base, 'workspace') });
  });
  afterEach(async () => {
    await h.close();
    await mock.close();
  });

  const aiTagsOf = async (fileId: string) => {
    const files = (await h.ok('files:list', { limit: 100, offset: 0, scope: { kind: 'all' } })).items;
    return files.find((f) => f.id === fileId)!.tags.filter((t) => t.origin === 'ai');
  };
  const analysisOf = (fileId: string) => h.manager.read((s) => s.database.analyses.get(fileId));
  const filesRequest = (fileId: string, mode: 'apply' | 'propose' = 'apply') => ({
    target: { kind: 'files' as const, fileIds: [fileId] },
    model: MOCK_MODEL,
    mode,
    force: false,
  });

  it('analyses with a chosen prompt, records its name and redoes the file with another prompt only on force', async () => {
    const narrow = await h.ok('analysisPrompts:save', { purpose: 'tagging', name: 'Two tags', text: 'Only the main subject.', maxTags: 2 });
    const defaultPrompt = (await h.ok('analysisPrompts:list', {})).prompts.find((p) => p.purpose === 'tagging' && p.name === 'Default')!;
    const [fileId] = await h.importImages(1);
    const request = filesRequest(fileId!);

    expect(await h.ok('analysis:enqueue', { ...request, promptId: narrow.id })).toEqual({ enqueued: 1, skipped: NONE_SKIPPED });
    await h.until((s) => s.succeeded === 1);
    const tags = await aiTagsOf(fileId!);
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.length).toBeLessThanOrEqual(2);
    expect(await analysisOf(fileId!)).toMatchObject({ model: MOCK_MODEL, promptName: 'Two tags' });
    const [chat] = mock.requests.filter((r) => r.path === '/api/chat');
    expect(JSON.stringify(chat!.body)).toContain('Give at most 2 tags.');
    expect((await h.ok('analysisPrompts:list', {})).lastUsed.tagging).toBe(narrow.id);

    // The fingerprint does not depend on the prompt: another prompt finds the file already analysed.
    expect(await h.ok('analysis:enqueue', { ...request, promptId: defaultPrompt.id })).toEqual({
      enqueued: 0,
      skipped: { ...NONE_SKIPPED, alreadyAnalysed: 1 },
    });
    expect(await h.ok('analysis:enqueue', { ...request, promptId: defaultPrompt.id, force: true })).toEqual({
      enqueued: 1,
      skipped: NONE_SKIPPED,
    });
    await h.until((s) => s.succeeded === 2);
    expect(await analysisOf(fileId!)).toMatchObject({ model: MOCK_MODEL, promptName: 'Default' });
    expect((await aiTagsOf(fileId!)).length).toBeGreaterThan(2);
    expect((await h.ok('analysisPrompts:list', {})).lastUsed.tagging).toBe(defaultPrompt.id);
  });

  it('shows the prompt name in a proposal', async () => {
    const detailed = await h.ok('analysisPrompts:save', { purpose: 'tagging', name: 'Detailed', text: 'Every detail.', maxTags: 3 });
    const [fileId] = await h.importImages(1);
    expect(await h.ok('analysis:enqueue', { ...filesRequest(fileId!, 'propose'), promptId: detailed.id })).toEqual({
      enqueued: 1,
      skipped: NONE_SKIPPED,
    });
    await h.until((s) => s.succeeded === 1);
    const { proposal } = await h.ok('analysis:getProposal', { fileId: fileId! });
    expect(proposal).toMatchObject({ model: MOCK_MODEL, promptName: 'Detailed', stale: false });
    expect(proposal!.tags.length).toBeGreaterThan(0);
    expect(proposal!.tags.length).toBeLessThanOrEqual(3);
    expect(await aiTagsOf(fileId!)).toEqual([]);
  });

  it('rejects an unknown or wrong-purpose prompt id and queues nothing', async () => {
    const [fileId] = await h.importImages(1);
    const imagePrompt = (await h.ok('analysisPrompts:list', {})).prompts.find((p) => p.purpose === 'image_prompt')!;
    for (const promptId of [randomUUID(), imagePrompt.id]) {
      expect(await h.call('analysis:enqueue', { ...filesRequest(fileId!), promptId })).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
    }
    expect(await h.ok('jobs:summary', {})).toMatchObject({ queued: 0, running: 0, succeeded: 0 });
    expect((await h.ok('analysisPrompts:list', {})).lastUsed.tagging).toBeNull();
  });
});
