import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { IMAGE_GENERATE_JOB, type Generation, type StartGeneration } from '@assetforge/contracts';
import { createAsset, generationNames, JobError, relocateFile, startGeneration } from '../src/index.js';
import { trashForTest } from './fakes.js';
import { expectJobError, failingStream, outcomeOf, RESULT_BYTES, runNext, setup, VENICE_ID, type Setup } from './generation-setup.js';

const edit = (fileId: string): StartGeneration => ({
  kind: 'edit',
  fileId,
  providerId: VENICE_ID,
  model: 'mock-edit',
  prompt: 'turn the head to the left',
  aspectRatio: '1:1',
  safeMode: false,
});

async function started(t: Setup, input: StartGeneration): Promise<Generation> {
  const result = await startGeneration(t.session, t.deps, input);
  if (!result.ok) throw new Error(`start answered ${result.code}`);
  return result.generation;
}

const generation = async (t: Setup, id: string) => (await t.db.generations.get(id))!;
/** The files other than the source. */
const results = (t: Setup) => [...t.db.files.records.values()].filter((f) => f.id !== t.file.id);

async function newAsset(t: Setup, name: string): Promise<string> {
  const types = await t.db.assetTypes.list();
  return (await createAsset(t.session, { name, typeId: types[0]!.id })).id;
}

describe('generationNames', () => {
  it('names an edit and an upscale after the source base name', () => {
    expect(generationNames.edit('face.png', 3)).toBe('face edit 3.png');
    expect(generationNames.upscale('face.jpeg', 2)).toBe('face 2x.png');
    expect(generationNames.edit('archive.tar.gz', 1)).toBe('archive.tar edit 1.png');
    expect(generationNames.upscale('noext', 4)).toBe('noext 4x.png');
    expect(generationNames.edit('.hidden', 1)).toBe('.hidden edit 1.png');
    expect(generationNames.edit('face.png', 2, 'webp')).toBe('face edit 2.webp');
    expect(generationNames.upscale('face.png', 4, 'jpg')).toBe('face 4x.jpg');
  });
});

describe('the image.generate handler', () => {
  it('is a remote_api handler that fails an interrupted job with provider_outcome_unknown', async () => {
    const t = await setup();
    expect(t.handler).toMatchObject({ resourceClass: 'remote_api', onInterrupted: 'fail', interruptedCode: 'provider_outcome_unknown' });
  });

  it('edits: sends the read image with the stored parameters and imports the answer as `face edit 1.png`', async () => {
    const t = await setup();
    const g = await started(t, edit(t.file.id));
    const { error } = await runNext(t);
    expect(error).toBeNull();
    expect(t.images.reads).toEqual([
      { absolutePath: `/memory/${t.file.relativePath}`, mimeType: 'image/png', sha256: t.file.sha256, sizeBytes: t.file.sizeBytes },
    ]);
    expect(t.providers.provider.edits).toEqual([
      {
        image: t.images.result,
        model: 'mock-edit',
        prompt: 'turn the head to the left',
        aspectRatio: '1:1',
        resolution: null,
        safeMode: false,
      },
    ]);
    const [result] = results(t);
    expect(result).toMatchObject({ originalName: 'face edit 1.png', status: 'complete', mimeType: 'image/png', assetId: null, role: null });
    expect(t.storage.files.get(result!.relativePath)).toEqual(RESULT_BYTES);
    expect(await generation(t, g.id)).toMatchObject({
      status: 'succeeded',
      errorCode: null,
      jobStatus: 'succeeded',
      outputs: [{ fileId: result!.id, name: 'face edit 1.png', sha256: result!.sha256, trashed: false }],
    });
  });

  it('numbers the second edit of the same file 2 and names an upscale `face 4x.png`', async () => {
    const t = await setup();
    await started(t, edit(t.file.id));
    await started(t, edit(t.file.id));
    await started(t, { kind: 'upscale', fileId: t.file.id, providerId: VENICE_ID, scale: 4 });
    for (let i = 0; i < 3; i++) expect((await runNext(t)).error).toBeNull();
    expect(results(t).map((f) => f.originalName).sort()).toEqual(['face 4x.png', 'face edit 1.png', 'face edit 2.png']);
    expect(t.providers.provider.upscales).toEqual([{ image: t.images.result, scale: 4 }]);
  });

  it("places the result in the source's asset with role generated", async () => {
    const t = await setup();
    const assetId = await newAsset(t, 'Hero');
    await relocateFile(t.session, t.file.id, { assetId, role: 'reference' });
    const g = await started(t, edit(t.file.id));
    await runNext(t);
    const [result] = results(t);
    expect(result).toMatchObject({ assetId, role: 'generated' });
    expect((await generation(t, g.id)).outputs[0]!.fileId).toBe(result!.id);
  });

  it('places the result in the asset the source belongs to when the job runs', async () => {
    const t = await setup();
    const first = await newAsset(t, 'First');
    const second = await newAsset(t, 'Second');
    await relocateFile(t.session, t.file.id, { assetId: first, role: 'reference' });
    await started(t, edit(t.file.id));
    await relocateFile(t.session, t.file.id, { assetId: second, role: 'reference' });
    await runNext(t);
    expect(results(t)[0]).toMatchObject({ assetId: second, role: 'generated' });
  });

  it('leaves the result linked in the inbox when the move fails', async () => {
    const t = await setup();
    const assetId = await newAsset(t, 'Hero');
    await relocateFile(t.session, t.file.id, { assetId, role: 'reference' });
    const g = await started(t, edit(t.file.id));
    // The import moves staging -> inbox first; the next move is the relocation, which fails.
    const move = t.storage.move.bind(t.storage);
    let moves = 0;
    t.storage.move = async (from, to) => {
      if (++moves === 2) throw new Error('EBUSY');
      return move(from, to);
    };
    const { error } = await runNext(t);
    expect(error).toBeNull();
    const [result] = results(t);
    expect(result).toMatchObject({ assetId: null, role: null, status: 'complete' });
    expect(await generation(t, g.id)).toMatchObject({ status: 'succeeded', outputs: [{ fileId: result!.id }] });
  });

  it('fails file_unavailable when the content of the input changed', async () => {
    const t = await setup();
    const g = await started(t, edit(t.file.id));
    t.db.files.records.set(t.file.id, { ...t.db.files.records.get(t.file.id)!, sha256: 'f'.repeat(64) });
    expectJobError((await runNext(t)).error, 'file_unavailable');
    expect(t.providers.provider.edits).toEqual([]);
    expect(await generation(t, g.id)).toMatchObject({ status: 'failed', errorCode: 'file_unavailable', outputs: [] });
  });

  it('fails file_unavailable when the input is in the trash', async () => {
    const t = await setup();
    const g = await started(t, edit(t.file.id));
    const job = (await t.db.jobs.claimNext({ resourceClass: 'remote_api', types: [IMAGE_GENERATE_JOB], now: t.session.now().toISOString() }))!;
    await trashForTest(t.session, [t.file.id]);
    const error = await t.handler.run(job, new AbortController().signal).catch((e: unknown) => e);
    expectJobError(error, 'file_unavailable');
    expect(t.providers.provider.edits).toEqual([]);
    expect((await generation(t, g.id)).outputs).toEqual([]);
  });

  it('fails file_unavailable when no image can be read', async () => {
    const t = await setup();
    await started(t, edit(t.file.id));
    t.images.result = null;
    expectJobError((await runNext(t)).error, 'file_unavailable');
    expect(t.providers.provider.edits).toEqual([]);
  });

  it('fails provider_not_configured when the entry has no adapter', async () => {
    const t = await setup();
    const g = await started(t, edit(t.file.id));
    t.providers.entries = t.providers.entries.filter((e) => e.id !== VENICE_ID);
    expectJobError((await runNext(t)).error, 'provider_not_configured');
    expect(await generation(t, g.id)).toMatchObject({ status: 'failed', errorCode: 'provider_not_configured' });
  });

  it('fails internal_error for a generation that is missing or no longer pending', async () => {
    const t = await setup();
    const g = await started(t, edit(t.file.id));
    t.db.generations.rows[0]!.status = 'cancelled';
    expectJobError((await runNext(t)).error, 'internal_error');
    expect(t.providers.provider.edits).toEqual([]);
    expect((await generation(t, g.id)).status).toBe('cancelled');
    t.db.generations.rows.splice(0);
    await started(t, edit(t.file.id));
    t.db.generations.rows.splice(0);
    expectJobError((await runNext(t)).error, 'internal_error');
  });

  it('stores no file when the provider refuses the content', async () => {
    const t = await setup();
    const g = await started(t, edit(t.file.id));
    t.providers.provider.answer = async () => {
      throw new JobError('provider_content_refused');
    };
    expectJobError((await runNext(t)).error, 'provider_content_refused');
    expect(results(t)).toEqual([]);
    expect(await generation(t, g.id)).toMatchObject({ status: 'failed', errorCode: 'provider_content_refused', outputs: [] });
  });

  it('fails provider_outcome_unknown when the answer stream errors during the import, without an output', async () => {
    const t = await setup();
    const g = await started(t, edit(t.file.id));
    t.providers.provider.answer = async () => ({ stream: failingStream(), mimeType: 'image/png' });
    expectJobError((await runNext(t)).error, 'provider_outcome_unknown');
    // The import leaves exactly its own failed inbox row, with no binary, like any failed import.
    const left = results(t);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ originalName: 'face edit 1.png', status: 'failed', assetId: null, sha256: null });
    expect(t.storage.files.has(left[0]!.relativePath)).toBe(false);
    expect(await generation(t, g.id)).toMatchObject({ status: 'failed', errorCode: 'provider_outcome_unknown', outputs: [] });
  });

  it('stores a JPEG answer as `.jpg` with its mime type', async () => {
    const t = await setup();
    const g = await started(t, edit(t.file.id));
    t.providers.provider.answer = async () => ({ stream: Readable.from([RESULT_BYTES]), mimeType: 'image/jpeg' });
    expect((await runNext(t)).error).toBeNull();
    const [result] = results(t);
    expect(result).toMatchObject({ originalName: 'face edit 1.jpg', mimeType: 'image/jpeg', status: 'complete' });
    expect((await generation(t, g.id)).outputs).toEqual([expect.objectContaining({ fileId: result!.id, name: 'face edit 1.jpg' })]);
  });

  it('imports nothing for an answer that is not PNG, JPEG or WebP and fails provider_outcome_unknown', async () => {
    const t = await setup();
    const g = await started(t, { kind: 'upscale', fileId: t.file.id, providerId: VENICE_ID, scale: 2 });
    const stream = Readable.from([RESULT_BYTES]);
    t.providers.provider.answer = async () => ({ stream, mimeType: 'image/svg+xml' });
    expectJobError((await runNext(t)).error, 'provider_outcome_unknown');
    expect(stream.destroyed).toBe(true);
    expect(results(t)).toEqual([]);
    expect(await generation(t, g.id)).toMatchObject({ status: 'failed', errorCode: 'provider_outcome_unknown', outputs: [] });
  });

  it('fails internal_error when the import fails for a storage reason', async () => {
    const t = await setup();
    const g = await started(t, edit(t.file.id));
    t.storage.failNext('writeStream', new Error('ENOSPC'));
    expectJobError((await runNext(t)).error, 'internal_error');
    expect(await generation(t, g.id)).toMatchObject({ status: 'failed', errorCode: 'internal_error', outputs: [] });
  });

  it('a crash between import and link leaves an unlinked complete inbox file and, after recovery, provider_outcome_unknown', async () => {
    const t = await setup();
    const g = await started(t, edit(t.file.id));
    const succeed = t.db.generations.succeed.bind(t.db.generations);
    let calls = 0;
    t.db.generations.succeed = async (r) => {
      if (++calls === 1) throw new Error('SQLITE_IOERR');
      return succeed(r);
    };
    const job = (await t.db.jobs.claimNext({ resourceClass: 'remote_api', types: [IMAGE_GENERATE_JOB], now: t.session.now().toISOString() }))!;
    await expect(t.handler.run(job, new AbortController().signal)).rejects.toBeDefined();
    const [result] = results(t);
    expect(result).toMatchObject({ status: 'complete', assetId: null, relativePath: expect.stringMatching(/^inbox\//) });
    expect((await generation(t, g.id)).outputs).toEqual([]);
    // Recovery ends the running job with the handler's interrupted code.
    await t.db.jobs.finish(job.id, {
      status: 'failed',
      errorCode: t.handler.interruptedCode!,
      now: t.session.now().toISOString(),
      settled: () => t.handler.settled!(job, outcomeOf(new JobError(t.handler.interruptedCode!))),
    });
    expect(await generation(t, g.id)).toMatchObject({ status: 'failed', errorCode: 'provider_outcome_unknown', outputs: [] });
    expect(await t.db.generations.madeBy(result!.id)).toBeNull();
  });

  it('a late cancel after the result was committed leaves the generation succeeded', async () => {
    const t = await setup();
    const g = await started(t, edit(t.file.id));
    const job = (await t.db.jobs.claimNext({ resourceClass: 'remote_api', types: [IMAGE_GENERATE_JOB], now: t.session.now().toISOString() }))!;
    await t.handler.run(job, new AbortController().signal);
    await t.db.jobs.finish(job.id, {
      status: 'cancelled',
      errorCode: null,
      now: t.session.now().toISOString(),
      settled: () => t.handler.settled!(job, { status: 'cancelled' }),
    });
    const after = await generation(t, g.id);
    expect(after).toMatchObject({ status: 'succeeded', jobStatus: 'cancelled' });
    expect(after.outputs).toHaveLength(1);
  });

  it('settled ignores a job whose payload is not a generation payload', async () => {
    const t = await setup();
    const g = await started(t, edit(t.file.id));
    const job = { ...t.db.jobs.rows[0]!, payload: { v: 2 } };
    t.handler.settled!(job, { status: 'cancelled' });
    expect((await generation(t, g.id)).status).toBe('pending');
  });

  it('does not import an answer when the run was aborted before it', async () => {
    const t = await setup();
    await started(t, edit(t.file.id));
    const job = (await t.db.jobs.claimNext({ resourceClass: 'remote_api', types: [IMAGE_GENERATE_JOB], now: t.session.now().toISOString() }))!;
    const abort = new AbortController();
    t.providers.provider.answer = async () => {
      abort.abort(new Error('cancelled'));
      return { stream: Readable.from([RESULT_BYTES]), mimeType: 'image/png' };
    };
    await expect(t.handler.run(job, abort.signal)).rejects.toThrow('cancelled');
    expect(results(t)).toEqual([]);
  });
});

describe('the effects of the generation handler', () => {
  it("reports the source's asset and the inbox it passed for a result placed in it", async () => {
    const t = await setup();
    const assetId = await newAsset(t, 'Hero');
    await relocateFile(t.session, t.file.id, { assetId, role: 'reference' });
    await started(t, edit(t.file.id));
    await runNext(t);
    expect(t.effects.added).toEqual([assetId, null]);
    expect(t.effects.changed).toEqual([]);
  });

  it('reports the inbox for a source without an asset and when the move fails', async () => {
    const inbox = await setup();
    await started(inbox, edit(inbox.file.id));
    await runNext(inbox);
    expect(inbox.effects.added).toEqual([null]);

    const t = await setup();
    const assetId = await newAsset(t, 'Hero');
    await relocateFile(t.session, t.file.id, { assetId, role: 'reference' });
    await started(t, edit(t.file.id));
    const move = t.storage.move.bind(t.storage);
    let moves = 0;
    t.storage.move = async (from, to) => {
      if (++moves === 2) throw new Error('EBUSY');
      return move(from, to);
    };
    expect((await runNext(t)).error).toBeNull();
    expect(t.effects.added).toEqual([null]);
  });

  it('reports nothing when the provider refused the content', async () => {
    const t = await setup();
    await started(t, edit(t.file.id));
    t.providers.provider.answer = async () => {
      throw new JobError('provider_content_refused');
    };
    expectJobError((await runNext(t)).error, 'provider_content_refused');
    expect(t.effects.added).toEqual([]);
  });

  it('still succeeds when the report throws', async () => {
    const t = await setup();
    t.effects.throwing = true;
    const g = await started(t, edit(t.file.id));
    expect((await runNext(t)).error).toBeNull();
    expect(t.effects.added).toEqual([null]);
    expect(await generation(t, g.id)).toMatchObject({ status: 'succeeded' });
  });
});
