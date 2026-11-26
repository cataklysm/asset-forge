import { mkdirSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IpcChannel, IpcRequest, IpcResponse, IpcResult, JobSummary } from '@assetforge/contracts';
import { composeTaggingRequest, type WorkspaceManager } from '@assetforge/core';
import { createPauseGate, DEFAULT_LIMITS } from '@assetforge/jobs';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import { createOllamaVision, OLLAMA_PROVIDER } from '@assetforge/providers';
import { MOCK_MODEL, startMockProvider, type MockFailure, type MockProvider } from '../../../docker/mock-provider/server.mjs';
import { ANALYSIS_PROMPTS_FILE, LAST_USED_WRITE_FAILED } from '../src/main/analysis-prompts.js';
import { createWorkspaceManager } from '../src/main/composition.js';
import { createWorkspaceHandlers, dispatch, type IpcHandlers } from '../src/main/ipc.js';
import { createJobHost, type JobHost } from '../src/main/job-host.js';
import { servicesWithPrompts } from './idle-job-host.js';

let base: string;
let sources: string;
let manager: WorkspaceManager;
let mock: MockProvider | undefined;
let jobHost: JobHost;
let handlers: IpcHandlers;
let logs: string[];

const uuid = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';
/** The phase 4a request shape in the phase 4b contract: an explicit file list, applied. */
const filesRequest = (fileIds: string[]) => ({ target: { kind: 'files' as const, fileIds }, model: MOCK_MODEL, mode: 'apply' as const, force: true });
const NONE_SKIPPED = { notFound: 0, notAnalysable: 0, alreadyQueued: 0, alreadyAnalysed: 0 };

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'af-jobs-ipc-'));
  sources = join(base, 'sources');
  await mkdir(sources, { recursive: true });
  manager = createWorkspaceManager({ userDataPath: join(base, 'userData'), migrationsFolder: MIGRATIONS_FOLDER });
  logs = [];
});
afterEach(async () => {
  await jobHost?.workspaceClosing();
  await manager.close();
  await mock?.close();
  mock = undefined;
  await rm(base, { recursive: true, force: true });
});

/** Starts the mock and wires the handlers to a job host that talks to it. */
async function setup(failures: MockFailure[] = []): Promise<void> {
  mock = await startMockProvider({ port: 0, failures });
  const adapter = createOllamaVision({ baseUrl: mock.url });
  jobHost = createJobHost({
    manager,
    gateway: { current: () => adapter },
    images: { jpeg: (path) => readFile(path) },
    provider: OLLAMA_PROVIDER,
    defaultModel: () => MOCK_MODEL,
    pause: createPauseGate({}),
    limits: { ...DEFAULT_LIMITS, local_gpu: 1 },
  });
  handlers = createWorkspaceHandlers(
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
      openExternal: async () => {},
      workspaceOpened: () => jobHost.workspaceOpened(),
      workspaceClosing: () => jobHost.workspaceClosing(),
    },
    jobHost,
    servicesWithPrompts(join(base, 'userData'), (line) => logs.push(line)),
  );
}

function call(channel: IpcChannel, request: unknown): Promise<IpcResult<unknown>> {
  return dispatch(handlers, channel, request);
}

async function ok<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> {
  const result = await call(channel, request);
  if (!result.ok) throw new Error(`${channel} failed: ${result.error.code}`);
  return result.value as IpcResponse<C>;
}

async function importImages(count: number): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const path = join(sources, `image-${i}.png`);
    await writeFile(path, `image content ${i}`);
    paths.push(path);
  }
  const results = await ok('files:import', { sourcePaths: paths });
  return results.map((r) => r.file!.id);
}

async function until(check: (summary: JobSummary) => boolean): Promise<JobSummary> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const summary = await ok('jobs:summary', {});
    if (check(summary)) return summary;
    if (Date.now() > deadline) throw new Error(`Timed out; last summary ${JSON.stringify(summary)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const page = { limit: 50, offset: 0 };

describe('job IPC', () => {
  it('answers no_workspace_open on every job channel without a workspace', async () => {
    await setup();
    const requests: [IpcChannel, unknown][] = [
      ['analysis:enqueue', filesRequest([uuid])],
      ['jobs:list', page],
      ['jobs:summary', {}],
      ['jobs:cancel', { jobId: uuid }],
      ['jobs:cancelAll', {}],
      ['jobs:retry', { jobId: uuid }],
      ['jobs:retryFailed', {}],
      ['jobs:clearFinished', {}],
    ];
    for (const [channel, request] of requests) {
      expect(await call(channel, request), channel).toMatchObject({ ok: false, error: { code: 'no_workspace_open' } });
    }
  });

  it('answers no_workspace_open on every analysis channel without a workspace', async () => {
    await setup();
    const requests: [IpcChannel, unknown][] = [
      ['analysis:preview', { target: { kind: 'files', fileIds: [uuid] }, model: MOCK_MODEL }],
      ['analysis:getProposal', { fileId: uuid }],
      ['analysis:acceptProposal', { fileId: uuid, names: ['red car'] }],
      ['analysis:discardProposal', { fileId: uuid }],
      ['analysis:describe', { requestId: uuid, fileId: uuid, model: MOCK_MODEL }],
      ['analysis:cancelDescribe', { requestId: uuid }],
    ];
    for (const [channel, request] of requests) {
      expect(await call(channel, request), channel).toMatchObject({ ok: false, error: { code: 'no_workspace_open' } });
    }
  });

  it('resumes without a workspace, since the pause belongs to the app session', async () => {
    await setup();
    expect(await ok('jobs:resume', {})).toEqual({});
  });

  it('refuses an accept with an empty tag name', async () => {
    await setup();
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    expect(await call('analysis:acceptProposal', { fileId: uuid, names: [''] })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(await call('analysis:acceptProposal', { fileId: uuid, names: ['red car'] })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('refuses a proposal for more than one file', async () => {
    await setup();
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    const request = { ...filesRequest([uuid, '4f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f']), mode: 'propose' };
    expect(await call('analysis:enqueue', request)).toMatchObject({ ok: false, error: { code: 'invalid_operation' } });
  });

  it('reports no pause in the summary', async () => {
    await setup();
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    expect(await ok('jobs:summary', {})).toMatchObject({ queued: 0, paused: null });
  });

  it('counts the skipped files of an enqueue per reason', async () => {
    await setup(['hang']);
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    const [fileId] = await importImages(1);
    await ok('analysis:enqueue', filesRequest([fileId!]));
    expect(await ok('analysis:enqueue', filesRequest([fileId!, uuid]))).toEqual({
      enqueued: 0,
      skipped: { ...NONE_SKIPPED, notFound: 1, alreadyQueued: 1 },
    });
  });

  it('refuses an enqueue with a duplicate id', async () => {
    await setup();
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    expect(await call('analysis:enqueue', filesRequest([uuid, uuid]))).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('lists an enqueued job with its file name and counts changes until it finished', async () => {
    await setup();
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    const [fileId] = await importImages(1);
    const before = (await ok('jobs:summary', {})).changes;

    expect(await ok('analysis:enqueue', filesRequest([fileId!]))).toEqual({ enqueued: 1, skipped: NONE_SKIPPED });
    const afterEnqueue = (await ok('jobs:summary', {})).changes;
    expect(afterEnqueue).toBeGreaterThan(before);
    const list = await ok('jobs:list', page);
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ type: 'vision.analyze_file', fileId, fileName: 'image-0.png' });

    const done = await until((s) => s.succeeded === 1);
    expect(done.changes).toBeGreaterThan(afterEnqueue);
  });

  it('refuses to retry a queued job and to cancel an unknown one', async () => {
    await setup(['hang']);
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    await ok('analysis:enqueue', filesRequest(await importImages(2)));
    await until((s) => s.running === 1 && s.queued === 1);
    const [queued] = (await ok('jobs:list', { ...page, status: 'queued' })).items;

    expect(await call('jobs:retry', { jobId: queued!.id })).toMatchObject({
      ok: false,
      error: { code: 'invalid_operation' },
    });
    expect(await call('jobs:cancel', { jobId: uuid })).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('clears finished jobs and returns how many it removed', async () => {
    await setup();
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    await ok('analysis:enqueue', filesRequest(await importImages(2)));
    await until((s) => s.succeeded === 2);

    expect(await ok('jobs:clearFinished', {})).toEqual({ removed: 2 });
    expect((await ok('jobs:list', page)).total).toBe(0);
  });

  it('files:trashMany raises the job change counter', async () => {
    await setup();
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    const [fileId] = await importImages(1);
    const before = (await ok('jobs:summary', {})).changes;
    await ok('files:trashMany', { fileIds: [fileId!] });
    expect((await ok('jobs:summary', {})).changes).toBeGreaterThan(before);
  });

  it('files:trashMany cancels the running job of the file through the scheduler', async () => {
    await setup(['hang']);
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    const [fileId] = await importImages(1);
    await ok('analysis:enqueue', filesRequest([fileId!]));
    await until((s) => s.running === 1);
    const result = await ok('files:trashMany', { fileIds: [fileId!] });
    expect(result.items[0]).toMatchObject({ fileId, error: null });
    await until((s) => s.running === 0 && s.cancelled === 1);
  });

  it('jobs:retry answers invalid_operation for a job of a trashed file', async () => {
    await setup(['hang']);
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    const [fileId] = await importImages(1);
    await ok('analysis:enqueue', filesRequest([fileId!]));
    await until((s) => s.running === 1);
    await ok('files:trashMany', { fileIds: [fileId!] });
    await until((s) => s.running === 0 && s.cancelled === 1);
    const [job] = (await ok('jobs:list', page)).items;

    expect(await call('jobs:retry', { jobId: job!.id })).toEqual({
      ok: false,
      error: { code: 'invalid_operation', message: 'The file of this job is in the trash' },
    });
    expect(await ok('jobs:retryFailed', {})).toEqual({ retried: 0 });
  });

  it('puts a running job back to queued when another workspace opens', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      await setup(['hang']);
      const first = join(base, 'first');
      await ok('workspace:create', { name: 'First', rootPath: first });
      await ok('analysis:enqueue', filesRequest(await importImages(1)));
      await until((s) => s.running === 1);

      await ok('workspace:create', { name: 'Second', rootPath: join(base, 'second') });
      expect(await ok('jobs:summary', {})).toMatchObject({ queued: 0, running: 0 });
      await ok('workspace:close', {});

      // Opened without the handlers, so no scheduler claims the job before it is checked.
      await manager.open({ rootPath: first });
      const jobs = await manager.read((s) => s.database.jobs.list(page));
      expect(jobs.items).toMatchObject([{ status: 'queued', attempt: 0, errorCode: null }]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('analysis:enqueue with an analysis prompt', () => {
  const armour = { purpose: 'tagging' as const, name: 'Armour', text: 'Only armour.', maxTags: 3 };

  async function payloads(): Promise<unknown[]> {
    return manager.read(async (s) => {
      const { items } = await s.database.jobs.list({ limit: 100, offset: 0 });
      return Promise.all(items.map(async (j) => (await s.database.jobs.get(j.id))!.payload));
    });
  }

  function chatContents(): string[] {
    return mock!.requests
      .filter((r) => r.path === '/api/chat')
      .map((r) => (r.body as { messages: { content: string }[] }).messages[0]!.content);
  }

  it('copies the chosen prompt into the payload and remembers it as used last', async () => {
    await setup(['hang']);
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    const [first, second] = await importImages(2);
    const prompt = await ok('analysisPrompts:save', armour);

    expect(await ok('analysis:enqueue', { ...filesRequest([first!]), promptId: prompt.id })).toEqual({
      enqueued: 1,
      skipped: NONE_SKIPPED,
    });
    expect((await ok('analysisPrompts:list', {})).lastUsed.tagging).toBe(prompt.id);

    // Without an id the prompt used last runs.
    await ok('analysis:enqueue', filesRequest([second!]));
    const expected = { version: 3, model: MOCK_MODEL, mode: 'apply', prompt: { name: 'Armour', text: 'Only armour.', maxTags: 3 } };
    expect(await payloads()).toEqual([expected, expected]);
  });

  it('answers not_found for an unknown id and an image prompt id and queues nothing', async () => {
    await setup();
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    const [fileId] = await importImages(1);
    const image = (await ok('analysisPrompts:list', {})).prompts.find((p) => p.purpose === 'image_prompt')!;

    for (const promptId of [uuid, image.id]) {
      expect(await call('analysis:enqueue', { ...filesRequest([fileId!]), promptId })).toEqual({
        ok: false,
        error: { code: 'not_found', message: 'The analysis prompt does not exist' },
      });
    }
    expect(await payloads()).toEqual([]);
    expect((await ok('analysisPrompts:list', {})).lastUsed).toEqual({ tagging: null, imagePrompt: null });
  });

  it('remembers the prompt when nothing was queued', async () => {
    await setup();
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    const [fileId] = await importImages(1);
    await ok('analysis:enqueue', filesRequest([fileId!]));
    await until((s) => s.succeeded === 1);
    const prompt = await ok('analysisPrompts:save', armour);

    expect(await ok('analysis:enqueue', { ...filesRequest([fileId!]), force: false, promptId: prompt.id })).toEqual({
      enqueued: 0,
      skipped: { ...NONE_SKIPPED, alreadyAnalysed: 1 },
    });
    expect((await ok('analysisPrompts:list', {})).lastUsed.tagging).toBe(prompt.id);
  });

  it('still returns its counts when the prompt used last cannot be stored', async () => {
    await setup(['hang']);
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    const [fileId] = await importImages(1);
    await ok('analysisPrompts:list', {});
    // The file path becomes a directory: the rename onto it fails.
    const path = join(base, 'userData', ANALYSIS_PROMPTS_FILE);
    rmSync(path);
    mkdirSync(join(path, 'blocker'), { recursive: true });

    expect(await ok('analysis:enqueue', filesRequest([fileId!]))).toEqual({ enqueued: 1, skipped: NONE_SKIPPED });
    expect(logs).toEqual([LAST_USED_WRITE_FAILED]);
  });

  for (const change of ['edited', 'deleted'] as const) {
    it(`runs a waiting job with the text it was queued with after its prompt was ${change}`, async () => {
      await setup(['hang']);
      await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
      const [blocker, fileId] = await importImages(2);
      await ok('analysis:enqueue', filesRequest([blocker!]));
      // The blocker hangs at the provider, so the second job waits in the queue.
      await until((s) => s.running === 1 && chatContents().length === 1);
      const prompt = await ok('analysisPrompts:save', armour);
      await ok('analysis:enqueue', { ...filesRequest([fileId!]), promptId: prompt.id });

      if (change === 'edited') await ok('analysisPrompts:save', { ...armour, id: prompt.id, text: 'Only helmets.', maxTags: 7 });
      else await ok('analysisPrompts:delete', { id: prompt.id });
      const [running] = (await ok('jobs:list', { ...page, status: 'running' })).items;
      await ok('jobs:cancel', { jobId: running!.id });
      await until((s) => s.succeeded === 1);

      expect(chatContents()).toHaveLength(2);
      expect(chatContents()[1]).toBe(composeTaggingRequest({ text: 'Only armour.', maxTags: 3 }));
    });
  }
});
