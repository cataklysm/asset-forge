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
  async function setup(o: { fastRetries?: boolean } = {}): Promise<{ entry: ProviderView; assetId: string }> {
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
