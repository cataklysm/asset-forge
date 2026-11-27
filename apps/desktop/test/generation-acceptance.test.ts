import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IMAGE_GENERATE_JOB, type FileRecord, type Generation, type JobSummary, type ProviderView } from '@assetforge/contracts';
import {
  MOCK_EDIT_MODEL,
  MOCK_PROMPT_BUSY,
  MOCK_PROMPT_FAIL,
  MOCK_PROMPT_SLOW,
  startMockProvider,
  type MockProvider,
} from '../../../docker/mock-provider/server.mjs';
import { createHarness, filesBelow, TEST_KEY, type Harness } from './analysis-harness.js';

// End to end with a real SQLite workspace, the real scheduler and the in-process mock's Venice endpoints.

const active = (s: JobSummary) => s.queued + s.running + s.waiting;
const page = { limit: 100, offset: 0 };

describe('generation studio end to end', () => {
  let h: Harness;
  let mock: MockProvider | undefined;

  afterEach(async () => {
    await h.close();
    await mock?.close();
    mock = undefined;
  });

  /** A harness, the mock with `TEST_KEY`, a `venice` entry for it and a workspace with one asset. */
  async function setup(o: { fastRetries?: boolean; host?: { workspaceOpened: () => Promise<void> } } = {}): Promise<{
    entry: ProviderView;
    assetId: string;
  }> {
    h = await createHarness(o);
    mock = await startMockProvider({ port: 0, apiKey: TEST_KEY });
    const entry = await h.venice({ url: mock.url, apiKey: TEST_KEY });
    await h.ok('workspace:create', { name: 'Studio', rootPath: join(h.base, 'workspace') });
    const types = await h.ok('assetTypes:list', {});
    const asset = await h.ok('assets:create', { name: 'Oak', typeId: types[0]!.id });
    return { entry, assetId: asset.id };
  }

  const edit = (fileId: string, prompt: string) =>
    h.ok('generations:start', { kind: 'edit', fileId, model: MOCK_EDIT_MODEL, prompt, aspectRatio: '1:1', resolution: '4K', safeMode: true });

  /** Starts a generation and answers it; fails the test when the start was refused. */
  async function started(result: Promise<{ ok: true; generation: Generation } | { ok: false; code: string }>): Promise<Generation> {
    const answer = await result;
    if (!answer.ok) throw new Error(`generations:start answered ${answer.code}`);
    return answer.generation;
  }

  async function generation(fileId: string, id: string): Promise<Generation> {
    const { results } = await h.ok('generations:forFile', { fileId });
    const found = results.find((g) => g.id === id);
    if (found === undefined) throw new Error('generation not listed');
    return found;
  }

  /** Waits until `check` holds for the mock's state; fails the test after `timeoutMs`. */
  async function untilMock(check: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for the mock provider');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function filesOf(assetId: string): Promise<FileRecord[]> {
    return (await h.ok('files:list', { ...page, scope: { kind: 'asset', assetId } })).items;
  }

  it('edits an image into its asset, upscales the result and keeps the lineage after the source is purged', async () => {
    const { entry, assetId } = await setup();
    const sourceId = await h.importPng({ name: 'oak.png', width: 256, height: 256, target: { assetId, role: 'reference' } });

    const first = await started(edit(sourceId, 'Make it night'));
    expect(first).toMatchObject({ kind: 'edit', status: 'pending', providerId: entry.id, providerName: 'Venice', model: MOCK_EDIT_MODEL });
    await h.until((s) => s.succeeded === 1 && active(s) === 0);

    const done = await generation(sourceId, first.id);
    expect(done).toMatchObject({ status: 'succeeded', errorCode: null, prompt: 'Make it night' });
    const resultId = done.outputs[0]!.fileId!;
    const result = (await filesOf(assetId)).find((f) => f.id === resultId);
    expect(result).toMatchObject({ status: 'complete', assetId, role: 'generated', originalName: 'oak edit 1.png', width: 256, height: 256 });
    expect((await h.ok('generations:forFile', { fileId: resultId })).madeBy).toMatchObject({
      id: first.id,
      inputs: [{ fileId: sourceId, name: 'oak.png', trashed: false }],
    });
    expect(mock!.imageRequests).toHaveLength(1);
    expect(mock!.imageRequests[0]).toMatchObject({
      path: '/api/v1/image/edit',
      authorization: `Bearer ${TEST_KEY}`,
      fields: { model: MOCK_EDIT_MODEL, prompt: 'Make it night' },
    });

    const upscale = await started(h.ok('generations:start', { kind: 'upscale', fileId: resultId, scale: 2 }));
    await h.until((s) => s.succeeded === 2 && active(s) === 0);
    const upscaled = await generation(resultId, upscale.id);
    expect(upscaled).toMatchObject({ kind: 'upscale', status: 'succeeded', model: null, prompt: null });
    const big = (await filesOf(assetId)).find((f) => f.id === upscaled.outputs[0]!.fileId);
    expect(big).toMatchObject({ originalName: 'oak edit 1 2x.png', role: 'generated', width: 512, height: 512 });
    expect(mock!.imageRequests[1]).toMatchObject({ path: '/api/v1/image/upscale', fields: { scale: '2' } });

    expect(await h.ok('files:trashMany', { fileIds: [sourceId] })).toMatchObject({ items: [{ error: null }] });
    expect((await h.ok('generations:forFile', { fileId: resultId })).madeBy?.inputs).toEqual([
      expect.objectContaining({ fileId: sourceId, name: 'oak.png', trashed: true }),
    ]);
    expect(await h.ok('files:purgeMany', { fileIds: [sourceId] })).toMatchObject({ items: [{ error: null }] });
    expect((await h.ok('generations:forFile', { fileId: resultId })).madeBy).toMatchObject({
      id: first.id,
      status: 'succeeded',
      inputs: [{ fileId: null, name: 'oak.png' }],
    });

    for (const line of h.responses) expect(line).not.toContain(TEST_KEY);
    for (const line of h.logs) expect(line).not.toContain(TEST_KEY);
    for (const { text } of await filesBelow(h.base)) expect(text).not.toContain(TEST_KEY);
  });

  it('edits from a prompt version, keeps its copies after the prompt is deleted and refuses the deleted version', async () => {
    const { assetId } = await setup();
    const sourceId = await h.importPng({ name: 'oak.png', width: 256, height: 256, target: { assetId, role: 'reference' } });
    const prompt = await h.ok('prompts:create', { title: 'Turnaround', description: '', content: 'A {{view}} view at night', defaults: {} });
    const versionId = prompt.currentVersion.id;
    const start = { kind: 'edit', fileId: sourceId, model: MOCK_EDIT_MODEL, promptVersionId: versionId, safeMode: true } as const;

    const first = await started(h.ok('generations:start', { ...start, variables: { View: ' side ' } }));
    await h.until((s) => s.succeeded === 1 && active(s) === 0);
    expect(mock!.imageRequests).toHaveLength(1);
    expect(mock!.imageRequests[0]).toMatchObject({ path: '/api/v1/image/edit', fields: { prompt: 'A side view at night' } });
    expect(await generation(sourceId, first.id)).toMatchObject({
      status: 'succeeded',
      prompt: 'A side view at night',
      promptId: prompt.id,
      promptVersionId: versionId,
      promptTitle: 'Turnaround',
      promptVersionNumber: 1,
      promptVariables: { view: 'side' },
    });

    expect(await h.ok('prompts:delete', { promptId: prompt.id })).toEqual({});
    expect(await generation(sourceId, first.id)).toMatchObject({
      prompt: 'A side view at night',
      promptId: null,
      promptVersionId: null,
      promptTitle: 'Turnaround',
      promptVersionNumber: 1,
      promptVariables: { view: 'side' },
    });
    expect(await h.call('generations:start', { ...start, variables: { view: 'side' } })).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'This prompt version does not exist' },
    });
    expect(mock!.imageRequests).toHaveLength(1);
  });

  it('retries a failed generation from a prompt version with its text and copies', async () => {
    const { assetId } = await setup();
    const sourceId = await h.importPng({ name: 'oak.png', width: 256, height: 256, target: { assetId, role: 'reference' } });
    const prompt = await h.ok('prompts:create', { title: 'Failing', description: '', content: 'mock:{{code}}', defaults: {} });
    const copies = {
      prompt: MOCK_PROMPT_FAIL,
      promptId: prompt.id,
      promptVersionId: prompt.currentVersion.id,
      promptTitle: 'Failing',
      promptVersionNumber: 1,
      promptVariables: { code: '500' },
    };
    const failing = await started(
      h.ok('generations:start', {
        kind: 'edit',
        fileId: sourceId,
        model: MOCK_EDIT_MODEL,
        promptVersionId: prompt.currentVersion.id,
        variables: { code: '500' },
        safeMode: true,
      }),
    );
    await h.until((s) => s.failed === 1 && active(s) === 0);
    expect(await generation(sourceId, failing.id)).toMatchObject({ status: 'failed', ...copies });

    expect(await h.ok('generations:retry', { generationId: failing.id })).toMatchObject({ status: 'pending', ...copies });
    await h.until((s) => s.failed === 2 && active(s) === 0);
    expect(await generation(sourceId, failing.id)).toMatchObject({ status: 'failed', ...copies });
    expect(mock!.imageRequests.map((r) => r.fields.prompt)).toEqual([MOCK_PROMPT_FAIL, MOCK_PROMPT_FAIL]);
  });

  it('fails a 500 as provider_outcome_unknown after one request and never repeats it', async () => {
    const { assetId } = await setup();
    const sourceId = await h.importPng({ name: 'oak.png', width: 256, height: 256, target: { assetId, role: 'reference' } });
    const started500 = await started(edit(sourceId, MOCK_PROMPT_FAIL));
    await h.until((s) => s.failed === 1 && active(s) === 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mock!.imageRequests).toHaveLength(1);
    const [job] = (await h.ok('jobs:list', page)).items;
    expect(job).toMatchObject({ type: IMAGE_GENERATE_JOB, status: 'failed', attempt: 1, errorCode: 'provider_outcome_unknown' });
    expect(await generation(sourceId, started500.id)).toMatchObject({ status: 'failed', errorCode: 'provider_outcome_unknown' });
    expect((await filesOf(assetId)).map((f) => f.id)).toEqual([sourceId]);
  });

  it('retries a 429 and ends with the third failure', async () => {
    const { assetId } = await setup({ fastRetries: true });
    const sourceId = await h.importPng({ name: 'oak.png', width: 256, height: 256, target: { assetId, role: 'reference' } });
    const busy = await started(edit(sourceId, MOCK_PROMPT_BUSY));
    await h.until((s) => s.failed === 1 && active(s) === 0);
    expect(mock!.imageRequests).toHaveLength(3);
    const [job] = (await h.ok('jobs:list', page)).items;
    expect(job).toMatchObject({ status: 'failed', attempt: 3, errorCode: 'provider_unavailable' });
    expect(await generation(sourceId, busy.id)).toMatchObject({ status: 'failed', errorCode: 'provider_unavailable' });
  });

  describe('without a scheduler', () => {
    // The workspace opens but no scheduler starts, so every job stays queued.
    const noScheduler = { host: { workspaceOpened: async () => {} } };

    it('jobs:cancel ends a queued generation job and settles its generation cancelled', async () => {
      const { assetId } = await setup(noScheduler);
      const sourceId = await h.importPng({ name: 'oak.png', width: 256, height: 256, target: { assetId, role: 'reference' } });
      const g = await started(edit(sourceId, 'Make it night'));
      const before = (await h.ok('jobs:summary', {})).changes;

      expect(await h.ok('jobs:cancel', { jobId: g.jobId! })).toEqual({});
      const summary = await h.ok('jobs:summary', {});
      expect(summary).toMatchObject({ queued: 0, cancelled: 1 });
      expect(summary.changes).toBeGreaterThan(before);
      expect(await generation(sourceId, g.id)).toMatchObject({ status: 'cancelled', errorCode: null });
      expect(mock!.imageRequests).toHaveLength(0);
    });

    it('jobs:cancelAll ends every waiting job, answers the count and settles the generations cancelled', async () => {
      const { assetId } = await setup(noScheduler);
      const sourceId = await h.importPng({ name: 'oak.png', width: 256, height: 256, target: { assetId, role: 'reference' } });
      const gs = [await started(edit(sourceId, 'Make it night')), await started(edit(sourceId, 'Make it day'))];

      expect(await h.ok('jobs:cancelAll', {})).toEqual({ cancelled: 2 });
      expect(await h.ok('jobs:summary', {})).toMatchObject({ queued: 0, cancelled: 2 });
      for (const g of gs) expect(await generation(sourceId, g.id)).toMatchObject({ status: 'cancelled' });
      expect(await h.ok('jobs:cancelAll', {})).toEqual({ cancelled: 0 });
      expect(mock!.imageRequests).toHaveLength(0);
    });
  });

  it('lets running generations finish into the former asset when their source goes to the trash, cancels the queued one and never repeats a request', async () => {
    const { assetId } = await setup();
    const sourceId = await h.importPng({ name: 'oak.png', width: 256, height: 256, target: { assetId, role: 'reference' } });
    const running = [await started(edit(sourceId, MOCK_PROMPT_SLOW)), await started(edit(sourceId, MOCK_PROMPT_SLOW))];
    // Both requests were sent and wait at the mock for their answer.
    await untilMock(() => mock!.slowWaiting() === 2);
    expect(mock!.imageRequests).toHaveLength(2);
    // The remote limit is two per lane, so the third waits in the queue.
    const queued = await started(edit(sourceId, 'Make it night'));
    expect(await h.ok('jobs:summary', {})).toMatchObject({ running: 2, queued: 1 });

    expect(await h.ok('files:trashMany', { fileIds: [sourceId] })).toMatchObject({ items: [{ error: null }] });
    await h.until((s) => s.cancelled === 1 && s.queued === 0 && s.running === 2);
    // The paid requests already sent finish: their answers are kept.
    mock!.releaseSlow();
    // With no job active nothing is left that could send a request again.
    await h.until((s) => s.succeeded === 2 && s.cancelled === 1 && active(s) === 0);
    expect(mock!.slowWaiting()).toBe(0);

    const { results } = await h.ok('generations:forFile', { fileId: sourceId });
    expect(new Map(results.map((g) => [g.id, g.status]))).toEqual(
      new Map([...running.map((g) => [g.id, 'succeeded'] as const), [queued.id, 'cancelled'] as const]),
    );
    // One request for each running generation, none for the queued one, and none repeated.
    expect(mock!.imageRequests).toHaveLength(2);
    const files = await filesOf(assetId);
    expect(files).toHaveLength(2);
    for (const file of files) expect(file).toMatchObject({ status: 'complete', assetId, role: 'generated' });
    expect(files.map((f) => f.id).sort()).toEqual(
      results.filter((g) => g.status === 'succeeded').map((g) => g.outputs[0]!.fileId!).sort(),
    );
  });

  it('fails a slow edit interrupted by closing as provider_outcome_unknown and sends it only once', async () => {
    const { assetId } = await setup();
    const sourceId = await h.importPng({ name: 'oak.png', width: 256, height: 256, target: { assetId, role: 'reference' } });
    const slow = await started(edit(sourceId, MOCK_PROMPT_SLOW));
    await h.until((s) => s.running === 1);
    const deadline = Date.now() + 10_000;
    while (mock!.imageRequests.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mock!.imageRequests).toHaveLength(1);

    await h.services.workspaceClosing();
    await h.ok('workspace:open', { rootPath: join(h.base, 'workspace') });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const [job] = (await h.ok('jobs:list', page)).items;
    expect(job).toMatchObject({ status: 'failed', errorCode: 'provider_outcome_unknown' });
    expect(await generation(sourceId, slow.id)).toMatchObject({ status: 'failed', errorCode: 'provider_outcome_unknown' });
    expect(mock!.imageRequests).toHaveLength(1);
    expect((await filesOf(assetId)).map((f) => f.id)).toEqual([sourceId]);
  });
});
