import { mkdirSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ipcContract,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
  type JobSummary,
} from '@assetforge/contracts';
import { composeTaggingRequest, type WorkspaceManager } from '@assetforge/core';
import { createPauseGate, DEFAULT_LIMITS, type PauseGate } from '@assetforge/jobs';
import { MIGRATIONS_FOLDER } from '@assetforge/persistence';
import {
  MOCK_MODEL,
  startMockProvider,
  type MockFailure,
  type MockProvider,
} from '../../../docker/mock-provider/server.mjs';
import { ANALYSIS_PROMPTS_FILE, LAST_USED_WRITE_FAILED } from '../src/main/analysis-prompts.js';
import { createWorkspaceManager } from '../src/main/composition.js';
import { dispatch, type IpcHandlers } from '../src/main/ipc.js';
import { createWorkspaceHandlers } from '../src/main/workspace-handlers.js';
import { createChangeFeed } from '../src/main/change-feed.js';
import { createJobHost, type JobHost } from '../src/main/job-host.js';
import type { ProviderStore } from '../src/main/provider-store.js';
import { chatContents } from './analysis-harness.js';
import { hangingRemote, mockProviderEntry, noGenerations, servicesWithPrompts } from './idle-job-host.js';

let base: string;
let sources: string;
let manager: WorkspaceManager;
let mock: MockProvider | undefined;
let jobHost: JobHost;
let pause: PauseGate;
let handlers: IpcHandlers;
let logs: string[];
/** The id of the mock's provider entry. */
let entryId: string;
/** The provider store the handlers and the job host read. */
let store: ProviderStore;

const uuid = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';
/** The creation time of a proposal named in an accept. */
const STAMP = '2026-11-28T10:00:00.000Z';
/** The phase 4a request shape in the phase 4b contract: an explicit file list, applied. */
const filesRequest = (fileIds: string[]) => ({
  target: { kind: 'files' as const, fileIds },
  model: MOCK_MODEL,
  mode: 'apply' as const,
  force: true,
});
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
async function setup(failures: MockFailure[] = [], firstEntry?: () => never): Promise<void> {
  mock = await startMockProvider({ port: 0, failures });
  const provider = mockProviderEntry(join(base, 'userData'), mock.url);
  entryId = provider.entry.id;
  store = provider.store;
  pause = createPauseGate({});
  jobHost = createJobHost({
    feed: createChangeFeed(),
    manager,
    vision: provider.vision,
    images: { jpeg: (path) => readFile(path) },
    provider: (lane) => {
      const entry = lane === null ? null : provider.store.get(lane);
      return entry === null || entry.kind === 'venice' ? null : entry.kind;
    },
    pause,
    firstEntry: firstEntry ?? (() => provider.store.first()),
    ...noGenerations,
    remote: hangingRemote,
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
    servicesWithPrompts(join(base, 'userData'), (line) => logs.push(line), provider.store),
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
      ['jobs:waitingByProvider', {}],
      ['jobs:reroute', { fromProviderId: null, toProviderId: uuid, model: MOCK_MODEL }],
      // An unknown provider id does not win over the missing workspace.
      ['analysis:enqueue', { ...filesRequest([uuid]), providerId: uuid }],
    ];
    for (const [channel, request] of requests) {
      expect(await call(channel, request), channel).toMatchObject({ ok: false, error: { code: 'no_workspace_open' } });
    }
  });

  it('answers no_workspace_open on every analysis channel without a workspace', async () => {
    await setup();
    const requests: [IpcChannel, unknown][] = [
      ['analysis:preview', { target: { kind: 'files', fileIds: [uuid] }, model: MOCK_MODEL }],
      ['analysis:preview', { target: { kind: 'files', fileIds: [uuid] }, model: MOCK_MODEL, providerId: uuid }],
      ['analysis:describe', { requestId: uuid, fileId: uuid, model: MOCK_MODEL, providerId: uuid }],
      ['analysis:getProposal', { fileId: uuid }],
      ['analysis:acceptProposal', { fileId: uuid, createdAt: STAMP, names: ['red car'] }],
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
    expect(await ok('jobs:resume', { providerId: null })).toEqual({});
    expect(await ok('jobs:resume', { providerId: uuid })).toEqual({});
    expect(await ok('jobs:resumeHost', { host: 'example.org' })).toEqual({});
  });

  it('refuses an accept with an empty tag name', async () => {
    await setup();
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    expect(await call('analysis:acceptProposal', { fileId: uuid, createdAt: STAMP, names: [''] })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(await call('analysis:acceptProposal', { fileId: uuid, createdAt: STAMP, names: ['red car'] })).toMatchObject(
      {
        ok: false,
        error: { code: 'not_found' },
      },
    );
  });

  it('refuses a proposal for more than one file', async () => {
    await setup();
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    const request = { ...filesRequest([uuid, '4f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f']), mode: 'propose' };
    expect(await call('analysis:enqueue', request)).toMatchObject({ ok: false, error: { code: 'invalid_operation' } });
  });

  it('starts the scheduler when the provider store cannot be read on open, and runs a job that has a lane', async () => {
    await setup([], () => {
      throw new Error('store unreadable');
    });
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    const [fileId] = await importImages(1);
    await ok('analysis:enqueue', { ...filesRequest([fileId!]), providerId: entryId });
    await until((s) => s.succeeded === 1);
  });

  it('reports no pause in the summary', async () => {
    await setup();
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    expect(await ok('jobs:summary', {})).toMatchObject({ queued: 0, paused: [] });
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

  it('answers changes:since with a reset without a workspace, and the changes after a cursor with one', async () => {
    await setup();
    expect(await ok('changes:since', { cursor: null })).toMatchObject({
      reset: true,
      jobIds: [],
      fileIds: [],
      added: [],
    });
    expect(await ok('changes:since', { cursor: 'unknown:3' })).toMatchObject({ reset: true });

    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    const [fileId] = await importImages(1);
    const first = await ok('changes:since', { cursor: null });
    expect(first.reset).toBe(true);
    const before = (await ok('jobs:summary', {})).changes;

    await ok('analysis:enqueue', filesRequest([fileId!]));
    expect(await ok('changes:since', { cursor: first.cursor })).toMatchObject({ reset: false, jobs: true });
    await until((s) => s.succeeded === 1);
    expect((await ok('jobs:summary', {})).changes).toBeGreaterThan(before);

    const [job] = (await ok('jobs:list', page)).items;
    const after = await ok('changes:since', { cursor: first.cursor });
    expect(after).toMatchObject({ reset: false, jobs: true, fileIds: [fileId] });
    expect(after.jobIds).toContain(job!.id);
    expect(await ok('changes:since', { cursor: after.cursor })).toMatchObject({
      reset: false,
      jobs: false,
      jobIds: [],
      fileIds: [],
    });
  });

  it('lists only the chosen job ids that match the status', async () => {
    await setup(['hang']);
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    await ok('analysis:enqueue', filesRequest(await importImages(3)));
    await until((s) => s.running === 1 && s.queued === 2);
    const all = (await ok('jobs:list', page)).items;
    const running = all.find((j) => j.status === 'running')!;
    const queued = all.filter((j) => j.status === 'queued');

    const chosen = await ok('jobs:list', { ...page, ids: [running.id, queued[0]!.id] });
    expect(chosen.total).toBe(2);
    expect(chosen.items.map((j) => j.id).sort()).toEqual([running.id, queued[0]!.id].sort());
    expect(await ok('jobs:list', { ...page, ids: [running.id, queued[0]!.id], status: 'queued' })).toMatchObject({
      total: 1,
      items: [{ id: queued[0]!.id }],
    });
    expect(await ok('jobs:list', { ...page, ids: [uuid] })).toEqual({ items: [], total: 0 });
    const tooMany = Array.from({ length: 101 }, () => uuid);
    expect(await call('jobs:list', { ...page, ids: tooMany })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
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
    const expected = {
      version: 4,
      model: MOCK_MODEL,
      mode: 'apply',
      prompt: { name: 'Armour', text: 'Only armour.', maxTags: 3 },
      providerName: 'Mock',
    };
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
      await until((s) => s.running === 1 && chatContents(mock!).length === 1);
      const prompt = await ok('analysisPrompts:save', armour);
      await ok('analysis:enqueue', { ...filesRequest([fileId!]), promptId: prompt.id });

      if (change === 'edited')
        await ok('analysisPrompts:save', { ...armour, id: prompt.id, text: 'Only helmets.', maxTags: 7 });
      else await ok('analysisPrompts:delete', { id: prompt.id });
      const [running] = (await ok('jobs:list', { ...page, status: 'running' })).items;
      await ok('jobs:cancel', { jobId: running!.id });
      await until((s) => s.succeeded === 1);

      expect(chatContents(mock!)).toHaveLength(2);
      expect(chatContents(mock!)[1]).toBe(composeTaggingRequest({ text: 'Only armour.', maxTags: 3 }));
    });
  }

  it('lists a paused download host apart from the providers and resumes it through jobs:resumeHost', async () => {
    await setup();
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    for (let i = 0; i < 3; i++) pause.record('io', 'example.org', 'download_blocked');
    pause.record('local_gpu', entryId, 'provider_unauthorized');

    const summary = await ok('jobs:summary', {});
    expect(summary.pausedHosts).toEqual([{ host: 'example.org', reason: 'download_blocked' }]);
    expect(summary.paused).toMatchObject([{ providerId: entryId, reason: 'provider_unauthorized' }]);

    const before = jobHost.changes();
    expect(await ok('jobs:resumeHost', { host: 'example.org' })).toEqual({});
    expect(jobHost.changes()).toBeGreaterThan(before);
    const after = await ok('jobs:summary', {});
    expect(after.pausedHosts).toEqual([]);
    expect(after.paused).toHaveLength(1);
    expect(await call('jobs:resumeHost', { host: '' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('raises the change counter on a resume only when the lane was paused', async () => {
    await setup();
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });

    const idle = jobHost.changes();
    expect(await ok('jobs:resume', { providerId: entryId })).toEqual({});
    expect(await ok('jobs:resumeHost', { host: 'example.org' })).toEqual({});
    expect(jobHost.changes()).toBe(idle);

    pause.record('local_gpu', entryId, 'provider_unauthorized');
    const paused = jobHost.changes();
    expect(await ok('jobs:resume', { providerId: entryId })).toEqual({});
    expect(jobHost.changes()).toBeGreaterThan(paused);
  });

  /** An `openai` entry on the mock's OpenAI-compatible API, without a key. */
  const openAiEntry = () =>
    store.save({
      kind: 'openai',
      name: 'vLLM',
      baseUrl: `${mock!.url}/v1`,
      timeoutSeconds: 30,
      taggingModel: null,
      promptModel: null,
    });

  it('reports the real kind of a paused lane, and for a lane whose entry is gone what its resource class implies', async () => {
    await setup();
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    const openai = openAiEntry();
    pause.record('local_gpu', openai.id, 'provider_unauthorized');
    pause.record('local_gpu', uuid, 'provider_unauthorized');
    pause.record('remote_api', entryId, 'provider_unauthorized');

    const { paused } = await ok('jobs:summary', {});
    expect(paused).toEqual([
      { providerId: openai.id, providerName: 'vLLM', kind: 'openai', reason: 'provider_unauthorized' },
      { providerId: uuid, providerName: null, kind: 'ollama', reason: 'provider_unauthorized' },
      { providerId: entryId, providerName: 'Mock', kind: 'ollama', reason: 'provider_unauthorized' },
    ]);
  });

  it('moves the waiting jobs of an ollama entry onto an openai entry, which then runs them', async () => {
    await setup();
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    pause.record('local_gpu', entryId, 'provider_unauthorized');
    const fileIds = await importImages(2);
    await ok('analysis:enqueue', { ...filesRequest(fileIds), providerId: entryId });
    expect(await ok('jobs:waitingByProvider', {})).toEqual([{ providerId: entryId, providerName: 'Mock', waiting: 2 }]);
    const openai = openAiEntry();

    expect(await ok('jobs:reroute', { fromProviderId: entryId, toProviderId: openai.id, model: MOCK_MODEL })).toEqual({
      moved: 2,
    });
    await until((s) => s.succeeded === 2);

    const { items } = await ok('jobs:list', page);
    for (const job of items) expect(job).toMatchObject({ providerId: openai.id, providerName: 'vLLM' });
    expect(mock!.requests.map((r) => r.path).filter((p) => p.endsWith('/chat/completions'))).toEqual([
      '/v1/chat/completions',
      '/v1/chat/completions',
    ]);
  });

  it('resumes only the queues of the request when a host and a provider lane share a name', async () => {
    await setup();
    const lane = 'environment';
    const pausedClasses = () =>
      jobHost
        .paused()
        .filter((p) => p.lane === lane)
        .map((p) => p.resourceClass);
    const pauseAll = () => {
      for (let i = 0; i < 3; i++) pause.record('io', lane, 'download_blocked');
      pause.record('local_gpu', lane, 'provider_unauthorized');
      pause.record('remote_api', lane, 'provider_unauthorized');
    };
    pauseAll();
    expect(pausedClasses()).toEqual(['local_gpu', 'remote_api', 'io']);

    expect(await ok('jobs:resumeHost', { host: lane })).toEqual({});
    expect(pausedClasses()).toEqual(['local_gpu', 'remote_api']);

    pauseAll();
    expect(await ok('jobs:resume', { providerId: lane })).toEqual({});
    expect(pausedClasses()).toEqual(['io']);
  });

  it('never offers or moves download jobs through jobs:waitingByProvider and jobs:reroute', async () => {
    await setup();
    await ok('workspace:create', { name: 'Test', rootPath: join(base, 'workspace') });
    const urls = ['a', 'b', 'c'].map((n) => `https://example.org/${n}.png`);
    expect(await ok('files:importUrls', { urls })).toMatchObject({ queued: 3 });
    // Two run per host and hang until aborted; the third waits.
    await until((s) => s.running === 2 && s.queued === 1);

    expect(await ok('jobs:waitingByProvider', {})).toEqual([]);
    // A host is no provider id, so the contract alone keeps a host lane out; the lane without a provider holds none either.
    expect(
      ipcContract['jobs:reroute'].request.safeParse({
        fromProviderId: 'example.org',
        toProviderId: entryId,
        model: MOCK_MODEL,
      }).success,
    ).toBe(false);
    expect(await ok('jobs:reroute', { fromProviderId: null, toProviderId: entryId, model: MOCK_MODEL })).toEqual({
      moved: 0,
    });
    const { items } = await ok('jobs:list', page);
    expect(items).toHaveLength(3);
    for (const job of items)
      expect(job).toMatchObject({ type: 'file.download', host: 'example.org', providerId: null });
  });
});
