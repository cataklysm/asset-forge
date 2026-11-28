import { describe, expect, it } from 'vitest';
import type { NewJob } from '../src/jobs.js';
import type { GenerationFileRef, NewGeneration } from '../src/ports/generation-repository.js';
import { InMemoryGenerationRepository } from './memory-generations.js';
import { InMemoryJobRepository } from './memory-jobs.js';

const T0 = '2026-11-27T10:00:00.000Z';
const T1 = '2026-11-27T10:00:01.000Z';
const LATER = '2026-11-27T11:00:00.000Z';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SOURCE = id(900);
const OUTPUT = id(901);

type FileState = 'live' | 'trashed' | 'unknown';

const input: GenerationFileRef = { fileId: SOURCE, sha256: 'a'.repeat(64), originalName: 'oak.png' };
const output: GenerationFileRef = { fileId: OUTPUT, sha256: 'b'.repeat(64), originalName: 'oak edit 1.png' };

const edit = (n: number, createdAt = T0, prompt = 'Make it night'): NewGeneration => ({
  id: id(n),
  kind: 'edit',
  providerId: id(800),
  providerName: 'Venice',
  providerKind: 'venice',
  model: 'qwen-image',
  prompt,
  parameters: { v: 1, aspectRatio: null, resolution: null, safeMode: true },
  promptRef: null,
  createdAt,
});

const upscale = (n: number, createdAt = T0): NewGeneration => ({
  ...edit(n, createdAt),
  kind: 'upscale',
  model: null,
  prompt: null,
  parameters: { v: 1, scale: 2 },
});

const jobFor = (n: number): NewJob => ({
  id: id(n + 100),
  type: 'image.generate',
  resourceClass: 'remote_api',
  fileId: SOURCE,
  lane: id(800),
  payload: { v: 1, generationId: id(n) },
  dedupeKey: null,
});

function setup(files: Record<string, FileState> = {}) {
  const jobs = new InMemoryJobRepository();
  const repo = new InMemoryGenerationRepository(jobs, (fileId) => files[fileId] ?? 'live');
  return { jobs, repo };
}

async function created(n: number) {
  const s = setup();
  await s.repo.create({ generation: edit(n), input, job: jobFor(n) });
  return s;
}

describe('InMemoryGenerationRepository', () => {
  it('create stores the generation as pending with its input and job', async () => {
    const { repo, jobs } = await created(1);
    expect(await repo.get(id(1))).toMatchObject({
      id: id(1),
      status: 'pending',
      errorCode: null,
      jobId: id(101),
      jobStatus: 'queued',
      finishedAt: null,
      inputs: [{ fileId: SOURCE, name: 'oak.png', sha256: 'a'.repeat(64), trashed: false }],
      outputs: [],
    });
    expect((await jobs.get(id(101)))?.payload).toEqual({ v: 1, generationId: id(1) });
    expect((await repo.byJob(id(101)))?.id).toBe(id(1));
    expect(await repo.byJob(id(999))).toBeNull();
  });

  it('settle after succeed answers false and changes nothing', async () => {
    const { repo } = await created(1);
    expect(await repo.succeed({ id: id(1), output, now: T1 })).toBe(true);
    const before = await repo.get(id(1));
    expect(repo.settle({ id: id(1), outcome: { status: 'failed', errorCode: 'provider_timeout' }, now: LATER })).toBe(false);
    expect(await repo.get(id(1))).toEqual(before);
    expect(before).toMatchObject({ status: 'succeeded', finishedAt: T1, outputs: [{ fileId: OUTPUT, name: 'oak edit 1.png' }] });
    expect(await repo.succeed({ id: id(1), output, now: LATER })).toBe(false);
    expect((await repo.madeBy(OUTPUT))?.id).toBe(id(1));
    expect(await repo.madeBy(SOURCE)).toBeNull();
  });

  it('settle maps the outcome of a pending generation', async () => {
    const { repo } = setup();
    for (const n of [1, 2, 3]) await repo.create({ generation: edit(n), input, job: jobFor(n) });
    expect(repo.settle({ id: id(1), outcome: { status: 'failed', errorCode: 'provider_content_refused' }, now: LATER })).toBe(true);
    expect(repo.settle({ id: id(2), outcome: { status: 'cancelled' }, now: LATER })).toBe(true);
    expect(repo.settle({ id: id(3), outcome: { status: 'succeeded' }, now: LATER })).toBe(true);
    expect(await repo.get(id(1))).toMatchObject({ status: 'failed', errorCode: 'provider_content_refused', finishedAt: LATER });
    expect(await repo.get(id(2))).toMatchObject({ status: 'cancelled', errorCode: null, finishedAt: LATER });
    expect(await repo.get(id(3))).toMatchObject({ status: 'failed', errorCode: 'internal_error' });
  });

  it('requeue refuses a succeeded row and requeues a failed one with a new job', async () => {
    const { repo, jobs } = setup();
    await repo.create({ generation: edit(1), input, job: jobFor(1) });
    await repo.create({ generation: edit(2), input, job: jobFor(2) });
    await repo.succeed({ id: id(1), output, now: T1 });
    expect(await repo.requeue({ id: id(1), job: jobFor(11), now: LATER })).toBe(false);
    expect(await jobs.get(id(111))).toBeNull();
    expect(await repo.requeue({ id: id(2), job: jobFor(12), now: LATER })).toBe(false);

    repo.settle({ id: id(2), outcome: { status: 'failed', errorCode: 'provider_timeout' }, now: T1 });
    expect(await repo.requeue({ id: id(2), job: jobFor(12), now: LATER })).toBe(true);
    expect(await repo.get(id(2))).toMatchObject({
      status: 'pending',
      errorCode: null,
      finishedAt: null,
      jobId: id(112),
      jobStatus: 'queued',
    });
  });

  it('remove refuses pending and removes a cancelled generation', async () => {
    const { repo } = await created(1);
    expect(await repo.remove(id(1))).toBe(false);
    repo.settle({ id: id(1), outcome: { status: 'cancelled' }, now: T1 });
    expect(await repo.remove(id(1))).toBe(true);
    expect(await repo.get(id(1))).toBeNull();
    expect(await repo.remove(id(1))).toBe(false);
  });

  it('editRank orders the edits of one input by createdAt, then id', async () => {
    const { repo } = setup();
    await repo.create({ generation: edit(3, T0), input, job: jobFor(3) });
    await repo.create({ generation: edit(2, T1), input, job: jobFor(2) });
    await repo.create({ generation: edit(1, T0), input, job: jobFor(1) });
    await repo.create({ generation: upscale(4, T0), input, job: jobFor(4) });
    await repo.create({ generation: edit(5, T0), input: { ...input, fileId: id(950) }, job: jobFor(5) });
    expect(await repo.editRank(id(1))).toBe(1);
    expect(await repo.editRank(id(3))).toBe(2);
    expect(await repo.editRank(id(2))).toBe(3);
    expect(await repo.editRank(id(5))).toBe(1);
  });

  it('resultsOf answers the generations of an input, newest first, limited', async () => {
    const { repo } = setup();
    await repo.create({ generation: edit(1, T0), input, job: jobFor(1) });
    await repo.create({ generation: edit(2, T1), input, job: jobFor(2) });
    await repo.create({ generation: edit(3, LATER), input, job: jobFor(3) });
    expect((await repo.resultsOf(SOURCE, 2)).map((g) => g.id)).toEqual([id(3), id(2)]);
    expect(await repo.resultsOf(id(950), 10)).toEqual([]);
  });

  it('inputs and outputs show a trashed and a purged file', async () => {
    const files: Record<string, FileState> = {};
    const { repo } = setup(files);
    await repo.create({ generation: edit(1), input, job: jobFor(1) });
    await repo.succeed({ id: id(1), output, now: T1 });
    files[SOURCE] = 'trashed';
    files[OUTPUT] = 'unknown';
    const g = await repo.get(id(1));
    expect(g?.inputs[0]).toMatchObject({ fileId: SOURCE, trashed: true });
    expect(g?.outputs[0]).toMatchObject({ fileId: null, name: 'oak edit 1.png', trashed: false });
  });

  it('recentPrompts answers distinct edit prompts, newest use first', async () => {
    const { repo } = setup();
    await repo.create({ generation: edit(1, T0, 'first'), input, job: jobFor(1) });
    await repo.create({ generation: edit(2, T1, 'second'), input, job: jobFor(2) });
    await repo.create({ generation: edit(3, LATER, 'first'), input, job: jobFor(3) });
    await repo.create({ generation: upscale(4, LATER), input, job: jobFor(4) });
    expect(await repo.recentPrompts(20)).toEqual(['first', 'second']);
    expect(await repo.recentPrompts(1)).toEqual(['first']);
  });

  it('a settle in a throwing settled callback rolls back with the job end, as one transaction', async () => {
    const { repo, jobs } = setup();
    for (const n of [1, 2]) await repo.create({ generation: edit(n), input, job: jobFor(n) });
    await jobs.claimNext({ resourceClass: 'remote_api', types: ['image.generate'], now: T1 });
    const settleThenThrow = (n: number) => () => {
      repo.settle({ id: id(n), outcome: { status: 'cancelled' }, now: LATER });
      throw new Error('boom');
    };

    await expect(jobs.finish(id(101), { status: 'cancelled', errorCode: null, now: LATER, settled: settleThenThrow(1) })).rejects.toThrow('boom');
    await expect(jobs.cancelPending({ now: LATER, settled: settleThenThrow(2) })).rejects.toThrow('boom');

    expect(await repo.get(id(1))).toMatchObject({ status: 'pending', finishedAt: null, jobStatus: 'running' });
    expect(await repo.get(id(2))).toMatchObject({ status: 'pending', finishedAt: null, jobStatus: 'queued' });
  });

  it('reconcile takes the finished job outcome, and provider_outcome_unknown for a missing job', async () => {
    const { repo, jobs } = setup();
    for (const n of [1, 2, 3, 4, 5]) await repo.create({ generation: edit(n), input, job: jobFor(n) });
    const jobRow = (n: number) => jobs.rows.find((r) => r.id === id(n + 100))!;
    Object.assign(jobRow(1), { status: 'failed', errorCode: 'provider_content_refused' });
    Object.assign(jobRow(2), { status: 'cancelled' });
    Object.assign(jobRow(3), { status: 'succeeded' });
    jobs.rows.splice(jobs.rows.indexOf(jobRow(4)), 1);
    // Generation 5 keeps its queued job and stays pending.

    expect(await repo.reconcile(LATER)).toBe(4);
    expect(await repo.get(id(1))).toMatchObject({ status: 'failed', errorCode: 'provider_content_refused', finishedAt: LATER });
    expect(await repo.get(id(2))).toMatchObject({ status: 'cancelled', errorCode: null });
    expect(await repo.get(id(3))).toMatchObject({ status: 'failed', errorCode: 'internal_error' });
    expect(await repo.get(id(4))).toMatchObject({ status: 'failed', errorCode: 'provider_outcome_unknown', jobStatus: null });
    expect(await repo.get(id(5))).toMatchObject({ status: 'pending', jobStatus: 'queued' });
    expect(await repo.reconcile(LATER)).toBe(0);
  });
});
