import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANALYZE_FILE_JOB, IMAGE_GENERATE_JOB, IMAGE_INPUT_MAX_BYTES, type Generation, type IpcChannel, purposeOf, type ProviderView } from '@assetforge/contracts';
import { NotFoundError, type ImageProvider, type ImageProviderDirectory, type WorkspaceManager } from '@assetforge/core';
import {
  MOCK_EDIT_MODEL,
  MOCK_MODEL,
  MOCK_PROMPT_FAIL,
  MOCK_PROMPT_NO_BALANCE,
  MOCK_PROMPT_SLOW,
  startMockProvider,
  type MockProvider,
} from '../../../docker/mock-provider/server.mjs';
import { createGenerationImageSource } from '../src/main/generation-image-source.js';
import { createGenerationHandlers, createImageProviderDirectory } from '../src/main/generation-handlers.js';
import type { JobHost } from '../src/main/job-host.js';
import type { ProviderGateway } from '../src/main/provider-gateway.js';
import type { ProviderEntry, ProviderStore } from '../src/main/provider-store.js';
import { createHarness, TEST_KEY, TEST_KEY_2, type Harness } from './analysis-harness.js';
import { pngOf } from './png-fixture.js';

// Passes through; only lets a test see which files were read whole.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const UNKNOWN = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';
const page = { limit: 100, offset: 0 };

describe('generation IPC', () => {
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

  const createWorkspace = () => h.ok('workspace:create', { name: 'Studio', rootPath: join(h.base, 'workspace') });
  const edit = (fileId: string, prompt: string, providerId?: string) => ({
    kind: 'edit' as const,
    fileId,
    model: MOCK_EDIT_MODEL,
    prompt,
    safeMode: true,
    ...(providerId === undefined ? {} : { providerId }),
  });
  /** The mock with `TEST_KEY`, a `venice` entry for it, a workspace and one 256 px PNG in the inbox. */
  async function ready(): Promise<{ entry: ProviderView; fileId: string }> {
    mock = await startMockProvider({ port: 0, apiKey: TEST_KEY });
    const entry = await h.venice({ url: mock.url, apiKey: TEST_KEY });
    await createWorkspace();
    const fileId = await h.importPng({ name: 'oak.png', width: 256, height: 256 });
    return { entry, fileId };
  }
  async function start(request: ReturnType<typeof edit>): Promise<Generation> {
    const result = await h.ok('generations:start', request);
    if (!result.ok) throw new Error(`generations:start answered ${result.code}`);
    return result.generation;
  }
  const noKeyInResponses = () => {
    for (const line of h.responses) {
      expect(line).not.toContain(TEST_KEY);
      expect(line).not.toContain(TEST_KEY_2);
    }
  };

  it('answers no_workspace_open on every generation channel without a workspace', async () => {
    const requests: [IpcChannel, unknown][] = [
      ['generations:start', edit(UNKNOWN, 'night')],
      ['generations:start', { kind: 'upscale', fileId: UNKNOWN, scale: 2 }],
      ['generations:forFile', { fileId: UNKNOWN }],
      ['generations:retry', { generationId: UNKNOWN }],
      ['generations:remove', { generationId: UNKNOWN }],
      ['generations:recentPrompts', {}],
    ];
    for (const [channel, request] of requests) {
      expect(await h.call(channel, request)).toMatchObject({ ok: false, error: { code: 'no_workspace_open' } });
    }
  });

  it('refuses requests that do not match the contract on every generation channel', async () => {
    await createWorkspace();
    const requests: [IpcChannel, unknown][] = [
      ['generations:start', { kind: 'edit', fileId: UNKNOWN, model: MOCK_EDIT_MODEL, prompt: 'night' }],
      ['generations:start', { kind: 'upscale', fileId: UNKNOWN, scale: 3 }],
      ['generations:start', { kind: 'variation', fileId: UNKNOWN }],
      ['generations:start', { ...edit('not-a-uuid', 'night') }],
      ['generations:start', { ...edit(UNKNOWN, 'x'.repeat(20_001)) }],
      ['generations:forFile', { fileId: 'nope' }],
      ['generations:retry', {}],
      ['generations:remove', { generationId: 42 }],
      ['generations:recentPrompts', null],
    ];
    for (const [channel, request] of requests) {
      expect(await h.call(channel, request)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    }
  });

  it('answers the domain refusals with their fixed messages', async () => {
    const { fileId } = await ready();
    expect(await h.call('generations:start', edit(UNKNOWN, 'night'))).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await h.call('generations:start', edit(fileId, '   '))).toEqual({
      ok: false,
      error: { code: 'validation_failed', message: 'The prompt must have 1 to 8000 characters' },
    });
    expect(await h.call('generations:start', { ...edit(fileId, 'night'), model: 'unknown-model' })).toEqual({
      ok: false,
      error: { code: 'validation_failed', message: 'This model is not offered by the provider' },
    });
    expect(await h.call('generations:retry', { generationId: UNKNOWN })).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'This generation does not exist' },
    });
    expect(await h.call('generations:remove', { generationId: UNKNOWN })).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'This generation does not exist' },
    });
    const ollama = await h.provider({ name: 'Ollama', url: mock!.url });
    expect(await h.call('generations:start', edit(fileId, 'night', ollama.id))).toEqual({
      ok: false,
      error: { code: 'invalid_operation', message: 'This provider cannot generate images' },
    });
    expect(await h.ok('jobs:list', page)).toMatchObject({ total: 0 });
    noKeyInResponses();
  });

  it('answers provider_unreachable for an entry that cannot be reached and queues nothing', async () => {
    const closed = await startMockProvider({ port: 0 });
    const url = closed.url;
    await closed.close();
    await h.venice({ url, apiKey: TEST_KEY });
    await createWorkspace();
    const fileId = await h.importPng({ name: 'oak.png', width: 256, height: 256 });

    expect(await h.ok('generations:start', edit(fileId, 'night'))).toEqual({ ok: false, code: 'provider_unreachable' });
    expect(await h.ok('jobs:list', page)).toMatchObject({ total: 0 });
    expect(await h.ok('generations:forFile', { fileId })).toEqual({ madeBy: null, results: [] });
    expect(await h.ok('generations:recentPrompts', {})).toEqual({ prompts: [] });
    noKeyInResponses();
  });

  it('answers provider_not_configured without a venice entry', async () => {
    await createWorkspace();
    const fileId = await h.importPng({ name: 'oak.png', width: 256, height: 256 });
    expect(await h.call('generations:start', edit(fileId, 'night'))).toMatchObject({
      ok: false,
      error: { code: 'provider_not_configured' },
    });
  });

  it('leaves a failed generation job to jobs:retryFailed and requeues the same generation on jobs:retry', async () => {
    const { entry, fileId } = await ready();
    const generation = await start(edit(fileId, MOCK_PROMPT_FAIL));
    await h.until((s) => s.failed === 1 && s.running === 0 && s.queued === 0);
    const [failed] = (await h.ok('jobs:list', page)).items;
    expect(failed).toMatchObject({ type: IMAGE_GENERATE_JOB, fileId, fileName: 'oak.png', providerId: entry.id, providerName: 'Venice', model: MOCK_EDIT_MODEL });

    expect(await h.ok('jobs:retryFailed', {})).toEqual({ retried: 0 });
    expect(await h.ok('jobs:summary', {})).toMatchObject({ failed: 1, queued: 0 });

    expect(await h.ok('jobs:retry', { jobId: failed!.id })).toEqual({});
    await h.until((s) => s.failed === 2 && s.running === 0 && s.queued === 0);
    expect(mock!.imageRequests).toHaveLength(2);
    const { results } = await h.ok('generations:forFile', { fileId });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: generation.id, status: 'failed', errorCode: 'provider_outcome_unknown' });
    expect(results[0]!.jobId).not.toBe(failed!.id);
    // Both runs name their provider and model.
    for (const job of (await h.ok('jobs:list', page)).items) {
      expect(job).toMatchObject({ providerName: 'Venice', model: MOCK_EDIT_MODEL });
    }

    expect(await h.ok('generations:retry', { generationId: generation.id })).toMatchObject({ id: generation.id, status: 'pending' });
    await h.until((s) => s.failed === 3 && s.running === 0 && s.queued === 0);
    expect(await h.ok('generations:remove', { generationId: generation.id })).toEqual({});
    expect(await h.ok('generations:forFile', { fileId })).toEqual({ madeBy: null, results: [] });
    expect(await h.ok('generations:recentPrompts', {})).toEqual({ prompts: [] });
    noKeyInResponses();
  });

  it('pauses the venice lane after one 402 with kind venice, and jobs:resume clears it', async () => {
    const { entry, fileId } = await ready();
    await start(edit(fileId, MOCK_PROMPT_NO_BALANCE));
    const summary = await h.until((s) => s.paused.length > 0);
    expect(summary.paused).toEqual([
      { providerId: entry.id, providerName: 'Venice', kind: 'venice', reason: 'provider_insufficient_balance' },
    ]);
    expect((await h.ok('jobs:list', page)).items[0]).toMatchObject({ status: 'failed', errorCode: 'provider_insufficient_balance' });
    expect(h.logs).toContain(`Image provider ${entry.id} failed: provider_insufficient_balance (HTTP 402)`);

    expect(await h.ok('jobs:resume', { providerId: entry.id })).toEqual({});
    expect((await h.ok('jobs:summary', {})).paused).toEqual([]);
    expect(await h.ok('generations:recentPrompts', {})).toEqual({ prompts: [MOCK_PROMPT_NO_BALANCE] });
    noKeyInResponses();
    for (const line of h.logs) expect(line).not.toContain(TEST_KEY);
  });

  it('names a paused venice lane whose entry was deleted after the provider stored with its generation', async () => {
    const { entry, fileId } = await ready();
    await start(edit(fileId, MOCK_PROMPT_NO_BALANCE));
    await h.until((s) => s.paused.length > 0);
    await start(edit(fileId, 'night'));
    // Without a workspace the entry can be deleted; its queued generation then fails as not configured.
    await h.ok('workspace:close', {});
    expect(await h.ok('providers:delete', { id: entry.id })).toEqual({});
    await h.ok('workspace:open', { rootPath: join(h.base, 'workspace') });
    const summary = await h.until((s) => s.paused.length > 0 && s.queued === 0 && s.running === 0);
    expect(summary.paused).toEqual([
      { providerId: entry.id, providerName: 'Venice', kind: 'venice', reason: 'provider_not_configured' },
    ]);
  });

  it('cancels a running generation through jobs:cancelAll and refuses to delete its entry while it runs', async () => {
    const { entry, fileId } = await ready();
    const generation = await start(edit(fileId, MOCK_PROMPT_SLOW));
    await h.until((s) => s.running === 1);
    expect(await h.call('providers:delete', { id: entry.id })).toEqual({
      ok: false,
      error: { code: 'invalid_operation', message: 'This provider still has active jobs; move or cancel them first' },
    });

    expect(await h.ok('jobs:cancelAll', {})).toEqual({ cancelled: 1 });
    await h.until((s) => s.cancelled === 1 && s.running === 0);
    expect((await h.ok('generations:forFile', { fileId })).results[0]).toMatchObject({ id: generation.id, status: 'cancelled' });
    expect(await h.ok('providers:delete', { id: entry.id })).toEqual({});
  });

  it('never moves generation jobs and refuses a venice entry as source or target of a move', async () => {
    const { entry: venice, fileId } = await ready();
    const ollama = await h.provider({ name: 'Ollama', url: mock!.url });
    // Pause the venice lane so the next generation stays queued.
    await start(edit(fileId, MOCK_PROMPT_NO_BALANCE));
    await h.until((s) => s.paused.length > 0);
    await start(edit(fileId, 'night'));
    // An analysis job that found its way into the venice lane is still not offered as a source.
    await h.manager.read((s) =>
      s.database.jobs.enqueue({
        jobs: [
          {
            id: randomUUID(),
            type: ANALYZE_FILE_JOB,
            resourceClass: 'local_gpu',
            fileId,
            lane: venice.id,
            payload: { version: 4, model: MOCK_MODEL, mode: 'apply', prompt: null, providerName: 'Venice' },
            dedupeKey: null,
          },
        ],
        now: new Date().toISOString(),
      }),
    );

    expect(await h.ok('jobs:waitingByProvider', {})).toEqual([]);
    expect(await h.call('jobs:reroute', { fromProviderId: ollama.id, toProviderId: venice.id, model: MOCK_MODEL })).toEqual({
      ok: false,
      error: { code: 'invalid_operation', message: 'This provider cannot analyse images' },
    });
    expect(await h.call('jobs:reroute', { fromProviderId: venice.id, toProviderId: ollama.id, model: MOCK_MODEL })).toEqual({
      ok: false,
      error: { code: 'invalid_operation', message: 'This provider cannot analyse images' },
    });
    const generationJobs = (await h.ok('jobs:list', { ...page, status: 'queued' })).items.filter((j) => j.type === IMAGE_GENERATE_JOB);
    expect(generationJobs).toHaveLength(1);
    expect(generationJobs[0]).toMatchObject({ providerId: venice.id });
  });

  it('ends a pending generation whose job was finished outside the scheduler when the workspace opens', async () => {
    const { fileId } = await ready();
    await start(edit(fileId, MOCK_PROMPT_NO_BALANCE));
    await h.until((s) => s.paused.length > 0);
    const queued = await start(edit(fileId, 'night'));
    // Without `settled`, as a crash between the two writes would leave it.
    await h.manager.read((s) => s.database.jobs.cancelPending({ id: queued.jobId!, now: new Date().toISOString() }));
    expect((await h.ok('generations:forFile', { fileId })).results[0]).toMatchObject({ id: queued.id, status: 'pending' });

    await h.ok('workspace:close', {});
    await h.ok('workspace:open', { rootPath: join(h.base, 'workspace') });
    expect((await h.ok('generations:forFile', { fileId })).results[0]).toMatchObject({ id: queued.id, status: 'cancelled' });
  });
});

describe('generation start in flight', () => {
  const FILE_A = randomUUID();
  const FILE_B = randomUUID();
  const BUSY = { code: 'invalid_operation', message: 'A generation for this file is already being started' };

  /** The start handler over a manager whose every read waits until the test settles it. */
  function handlers() {
    const pending: { resolve(value: unknown): void; reject(error: unknown): void }[] = [];
    const manager = {
      read: () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    } as unknown as WorkspaceManager;
    const jobs = { changed: vi.fn() } as unknown as JobHost;
    const start = createGenerationHandlers(manager, jobs, {} as ImageProviderDirectory)['generations:start'];
    return { start, pending };
  }
  const editOf = (fileId: string) => ({ kind: 'edit' as const, fileId, model: 'm', prompt: 'night', safeMode: true });
  const upscaleOf = (fileId: string) => ({ kind: 'upscale' as const, fileId, scale: 2 as const });
  const answer = { ok: false as const, code: 'provider_unreachable' as const };

  it('refuses a second start for the same file and kind while the first is in the call', async () => {
    const { start, pending } = handlers();
    const first = start(editOf(FILE_A));
    await expect(start(editOf(FILE_A))).rejects.toMatchObject(BUSY);
    expect(pending).toHaveLength(1);
    pending[0]!.resolve(answer);
    await expect(first).resolves.toEqual(answer);
  });

  it('lets a start for another file or another kind through', async () => {
    const { start, pending } = handlers();
    const calls = [start(editOf(FILE_A)), start(editOf(FILE_B)), start(upscaleOf(FILE_A))];
    expect(pending).toHaveLength(3);
    for (const p of pending) p.resolve(answer);
    expect(await Promise.all(calls)).toEqual([answer, answer, answer]);
  });

  it('lets the next start through once the first settled, also after a rejection', async () => {
    const { start, pending } = handlers();
    const first = start(upscaleOf(FILE_A));
    pending[0]!.resolve(answer);
    await first;
    const second = start(upscaleOf(FILE_A));
    expect(pending).toHaveLength(2);
    await expect(start(upscaleOf(FILE_A))).rejects.toMatchObject(BUSY);
    pending[1]!.reject(new NotFoundError('This file does not exist'));
    await expect(second).rejects.toBeInstanceOf(NotFoundError);
    const third = start(upscaleOf(FILE_A));
    expect(pending).toHaveLength(3);
    pending[2]!.resolve(answer);
    await expect(third).resolves.toEqual(answer);
  });
});

describe('image provider directory', () => {
  const venice: ProviderEntry = {
    id: randomUUID(),
    kind: 'venice',
    name: 'Venice',
    baseUrl: 'https://example.test/api/v1',
    timeoutSeconds: 30,
    taggingModel: null,
    promptModel: null,
    editModel: null,
    options: null,
  };
  const ollama: ProviderEntry = { ...venice, id: randomUUID(), kind: 'ollama', name: 'Ollama' };
  const entries = [venice, ollama];
  const store = {
    get: (id: string) => entries.find((e) => e.id === id) ?? null,
    resolve: vi.fn((id: string | undefined, purpose: string) => {
      if (id === undefined) return entries.find((e) => purposeOf(e.kind) === purpose) ?? null;
      const found = entries.find((e) => e.id === id) ?? null;
      if (found === null) throw new NotFoundError('This provider does not exist');
      return found;
    }),
    markUsed: vi.fn(),
  } as unknown as ProviderStore;
  const adapter = {} as ImageProvider;

  it('resolves image entries only, and answers adapter and existence from store and gateway', () => {
    const gateway = { image: (id: string | null) => (id === venice.id ? adapter : null) } as unknown as ProviderGateway;
    const directory = createImageProviderDirectory(store, gateway);
    expect(directory.resolve(undefined)).toEqual({ id: venice.id, name: 'Venice' });
    expect(store.resolve).toHaveBeenLastCalledWith(undefined, 'image');
    expect(directory.exists(venice.id)).toBe(true);
    expect(directory.exists(ollama.id)).toBe(false);
    expect(directory.exists(UNKNOWN)).toBe(false);
    expect(directory.adapter(venice.id)).toBe(adapter);
    expect(directory.adapter(ollama.id)).toBeNull();
    directory.markUsed(venice.id);
    expect(store.markUsed).toHaveBeenCalledWith(venice.id);
  });

  it('bounds a model lookup by its own timeout even when the caller never aborts', async () => {
    let seen: AbortSignal | undefined;
    const gateway = {
      imageModels: (_id: string, _refresh: boolean, signal: AbortSignal) => {
        seen = signal;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      },
    } as unknown as ProviderGateway;
    const directory = createImageProviderDirectory(store, gateway, { timeoutMs: 30 });
    expect(await directory.models(venice.id, new AbortController().signal)).toEqual({ ok: false, code: 'provider_timeout' });
    expect(seen?.aborted).toBe(true);
  });

  it('passes a cached or loaded list through and keeps the caller abort as an abort', async () => {
    const list = { ok: true as const, models: [] };
    const gateway = { imageModels: async () => list } as unknown as ProviderGateway;
    const directory = createImageProviderDirectory(store, gateway);
    expect(await directory.models(venice.id, new AbortController().signal)).toBe(list);

    const hanging = {
      imageModels: (_id: string, _refresh: boolean, signal: AbortSignal) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    } as unknown as ProviderGateway;
    const caller = new AbortController();
    const pending = createImageProviderDirectory(store, hanging).models(venice.id, caller.signal);
    caller.abort(new Error('caller'));
    await expect(pending).rejects.toThrow('caller');
  });
});

describe('generation image source', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'af-gen-source-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const sha256 = 'a'.repeat(64);
  const signal = new AbortController().signal;

  it('sends a PNG, JPEG or WebP original as it is without asking for a rendition', async () => {
    const path = join(dir, 'oak.png');
    const bytes = pngOf(4, 4);
    await writeFile(path, bytes);
    const get = vi.fn(async () => null);
    const source = createGenerationImageSource({ get });
    for (const mimeType of ['image/png', 'image/jpeg', 'image/webp'] as const) {
      const image = await source.read({ absolutePath: path, mimeType, sha256, sizeBytes: bytes.length }, signal);
      expect(image).toEqual({ data: new Uint8Array(bytes), mimeType });
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('uses the lossless rendition for another type or an original over the limit', async () => {
    const original = join(dir, 'oak.tif');
    await writeFile(original, 'tiff bytes');
    const rendition = join(dir, 'full.png');
    const bytes = pngOf(4, 4, 9);
    await writeFile(rendition, bytes);
    const get = vi.fn(async () => rendition);
    const source = createGenerationImageSource({ get });
    expect(await source.read({ absolutePath: original, mimeType: 'image/tiff', sha256, sizeBytes: 10 }, signal)).toEqual({
      data: new Uint8Array(bytes),
      mimeType: 'image/png',
    });
    expect(get).toHaveBeenLastCalledWith({ sha256, sourcePath: original, size: 'full' });
    expect(
      await source.read({ absolutePath: original, mimeType: 'image/png', sha256, sizeBytes: IMAGE_INPUT_MAX_BYTES + 1 }, signal),
    ).toEqual({ data: new Uint8Array(bytes), mimeType: 'image/png' });
  });

  it('never reads an original that grew past the limit since its size was stored', async () => {
    const path = join(dir, 'oak.png');
    await writeFile(path, Buffer.alloc(64));
    const get = vi.fn(async () => null);
    const source = createGenerationImageSource({ get }, { maxBytes: 16 });
    const read = vi.mocked(readFile);
    read.mockClear();
    try {
      expect(await source.read({ absolutePath: path, mimeType: 'image/png', sha256, sizeBytes: 8 }, signal)).toBeNull();
      expect(read).not.toHaveBeenCalledWith(path, expect.anything());
    } finally {
      read.mockClear();
    }
  });

  it('answers null when the rendition is evicted before it is read', async () => {
    const original = join(dir, 'oak.tif');
    await writeFile(original, 'tiff bytes');
    const rendition = join(dir, 'full.png');
    await writeFile(rendition, pngOf(4, 4));
    const source = createGenerationImageSource({ get: async () => rendition });
    // The cache removes it after it was found and measured.
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    expect(await source.read({ absolutePath: original, mimeType: 'image/tiff', sha256, sizeBytes: 10 }, signal)).toBeNull();
    // Without a rendition file at all, too.
    const missing = createGenerationImageSource({ get: async () => join(dir, 'gone.png') });
    expect(await missing.read({ absolutePath: original, mimeType: 'image/tiff', sha256, sizeBytes: 10 }, signal)).toBeNull();
  });

  it('answers null without a rendition or for a rendition over the limit', async () => {
    const original = join(dir, 'oak.tif');
    await writeFile(original, 'tiff bytes');
    expect(
      await createGenerationImageSource({ get: async () => null }).read(
        { absolutePath: original, mimeType: 'image/tiff', sha256, sizeBytes: 10 },
        signal,
      ),
    ).toBeNull();
    const rendition = join(dir, 'full.png');
    await writeFile(rendition, 'png');
    const source = createGenerationImageSource({ get: async () => rendition }, { maxBytes: 2 });
    expect(await source.read({ absolutePath: original, mimeType: 'image/tiff', sha256, sizeBytes: 1 }, signal)).toBeNull();
  });
});
