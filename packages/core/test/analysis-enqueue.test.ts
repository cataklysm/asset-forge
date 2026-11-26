import { describe, expect, it } from 'vitest';
import { ANALYZE_FILE_JOB, type AnalysisTarget } from '@assetforge/contracts';
import {
  ANALYSIS_PROMPT_VERSION,
  ENQUEUE_CHUNK,
  enqueueAnalysis,
  InvalidOperationError,
  previewAnalysis,
  type NewJob,
} from '../src/index.js';
import { PROVIDER, setup, T0, UNKNOWN_ID, type Setup } from './analysis-setup.js';

const MODEL = 'llava:13b';

function request(target: AnalysisTarget, patch: { mode?: 'apply' | 'propose'; force?: boolean; model?: string } = {}) {
  return { target, model: MODEL, mode: 'apply' as const, force: false, provider: PROVIDER, ...patch };
}

function analysed(c: Setup, fileId: string, model = MODEL): void {
  const rec = c.db.files.records.get(fileId)!;
  c.db.analyses.rows.set(fileId, { fileId, sha256: rec.sha256!, provider: PROVIDER, model, promptVersion: ANALYSIS_PROMPT_VERSION, analysedAt: T0 });
}

/** Records every `jobs.enqueue` call. */
function spyEnqueue(c: Setup): NewJob[][] {
  const calls: NewJob[][] = [];
  const original = c.db.jobs.enqueue.bind(c.db.jobs);
  c.db.jobs.enqueue = async (r) => {
    calls.push([...r.jobs]);
    return original(r);
  };
  return calls;
}

describe('enqueueAnalysis', () => {
  it('enqueues a v2 job per analysable file and counts the rest', async () => {
    const c = await setup();
    const queued = await c.importOne('queued.png');
    const pending = c.seedFile({ status: 'pending', sha256: null });
    const blend = await c.importOne('scene.blend');
    await enqueueAnalysis(c.session, request({ kind: 'files', fileIds: [queued.id] }));

    const result = await enqueueAnalysis(
      c.session,
      request({ kind: 'files', fileIds: [c.file.id, UNKNOWN_ID, pending.id, blend.id, queued.id] }),
    );

    expect(result).toEqual({ enqueued: 1, skipped: { notFound: 1, notAnalysable: 2, alreadyQueued: 1, alreadyAnalysed: 0 } });
    expect(c.db.jobs.rows.find((j) => j.fileId === c.file.id)).toMatchObject({
      type: ANALYZE_FILE_JOB,
      resourceClass: 'local_gpu',
      status: 'queued',
      payload: { version: 2, model: MODEL, mode: 'apply' },
      dedupeKey: `vision.analyze_file:${c.file.id}`,
    });
  });

  it('skips files analysed with the model unless forced', async () => {
    const c = await setup();
    const other = await c.importOne('other.png');
    analysed(c, c.file.id);
    analysed(c, other.id, 'another-model');
    const target: AnalysisTarget = { kind: 'files', fileIds: [c.file.id, other.id] };

    expect(await enqueueAnalysis(c.session, request(target))).toEqual({
      enqueued: 1,
      skipped: { notFound: 0, notAnalysable: 0, alreadyQueued: 0, alreadyAnalysed: 1 },
    });
    expect(c.db.jobs.rows.map((j) => j.fileId)).toEqual([other.id]);

    expect(await enqueueAnalysis(c.session, request(target, { force: true }))).toEqual({
      enqueued: 1,
      skipped: { notFound: 0, notAnalysable: 0, alreadyQueued: 1, alreadyAnalysed: 0 },
    });
    expect(c.db.jobs.rows.map((j) => j.fileId).sort()).toEqual([c.file.id, other.id].sort());
  });

  it('counts a file with a waiting proposal of the model as analysed', async () => {
    const c = await setup();
    await c.db.analyses.propose({
      fileId: c.file.id,
      sha256: c.file.sha256!,
      provider: PROVIDER,
      model: MODEL,
      promptVersion: ANALYSIS_PROMPT_VERSION,
      tags: [{ name: 'car', displayName: 'car' }],
      createdAt: T0,
    });
    const result = await enqueueAnalysis(c.session, request({ kind: 'files', fileIds: [c.file.id] }));
    expect(result.skipped.alreadyAnalysed).toBe(1);
  });

  it('proposes for one listed file, ignoring the fingerprint', async () => {
    const c = await setup();
    analysed(c, c.file.id);
    const result = await enqueueAnalysis(c.session, request({ kind: 'files', fileIds: [c.file.id] }, { mode: 'propose' }));
    expect(result).toEqual({ enqueued: 1, skipped: { notFound: 0, notAnalysable: 0, alreadyQueued: 0, alreadyAnalysed: 0 } });
    expect(c.db.jobs.rows[0]!.payload).toEqual({ version: 2, model: MODEL, mode: 'propose' });
  });

  it('refuses propose for anything but a one-file list', async () => {
    const c = await setup();
    const other = await c.importOne('other.png');
    const targets: AnalysisTarget[] = [
      { kind: 'files', fileIds: [c.file.id, other.id] },
      { kind: 'fileFilter', filter: { scope: { kind: 'all' } } },
      { kind: 'asset', assetId: UNKNOWN_ID },
      { kind: 'assetFilter', filter: {} },
    ];
    for (const target of targets) {
      await expect(enqueueAnalysis(c.session, request(target, { mode: 'propose' }))).rejects.toBeInstanceOf(InvalidOperationError);
    }
    expect(c.db.jobs.rows).toEqual([]);
  });

  it('enqueues a large filter target in chunks of at most 500', async () => {
    const c = await setup();
    for (let i = 0; i < 1200; i++) c.seedFile();
    const calls = spyEnqueue(c);

    const result = await enqueueAnalysis(c.session, request({ kind: 'fileFilter', filter: { scope: { kind: 'all' } } }));

    expect(ENQUEUE_CHUNK).toBe(500);
    expect(result).toEqual({ enqueued: 1201, skipped: { notFound: 0, notAnalysable: 0, alreadyQueued: 0, alreadyAnalysed: 0 } });
    expect(calls.map((jobs) => jobs.length)).toEqual([500, 500, 201]);
    expect(new Set(c.db.jobs.rows.map((j) => j.fileId)).size).toBe(1201);
  });

  it('enqueues the analysable files of an asset', async () => {
    const c = await setup();
    const assetId = crypto.randomUUID();
    const a = c.seedFile({ assetId, role: 'reference' });
    c.seedFile({ assetId, role: 'reference', mimeType: 'model/gltf-binary', kind: 'model' });
    c.seedFile();
    const result = await enqueueAnalysis(c.session, request({ kind: 'asset', assetId }));
    expect(result).toEqual({ enqueued: 1, skipped: { notFound: 0, notAnalysable: 1, alreadyQueued: 0, alreadyAnalysed: 0 } });
    expect(c.db.jobs.rows.map((j) => j.fileId)).toEqual([a.id]);
  });

  it('does not call enqueue when nothing is to be queued', async () => {
    const c = await setup();
    const calls = spyEnqueue(c);
    analysed(c, c.file.id);
    await enqueueAnalysis(c.session, request({ kind: 'files', fileIds: [c.file.id] }));
    expect(calls).toEqual([]);
  });
});

describe('previewAnalysis', () => {
  it('counts the target with the fingerprint of the model', async () => {
    const c = await setup();
    const queued = await c.importOne('queued.png');
    const done = await c.importOne('done.png');
    await c.importOne('scene.blend');
    await enqueueAnalysis(c.session, request({ kind: 'files', fileIds: [queued.id] }));
    analysed(c, done.id);

    expect(await previewAnalysis(c.session, { target: { kind: 'fileFilter', filter: { scope: { kind: 'all' } } }, model: MODEL, provider: PROVIDER })).toEqual({
      analysable: 1,
      alreadyAnalysed: 1,
      alreadyQueued: 1,
      notAnalysable: 1,
    });
    expect(
      (await previewAnalysis(c.session, { target: { kind: 'files', fileIds: [done.id] }, model: 'another-model', provider: PROVIDER })).analysable,
    ).toBe(1);
  });
});
