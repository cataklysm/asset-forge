import { describe, expect, it } from 'vitest';
import { ANALYZE_FILE_JOB, IMAGE_GENERATE_JOB, type Generation, type PromptDetail, type StartGeneration } from '@assetforge/contracts';
import {
  cancelAllJobs,
  clearFinishedJobs,
  createPrompt,
  InvalidOperationError,
  JobError,
  listGenerationsForFile,
  NotFoundError,
  ProviderNotConfiguredError,
  recentGenerationPrompts,
  reconcileGenerations,
  removeGeneration,
  retryFailedJobs,
  retryGeneration,
  savePromptVersion,
  startGeneration,
  trashFiles,
  ValidationFailedError,
} from '../src/index.js';
import { trashForTest } from './fakes.js';
import { OLLAMA_ID, OTHER_VENICE_ID, runNext, setup, UNKNOWN_ID, VENICE_ID, type Setup } from './generation-setup.js';

const edit = (fileId: string, patch: Partial<Extract<StartGeneration, { kind: 'edit' }>> = {}): StartGeneration => ({
  kind: 'edit',
  fileId,
  providerId: VENICE_ID,
  model: 'mock-edit',
  prompt: 'turn the head to the left',
  safeMode: true,
  ...patch,
});

const upscale = (fileId: string, scale: 2 | 4 = 2): StartGeneration => ({ kind: 'upscale', fileId, providerId: VENICE_ID, scale });

async function started(t: Setup, input: StartGeneration): Promise<Generation> {
  const result = await startGeneration(t.session, t.deps, input);
  if (!result.ok) throw new Error(`start answered ${result.code}`);
  return result.generation;
}

/** Expects the start to be refused with this error class and message, with nothing queued or stored. */
async function refused(t: Setup, input: StartGeneration, type: new (...args: never[]) => Error, message?: string): Promise<void> {
  const error = await startGeneration(t.session, t.deps, input).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(type);
  if (message !== undefined) expect((error as Error).message).toBe(message);
  expect(t.db.jobs.rows).toHaveLength(0);
  expect(t.db.generations.rows).toHaveLength(0);
  expect(t.control.wakes).toBe(0);
}

const NOT_USABLE = 'Only a complete image outside the trash can be used';

describe('startGeneration', () => {
  it('queues an edit: the pending generation, its input and one remote_api job in the entry lane', async () => {
    const t = await setup();
    const result = await startGeneration(t.session, t.deps, edit(t.file.id, { prompt: '  turn left  ', aspectRatio: '16:9', resolution: '2K' }));
    expect(result.ok).toBe(true);
    const generation = result.ok ? result.generation : null;
    expect(generation).toMatchObject({
      kind: 'edit',
      status: 'pending',
      errorCode: null,
      providerId: VENICE_ID,
      providerName: 'Venice',
      providerKind: 'venice',
      model: 'mock-edit',
      prompt: 'turn left',
      parameters: { v: 1, aspectRatio: '16:9', resolution: '2K', safeMode: true },
      jobStatus: 'queued',
      inputs: [{ fileId: t.file.id, name: 'face.png', sha256: t.file.sha256, trashed: false }],
      outputs: [],
    });
    expect(t.db.jobs.rows).toEqual([
      expect.objectContaining({
        id: generation!.jobId,
        type: IMAGE_GENERATE_JOB,
        resourceClass: 'remote_api',
        fileId: t.file.id,
        lane: VENICE_ID,
        payload: { v: 1, generationId: generation!.id },
        dedupeKey: null,
        status: 'queued',
      }),
    ]);
    expect(t.providers.used).toEqual([VENICE_ID]);
    expect(t.control.wakes).toBe(1);
  });

  it('queues an upscale without a model or prompt and leaves unset edit parameters null', async () => {
    const t = await setup();
    const up = await started(t, upscale(t.file.id, 4));
    expect(up).toMatchObject({ kind: 'upscale', model: null, prompt: null, parameters: { v: 1, scale: 4 } });
    expect(t.providers.modelCalls).toEqual([]);
    const ed = await started(t, edit(t.file.id));
    expect(ed.parameters).toEqual({ v: 1, aspectRatio: null, resolution: null, safeMode: true });
  });

  it('allows several runs for one file', async () => {
    const t = await setup();
    await started(t, edit(t.file.id));
    await started(t, edit(t.file.id));
    expect(t.db.jobs.rows).toHaveLength(2);
  });

  it('refuses an unknown file with not_found', async () => {
    const t = await setup();
    await refused(t, edit(UNKNOWN_ID), NotFoundError);
  });

  it('refuses pending, failed and trashed files', async () => {
    const t = await setup();
    for (const status of ['pending', 'failed'] as const) {
      t.db.files.records.set(t.file.id, { ...t.db.files.records.get(t.file.id)!, status });
      await refused(t, edit(t.file.id), InvalidOperationError, NOT_USABLE);
    }
    t.db.files.records.set(t.file.id, { ...t.db.files.records.get(t.file.id)!, status: 'complete' });
    await trashForTest(t.session, [t.file.id]);
    await refused(t, edit(t.file.id), InvalidOperationError, NOT_USABLE);
  });

  it('refuses an SVG', async () => {
    const t = await setup();
    const svg = await t.importOne('logo.svg');
    await refused(t, edit(svg.id), InvalidOperationError, NOT_USABLE);
  });

  it('refuses 200 x 200 pixels, measuring a file without dimensions on demand', async () => {
    const t = await setup();
    t.fake.probe.result = { width: 200, height: 200 };
    t.db.files.records.set(t.file.id, { ...t.db.files.records.get(t.file.id)!, width: null, height: null });
    await refused(t, edit(t.file.id), InvalidOperationError, 'This image cannot be sent to the provider');
    expect(t.db.files.records.get(t.file.id)).toMatchObject({ width: 200, height: 200 });
  });

  it('refuses an image whose size cannot be measured or that is over the pixel bound', async () => {
    const t = await setup();
    t.fake.probe.result = null;
    t.db.files.records.set(t.file.id, { ...t.db.files.records.get(t.file.id)!, width: null, height: null });
    await refused(t, edit(t.file.id), InvalidOperationError, 'This image cannot be sent to the provider');
    t.db.files.records.set(t.file.id, { ...t.db.files.records.get(t.file.id)!, width: 8000, height: 5000 });
    await refused(t, edit(t.file.id), InvalidOperationError, 'This image cannot be sent to the provider');
  });

  it('refuses a blank prompt and one of 8001 characters', async () => {
    const t = await setup();
    const message = 'The prompt must have 1 to 8000 characters';
    await refused(t, edit(t.file.id, { prompt: '   ' }), ValidationFailedError, message);
    await refused(t, edit(t.file.id, { model: 'free-edit', prompt: 'x'.repeat(8001) }), ValidationFailedError, message);
    expect(t.providers.modelCalls).toEqual([]);
    expect((await started(t, edit(t.file.id, { model: 'free-edit', prompt: 'x'.repeat(8000) }))).prompt).toHaveLength(8000);
  });

  it('refuses 1501 characters for mock-edit and accepts 1500', async () => {
    const t = await setup();
    await refused(t, edit(t.file.id, { prompt: 'x'.repeat(1501) }), ValidationFailedError, 'The prompt is longer than this model allows');
    await started(t, edit(t.file.id, { prompt: 'x'.repeat(1500) }));
  });

  it('refuses an unknown model, aspect ratio or resolution', async () => {
    const t = await setup();
    await refused(t, edit(t.file.id, { model: 'nope' }), ValidationFailedError, 'This model is not offered by the provider');
    await refused(t, edit(t.file.id, { aspectRatio: '4:3' }), ValidationFailedError, 'This aspect ratio is not offered by the model');
    await refused(t, edit(t.file.id, { resolution: '4K' }), ValidationFailedError, 'This resolution is not offered by the model');
  });

  it('lets a model without constraints accept any aspect ratio and resolution', async () => {
    const t = await setup();
    const g = await started(t, edit(t.file.id, { model: 'free-edit', aspectRatio: '21:9', resolution: '4K' }));
    expect(g.parameters).toMatchObject({ aspectRatio: '21:9', resolution: '4K' });
  });

  it('answers a models result that is not ok as it is and queues nothing', async () => {
    const t = await setup();
    t.providers.modelsResult = { ok: false, code: 'provider_unreachable' };
    expect(await startGeneration(t.session, t.deps, edit(t.file.id))).toEqual({ ok: false, code: 'provider_unreachable' });
    expect(t.db.jobs.rows).toHaveLength(0);
    expect(t.db.generations.rows).toHaveLength(0);
    expect(t.providers.used).toEqual([]);
    expect(t.control.wakes).toBe(0);
  });

  it('refuses an ollama id and answers provider_not_configured without any entry', async () => {
    const t = await setup();
    await refused(t, edit(t.file.id, { providerId: OLLAMA_ID }), InvalidOperationError, 'This provider cannot generate images');
    await refused(t, edit(t.file.id, { providerId: UNKNOWN_ID }), NotFoundError);
    t.providers.entries = t.providers.entries.filter((e) => e.kind === 'ollama');
    await refused(t, { ...edit(t.file.id), providerId: undefined }, ProviderNotConfiguredError);
  });

  it('runs on the entry used last when no id is given', async () => {
    const t = await setup();
    t.providers.lastUsed = OTHER_VENICE_ID;
    const g = await started(t, { ...edit(t.file.id), providerId: undefined });
    expect(g).toMatchObject({ providerId: OTHER_VENICE_ID, providerName: 'Venice 2' });
    expect(t.db.jobs.rows[0]!.lane).toBe(OTHER_VENICE_ID);
    expect(t.providers.modelCalls).toEqual([OTHER_VENICE_ID]);
  });

  it('refuses an upscale x4 of 6000 x 5000 and accepts x2 of 5000 x 5000 (exactly the bound)', async () => {
    const t = await setup();
    t.db.files.records.set(t.file.id, { ...t.db.files.records.get(t.file.id)!, width: 6000, height: 5000 });
    await refused(t, upscale(t.file.id, 4), InvalidOperationError, 'The upscaled image would be too large');
    t.db.files.records.set(t.file.id, { ...t.db.files.records.get(t.file.id)!, width: 5000, height: 5000 });
    await started(t, upscale(t.file.id, 2));
  });

  it('checks the file before the provider and the prompt before the model list', async () => {
    const t = await setup();
    const entries = t.providers.entries;
    t.providers.entries = [];
    await refused(t, edit(UNKNOWN_ID), NotFoundError);
    t.providers.entries = entries;
    t.providers.modelsResult = { ok: false, code: 'provider_unreachable' };
    await refused(t, edit(t.file.id, { prompt: '' }), ValidationFailedError);
    expect(t.providers.modelCalls).toEqual([]);
  });
});

describe('startGeneration from a prompt version', () => {
  async function libraryPrompt(t: Setup, content = 'A {{view}} view'): Promise<PromptDetail> {
    return createPrompt(t.session, { title: 'Turnaround', description: '', content, defaults: {} });
  }

  const fromVersion = (fileId: string, promptVersionId: string, variables: Record<string, string>): StartGeneration =>
    edit(fileId, { prompt: undefined, promptVersionId, variables });

  it('stores the resolved text, the version reference and the trimmed values by the version spelling', async () => {
    const t = await setup();
    const prompt = await libraryPrompt(t);
    const g = await started(t, fromVersion(t.file.id, prompt.currentVersion.id, { VIEW: ' side ' }));
    expect(g).toMatchObject({
      prompt: 'A side view',
      promptId: prompt.id,
      promptVersionId: prompt.currentVersion.id,
      promptTitle: 'Turnaround',
      promptVersionNumber: 1,
      promptVariables: { view: 'side' },
    });
    expect(await recentGenerationPrompts(t.session)).toEqual(['A side view']);
  });

  it('stores a value that contains a placeholder verbatim', async () => {
    const t = await setup();
    const prompt = await libraryPrompt(t);
    const g = await started(t, fromVersion(t.file.id, prompt.currentVersion.id, { view: '{{view}}' }));
    expect(g.prompt).toBe('A {{view}} view');
    expect(g.promptVariables).toEqual({ view: '{{view}}' });
  });

  it('refuses a missing value, an unknown name, a value over the limit and an unknown version before the model list', async () => {
    const t = await setup();
    const prompt = await libraryPrompt(t);
    const versionId = prompt.currentVersion.id;
    await refused(t, fromVersion(t.file.id, versionId, {}), ValidationFailedError, 'Every variable needs a value');
    await refused(t, fromVersion(t.file.id, versionId, { view: '   ' }), ValidationFailedError, 'Every variable needs a value');
    await refused(t, fromVersion(t.file.id, versionId, { view: 'side', angle: 'low' }), ValidationFailedError, 'This prompt has no such variable');
    await refused(t, fromVersion(t.file.id, versionId, { view: 'x'.repeat(2001) }), ValidationFailedError, 'This text is too long');
    await refused(t, fromVersion(t.file.id, UNKNOWN_ID, { view: 'side' }), NotFoundError, 'This prompt version does not exist');
    expect(t.providers.modelCalls).toEqual([]);
  });

  it('applies the model limit to the resolved text', async () => {
    const t = await setup();
    const prompt = await libraryPrompt(t, `${'x'.repeat(1490)} {{view}}`);
    const versionId = prompt.currentVersion.id;
    await refused(t, fromVersion(t.file.id, versionId, { view: 'y'.repeat(10) }), ValidationFailedError, 'The prompt is longer than this model allows');
    expect((await started(t, fromVersion(t.file.id, versionId, { view: 'y'.repeat(9) }))).prompt).toHaveLength(1500);
  });

  it('starts from an older version and records its number', async () => {
    const t = await setup();
    const first = await libraryPrompt(t);
    await savePromptVersion(t.session, {
      promptId: first.id,
      baseVersionId: first.currentVersion.id,
      content: 'A {{view}} view at night',
      defaults: {},
    });
    const g = await started(t, fromVersion(t.file.id, first.currentVersion.id, { view: 'front' }));
    expect(g).toMatchObject({ prompt: 'A front view', promptVersionId: first.currentVersion.id, promptVersionNumber: 1 });
  });

  it('records no prompt reference for a free prompt', async () => {
    const t = await setup();
    await libraryPrompt(t);
    const g = await started(t, edit(t.file.id));
    expect(g).toMatchObject({ promptId: null, promptVersionId: null, promptTitle: null, promptVersionNumber: null, promptVariables: null });
  });
});

describe('listGenerationsForFile', () => {
  it('answers the generation that made a file and the ones that read it, newest first', async () => {
    const t = await setup();
    const first = await started(t, edit(t.file.id));
    const second = await started(t, upscale(t.file.id));
    await runNext(t);
    const forSource = await listGenerationsForFile(t.session, t.file.id);
    expect(forSource.madeBy).toBeNull();
    expect(forSource.results.map((g) => g.id)).toEqual([second.id, first.id]);
    const outputId = forSource.results[1]!.outputs[0]!.fileId!;
    const forResult = await listGenerationsForFile(t.session, outputId);
    expect(forResult.madeBy?.id).toBe(first.id);
    expect(forResult.results).toEqual([]);
  });
});

describe('retryGeneration', () => {
  async function failedOne(t: Setup): Promise<Generation> {
    const g = await started(t, edit(t.file.id));
    t.providers.provider.answer = async () => {
      throw new JobError('provider_rejected');
    };
    await runNext(t);
    const failed = (await t.db.generations.get(g.id))!;
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'provider_rejected' });
    return failed;
  }

  it('reuses the generation with a new job, also after the finished jobs were cleared', async () => {
    const t = await setup();
    const failed = await failedOne(t);
    expect(await clearFinishedJobs(t.session)).toBe(1);
    const wakes = t.control.wakes;
    const retried = await retryGeneration(t.session, t.deps, failed.id);
    expect(retried).toMatchObject({ id: failed.id, status: 'pending', errorCode: null, finishedAt: null, jobStatus: 'queued' });
    expect(retried.jobId).not.toBe(failed.jobId);
    expect(t.db.jobs.rows).toEqual([
      expect.objectContaining({ id: retried.jobId, type: IMAGE_GENERATE_JOB, lane: VENICE_ID, payload: { v: 1, generationId: failed.id } }),
    ]);
    expect(t.control.wakes).toBe(wakes + 1);
    expect(t.db.generations.rows).toHaveLength(1);
  });

  it('retries a cancelled generation', async () => {
    const t = await setup();
    const g = await started(t, edit(t.file.id));
    await t.control.cancel(g.jobId!);
    expect((await t.db.generations.get(g.id))!.status).toBe('cancelled');
    expect((await retryGeneration(t.session, t.deps, g.id)).status).toBe('pending');
  });

  it('refuses a succeeded and a pending generation, and an unknown one', async () => {
    const t = await setup();
    const done = await started(t, edit(t.file.id));
    await runNext(t);
    const pending = await started(t, edit(t.file.id));
    for (const id of [done.id, pending.id]) {
      const error = await retryGeneration(t.session, t.deps, id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidOperationError);
      expect((error as Error).message).toBe('Only a failed or cancelled generation can be retried');
    }
    const unknown = await retryGeneration(t.session, t.deps, UNKNOWN_ID).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(NotFoundError);
    expect((unknown as Error).message).toBe('This generation does not exist');
    expect(t.db.jobs.rows).toHaveLength(2);
  });

  it('refuses a trashed input', async () => {
    const t = await setup();
    const failed = await failedOne(t);
    await trashForTest(t.session, [t.file.id]);
    const error = await retryGeneration(t.session, t.deps, failed.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidOperationError);
    expect((error as Error).message).toBe(NOT_USABLE);
    expect((await t.db.generations.get(failed.id))!.status).toBe('failed');
  });

  it('refuses an input whose content changed', async () => {
    const t = await setup();
    const failed = await failedOne(t);
    t.db.files.records.set(t.file.id, { ...t.db.files.records.get(t.file.id)!, sha256: 'f'.repeat(64) });
    await expect(retryGeneration(t.session, t.deps, failed.id)).rejects.toThrow(NOT_USABLE);
  });

  it('refuses when the entry was deleted', async () => {
    const t = await setup();
    const failed = await failedOne(t);
    t.providers.entries = t.providers.entries.filter((e) => e.id !== VENICE_ID);
    await expect(retryGeneration(t.session, t.deps, failed.id)).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect((await t.db.generations.get(failed.id))!.status).toBe('failed');
  });
});

describe('removeGeneration', () => {
  it('removes a cancelled generation and refuses a succeeded one', async () => {
    const t = await setup();
    const done = await started(t, edit(t.file.id));
    await runNext(t);
    const error = await removeGeneration(t.session, done.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidOperationError);
    expect((error as Error).message).toBe('Only a failed or cancelled generation can be removed');
    const cancelled = await started(t, edit(t.file.id));
    await t.control.cancel(cancelled.jobId!);
    await removeGeneration(t.session, cancelled.id);
    expect(await t.db.generations.get(cancelled.id)).toBeNull();
    await expect(removeGeneration(t.session, UNKNOWN_ID)).rejects.toThrow('This generation does not exist');
  });
});

describe('recentGenerationPrompts and reconcileGenerations', () => {
  it('answers the distinct edit prompts, newest first', async () => {
    const t = await setup();
    await started(t, edit(t.file.id, { prompt: 'one' }));
    await started(t, upscale(t.file.id));
    await started(t, edit(t.file.id, { prompt: 'two' }));
    await started(t, edit(t.file.id, { prompt: 'one' }));
    expect(await recentGenerationPrompts(t.session)).toEqual(['one', 'two']);
  });

  it('fails a pending generation whose job row is gone with provider_outcome_unknown', async () => {
    const t = await setup();
    const g = await started(t, edit(t.file.id));
    t.db.jobs.rows.splice(0);
    expect(await reconcileGenerations(t.session)).toBe(1);
    expect(await t.db.generations.get(g.id)).toMatchObject({ status: 'failed', errorCode: 'provider_outcome_unknown' });
  });
});

describe('the trash and generation jobs', () => {
  it('trashing the source cancels its queued generation job through the control; the generation is cancelled', async () => {
    const t = await setup();
    const g = await started(t, edit(t.file.id));
    const [item] = await trashFiles(t.session, t.control, [t.file.id]);
    expect(item!.error).toBeNull();
    expect(t.control.cancelled).toEqual([g.jobId]);
    expect(await t.db.generations.get(g.id)).toMatchObject({ status: 'cancelled', jobStatus: 'cancelled' });
  });
});

describe('job use cases around generations', () => {
  it('retryFailedJobs skips a failed generation job and requeues a failed analysis job', async () => {
    const t = await setup();
    const g = await started(t, edit(t.file.id));
    const other = await t.importOne('car.png');
    await t.db.jobs.enqueue({
      jobs: [{ id: crypto.randomUUID(), type: ANALYZE_FILE_JOB, resourceClass: 'local_gpu', fileId: other.id, lane: null, payload: {}, dedupeKey: null }],
      now: t.session.now().toISOString(),
    });
    for (const row of t.db.jobs.rows) row.status = 'failed';
    expect(await retryFailedJobs(t.session)).toBe(1);
    expect(t.db.jobs.rows.find((r) => r.id === g.jobId)!.status).toBe('failed');
    expect(t.db.jobs.rows.find((r) => r.type === ANALYZE_FILE_JOB)!.status).toBe('queued');
  });

  it('cancelAllJobs delegates to cancelAll', async () => {
    const t = await setup();
    await started(t, edit(t.file.id));
    expect(await cancelAllJobs(t.session, t.control)).toBe(7);
    expect(t.control.cancelAllCalls).toBe(1);
    expect(t.control.cancelled).toEqual([]);
    expect(t.db.jobs.rows[0]!.status).toBe('queued');
  });
});
