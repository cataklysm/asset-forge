import { describe, expect, it, vi } from 'vitest';
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
    promptName: 'Detail',
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
    await enqueueAnalysis(c.session, {
      target: { kind: 'files', fileIds: [c.file.id] },
      model: MODEL,
      mode: 'propose',
      force: true,
      provider: PROVIDER,
      prompt: { name: 'Detail', text: 'T', maxTags: 15 },
      entry: { id: 'environment', name: 'Environment' },
    });
    const jobId = c.db.jobs.rows[0]!.id;

    expect(await getProposal(c.session, c.file.id)).toEqual({
      proposal: {
        model: MODEL,
        promptName: 'Detail',
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
        providerId: 'environment',
        providerName: 'Environment',
        model: MODEL,
        url: null,
        host: null,
        result: null,
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
      lane: null,
      dedupeKey: null,
    });
    await c.db.jobs.enqueue({ jobs: [newJob('job-a')], now: '2026-03-01T00:00:00.000Z' });
    await c.db.jobs.claimNext({
      resourceClass: 'remote_api',
      types: [ANALYZE_FILE_JOB],
      now: '2026-03-01T00:00:01.000Z',
    });
    await c.db.jobs.finish('job-a', {
      status: 'failed',
      errorCode: 'provider_unavailable',
      now: '2026-03-01T00:00:02.000Z',
    });
    await c.db.jobs.enqueue({ jobs: [newJob('job-b')], now: '2026-03-02T00:00:00.000Z' });
    await c.db.jobs.claimNext({
      resourceClass: 'remote_api',
      types: [ANALYZE_FILE_JOB],
      now: '2026-03-02T00:00:01.000Z',
    });
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

  it('marks a proposal of a file that is no longer complete stale, like the SQLite reader', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    c.db.files.records.set(c.file.id, { ...c.db.files.records.get(c.file.id)!, status: 'failed' });
    expect((await getProposal(c.session, c.file.id)).proposal?.stale).toBe(true);
  });
});

describe('acceptProposal', () => {
  it('applies the chosen subset, compared normalised, and records the analysis', async () => {
    const c = await setup();
    await addFileTag(c.session, { fileId: c.file.id, name: 'metal' });
    await proposeFor(c, c.file.id);

    await acceptProposal(c.session, { fileId: c.file.id, createdAt: CREATED, names: ['  RED   car ', 'metal'] });

    expect(c.db.tags.forFile(c.file.id)).toEqual([
      { name: 'metal', displayName: 'metal', origin: 'manual' },
      { name: 'red car', displayName: 'Red Car', origin: 'ai' },
    ]);
    expect(await c.db.analyses.get(c.file.id)).toMatchObject({
      sha256: c.file.sha256,
      provider: PROVIDER,
      model: MODEL,
      promptVersion: ANALYSIS_PROMPT_VERSION,
    });
    expect(await c.db.analyses.getProposal(c.file.id)).toBeNull();
    expect((await c.db.files.get(c.file.id))!.hasProposal).toBe(false);
  });

  it('answers not_found without a proposal', async () => {
    const c = await setup();
    await expect(
      acceptProposal(c.session, { fileId: c.file.id, createdAt: CREATED, names: ['metal'] }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses with no names or with a name not in the proposal', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    await rejectsInvalid(acceptProposal(c.session, { fileId: c.file.id, createdAt: CREATED, names: [] }));
    await rejectsInvalid(
      acceptProposal(c.session, { fileId: c.file.id, createdAt: CREATED, names: ['metal', 'wood'] }),
    );
    await rejectsInvalid(acceptProposal(c.session, { fileId: c.file.id, createdAt: CREATED, names: ['!!!'] }));
    expect(c.db.tags.forFile(c.file.id)).toEqual([]);
    expect(await c.db.analyses.getProposal(c.file.id)).not.toBeNull();
  });

  it('refuses and drops a stale proposal', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    c.db.files.records.set(c.file.id, { ...c.db.files.records.get(c.file.id)!, sha256: 'f'.repeat(64) });
    await rejectsInvalid(acceptProposal(c.session, { fileId: c.file.id, createdAt: CREATED, names: ['metal'] }));
    expect(c.db.tags.forFile(c.file.id)).toEqual([]);
    expect(await c.db.analyses.getProposal(c.file.id)).toBeNull();
  });

  it('drops a stale proposal before checking the names', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    c.db.files.records.set(c.file.id, { ...c.db.files.records.get(c.file.id)!, sha256: 'f'.repeat(64) });
    await rejectsInvalid(acceptProposal(c.session, { fileId: c.file.id, createdAt: CREATED, names: ['wood'] }));
    expect(c.db.tags.forFile(c.file.id)).toEqual([]);
    expect(await c.db.analyses.getProposal(c.file.id)).toBeNull();
  });

  it('refuses when the repository does not accept', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    c.db.analyses.acceptProposal = async () => 'stale';
    await rejectsInvalid(acceptProposal(c.session, { fileId: c.file.id, createdAt: CREATED, names: ['metal'] }));
  });

  it('maps each answer of the one repository transaction to its error', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    const answerWith = async (outcome: 'missing' | 'trashed' | 'stale') => {
      c.db.analyses.acceptProposal = async () => outcome;
      return acceptProposal(c.session, { fileId: c.file.id, createdAt: CREATED, names: ['metal'] }).catch(
        (e: unknown) => e as Error,
      );
    };
    const missing = await answerWith('missing');
    expect(missing).toBeInstanceOf(NotFoundError);
    expect(missing?.message).toBe('The file has no tag proposal');
    expect((await answerWith('trashed'))?.message).toBe('The file is in the trash');
    expect((await answerWith('stale'))?.message).toBe('The tag proposal is out of date');
  });

  it('reads no file record: the trash is checked inside the repository transaction', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    const get = vi.spyOn(c.db.files, 'get');
    await acceptProposal(c.session, { fileId: c.file.id, createdAt: CREATED, names: ['metal'] });
    expect(get).not.toHaveBeenCalled();
  });

  it('refuses a proposal other than the one the caller saw and keeps the stored one', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    const error = await acceptProposal(c.session, {
      fileId: c.file.id,
      createdAt: '2026-02-01T00:00:00.000Z',
      names: ['metal'],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidOperationError);
    expect((error as Error).message).toBe('The tag proposal is out of date');
    expect(await c.db.analyses.getProposal(c.file.id)).toMatchObject({ createdAt: CREATED });
    expect(c.db.tags.forFile(c.file.id)).toEqual([]);
  });

  it('answers out of date rather than a foreign choice when the caller saw another proposal', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    const error = await acceptProposal(c.session, {
      fileId: c.file.id,
      createdAt: '2026-02-01T00:00:00.000Z',
      names: ['wood'],
    }).catch((e: unknown) => e);
    expect((error as Error).message).toBe('The tag proposal is out of date');
  });

  it('keeps a stale proposal the caller did not see', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    c.db.files.records.set(c.file.id, { ...c.db.files.records.get(c.file.id)!, sha256: 'f'.repeat(64) });
    await rejectsInvalid(
      acceptProposal(c.session, { fileId: c.file.id, createdAt: '2026-02-01T00:00:00.000Z', names: ['metal'] }),
    );
    expect(await c.db.analyses.getProposal(c.file.id)).toMatchObject({ createdAt: CREATED, stale: true });
  });

  it('hands the time of the proposal the caller saw to the repository transaction', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    const accept = vi.spyOn(c.db.analyses, 'acceptProposal');
    await acceptProposal(c.session, { fileId: c.file.id, createdAt: CREATED, names: ['metal'] });
    expect(accept.mock.calls[0]![0]).toMatchObject({ createdAt: CREATED });
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
    const error = await acceptProposal(c.session, { fileId: c.file.id, createdAt: CREATED, names: ['metal'] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InvalidOperationError);
    expect((error as Error).message).toBe('The file is in the trash');
    expect(await c.db.analyses.getProposal(c.file.id)).not.toBeNull();
    expect(c.db.tags.forFile(c.file.id)).toEqual([]);
  });

  it('acceptProposal checks the trash before the stale branch, so a stale proposal of a trashed file stays', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    await trashForTest(c.session, [c.file.id]);
    c.db.files.records.set(c.file.id, { ...c.db.files.records.get(c.file.id)!, sha256: 'f'.repeat(64) });
    const error = await acceptProposal(c.session, { fileId: c.file.id, createdAt: CREATED, names: ['metal'] }).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toBe('The file is in the trash');
    expect(await c.db.analyses.getProposal(c.file.id)).toMatchObject({ stale: true });
  });

  it('acceptProposal answers the trash refusal before an empty or a foreign choice', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    await trashForTest(c.session, [c.file.id]);
    for (const names of [[], ['not-proposed']]) {
      const error = await acceptProposal(c.session, { fileId: c.file.id, createdAt: CREATED, names }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(InvalidOperationError);
      expect((error as Error).message).toBe('The file is in the trash');
    }
    expect(await c.db.analyses.getProposal(c.file.id)).not.toBeNull();
    expect(c.db.tags.forFile(c.file.id)).toEqual([]);
  });

  it('discardProposal refuses a trashed file and keeps its proposal for a restore', async () => {
    const c = await setup();
    await proposeFor(c, c.file.id);
    await trashForTest(c.session, [c.file.id]);
    const error = await discardProposal(c.session, c.file.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidOperationError);
    expect((error as Error).message).toBe('The file is in the trash');
    expect(await c.db.analyses.getProposal(c.file.id)).not.toBeNull();
  });
});
