import { describe, expect, it } from 'vitest';
import { ANALYZE_FILE_JOB } from '@assetforge/contracts';
import {
  acceptProposal,
  addFileTag,
  ANALYSIS_PROMPT_VERSION,
  discardProposal,
  enqueueAnalysis,
  getProposal,
  InvalidOperationError,
  NotFoundError,
} from '../src/index.js';
import { PROVIDER, setup, type Setup } from './analysis-setup.js';
import { trashForTest } from './fakes.js';

const MODEL = 'llava:13b';
const CREATED = '2026-02-02T00:00:00.000Z';

async function proposeFor(c: Setup, fileId: string): Promise<void> {
  const sha256 = c.db.files.records.get(fileId)!.sha256!;
  await c.db.analyses.propose({
    fileId,
    sha256,
    provider: PROVIDER,
    model: MODEL,
    promptVersion: ANALYSIS_PROMPT_VERSION,
    tags: [
      { name: 'red car', displayName: 'Red Car' },
      { name: 'metal', displayName: 'metal' },
      { name: 'front view', displayName: 'front view' },
    ],
    createdAt: CREATED,
  });
}

async function rejectsInvalid(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(InvalidOperationError);
}

describe('getProposal', () => {
  it('returns null for both without a proposal or a job', async () => {
    const c = await setup();
    expect(await getProposal(c.session, c.file.id)).toEqual({ proposal: null, job: null });
  });

  it('returns the proposal view and the latest analysis job', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    await enqueueAnalysis(c.session, { target: { kind: 'files', fileIds: [c.file.id] }, model: MODEL, mode: 'propose', force: true, provider: PROVIDER });
    const jobId = c.db.jobs.rows[0]!.id;

    expect(await getProposal(c.session, c.file.id)).toEqual({
      proposal: {
        model: MODEL,
        createdAt: CREATED,
        stale: false,
        tags: [
          { name: 'red car', displayName: 'Red Car' },
          { name: 'metal', displayName: 'metal' },
          { name: 'front view', displayName: 'front view' },
        ],
      },
      job: {
        id: jobId,
        type: ANALYZE_FILE_JOB,
        status: 'queued',
        attempt: 0,
        fileId: c.file.id,
        fileName: 'car.png',
        errorCode: null,
        errorMessage: null,
        createdAt: expect.any(String),
        startedAt: null,
        finishedAt: null,
        runAfter: null,
      },
    });
  });

  it('prefers an active older job over a newer finished one', async () => {
    const c = await setup();
    const newJob = (id: string) => ({
      id,
      type: ANALYZE_FILE_JOB,
      resourceClass: 'remote_api' as const,
      payload: {},
      fileId: c.file.id,
      dedupeKey: null,
    });
    await c.db.jobs.enqueue({ jobs: [newJob('job-a')], now: '2026-03-01T00:00:00.000Z' });
    await c.db.jobs.claimNext({ resourceClass: 'remote_api', types: [ANALYZE_FILE_JOB], now: '2026-03-01T00:00:01.000Z' });
    await c.db.jobs.finish('job-a', { status: 'failed', errorCode: 'provider_unavailable', now: '2026-03-01T00:00:02.000Z' });
    await c.db.jobs.enqueue({ jobs: [newJob('job-b')], now: '2026-03-02T00:00:00.000Z' });
    await c.db.jobs.claimNext({ resourceClass: 'remote_api', types: [ANALYZE_FILE_JOB], now: '2026-03-02T00:00:01.000Z' });
    await c.db.jobs.finish('job-b', { status: 'succeeded', errorCode: null, now: '2026-03-02T00:00:02.000Z' });
    expect((await getProposal(c.session, c.file.id)).job?.id).toBe('job-b');

    await c.db.jobs.retry({ id: 'job-a', now: '2026-03-03T00:00:00.000Z' });
    expect((await getProposal(c.session, c.file.id)).job).toMatchObject({ id: 'job-a', status: 'queued' });
  });

  it('marks a proposal of changed content stale', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    c.db.files.records.set(c.file.id, { ...c.db.files.records.get(c.file.id)!, sha256: 'f'.repeat(64) });
    expect((await getProposal(c.session, c.file.id)).proposal?.stale).toBe(true);
  });
});

describe('acceptProposal', () => {
  it('applies the chosen subset, compared normalised, and records the analysis', async () => {
    const c = await setup();
    await addFileTag(c.session, { fileId: c.file.id, name: 'metal' });
    await proposeFor(c, c.file.id);

    await acceptProposal(c.session, { fileId: c.file.id, names: ['  RED   car ', 'metal'] });

    expect(c.db.tags.forFile(c.file.id)).toEqual([
      { name: 'metal', displayName: 'metal', origin: 'manual' },
      { name: 'red car', displayName: 'Red Car', origin: 'ai' },
    ]);
    expect(await c.db.analyses.get(c.file.id)).toMatchObject({ sha256: c.file.sha256, provider: PROVIDER, model: MODEL, promptVersion: ANALYSIS_PROMPT_VERSION });
    expect(await c.db.analyses.getProposal(c.file.id)).toBeNull();
    expect((await c.db.files.get(c.file.id))!.hasProposal).toBe(false);
  });

  it('answers not_found without a proposal', async () => {
    const c = await setup();
    await expect(acceptProposal(c.session, { fileId: c.file.id, names: ['metal'] })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses with no names or with a name not in the proposal', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    await rejectsInvalid(acceptProposal(c.session, { fileId: c.file.id, names: [] }));
    await rejectsInvalid(acceptProposal(c.session, { fileId: c.file.id, names: ['metal', 'wood'] }));
    await rejectsInvalid(acceptProposal(c.session, { fileId: c.file.id, names: ['!!!'] }));
    expect(c.db.tags.forFile(c.file.id)).toEqual([]);
    expect(await c.db.analyses.getProposal(c.file.id)).not.toBeNull();
  });

  it('refuses and drops a stale proposal', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    c.db.files.records.set(c.file.id, { ...c.db.files.records.get(c.file.id)!, sha256: 'f'.repeat(64) });
    await rejectsInvalid(acceptProposal(c.session, { fileId: c.file.id, names: ['metal'] }));
    expect(c.db.tags.forFile(c.file.id)).toEqual([]);
    expect(await c.db.analyses.getProposal(c.file.id)).toBeNull();
  });

  it('drops a stale proposal before checking the names', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    c.db.files.records.set(c.file.id, { ...c.db.files.records.get(c.file.id)!, sha256: 'f'.repeat(64) });
    await rejectsInvalid(acceptProposal(c.session, { fileId: c.file.id, names: ['wood'] }));
    expect(c.db.tags.forFile(c.file.id)).toEqual([]);
    expect(await c.db.analyses.getProposal(c.file.id)).toBeNull();
  });

  it('refuses when the repository does not accept', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    c.db.analyses.acceptProposal = async () => false;
    await rejectsInvalid(acceptProposal(c.session, { fileId: c.file.id, names: ['metal'] }));
  });
});

describe('discardProposal', () => {
  it('deletes the proposal and is idempotent', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    expect((await c.db.files.get(c.file.id))!.hasProposal).toBe(true);
    await discardProposal(c.session, c.file.id);
    await discardProposal(c.session, c.file.id);
    expect(await c.db.analyses.getProposal(c.file.id)).toBeNull();
    expect(c.db.tags.forFile(c.file.id)).toEqual([]);
  });
});

describe('trashed files', () => {
  it('acceptProposal refuses a trashed file and keeps its proposal', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    await trashForTest(c.session, [c.file.id]);
    const error = await acceptProposal(c.session, { fileId: c.file.id, names: ['metal'] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidOperationError);
    expect((error as Error).message).toBe('The file is in the trash');
    expect(await c.db.analyses.getProposal(c.file.id)).not.toBeNull();
    expect(c.db.tags.forFile(c.file.id)).toEqual([]);
  });
});
