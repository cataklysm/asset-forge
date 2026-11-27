import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { IMAGE_GENERATE_JOB } from '@assetforge/contracts';
import type { GenerationFileRef, NewGeneration, NewJob, WorkspaceDatabase } from '@assetforge/core';
import { MIGRATIONS_FOLDER, openWorkspaceDatabase } from '../src/index.js';

const T0 = '2026-11-27T10:00:00.000Z';
const T1 = '2026-11-27T10:00:01.000Z';
const T2 = '2026-11-27T10:00:02.000Z';
const T3 = '2026-11-27T10:00:03.000Z';
const LATER = '2026-11-27T11:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STORAGE_ID = uuid(1);
const SOURCE = uuid(900);
const OUTPUT = uuid(901);
const PROVIDER = uuid(800);

const input: GenerationFileRef = { fileId: SOURCE, sha256: 'a'.repeat(64), originalName: 'oak.png' };
const output: GenerationFileRef = { fileId: OUTPUT, sha256: 'b'.repeat(64), originalName: 'oak edit 1.png' };

const edit = (n: number, createdAt = T0, prompt = 'Make it night'): NewGeneration => ({
  id: uuid(n),
  kind: 'edit',
  providerId: PROVIDER,
  providerName: 'Venice',
  providerKind: 'venice',
  model: 'qwen-image',
  prompt,
  parameters: { v: 1, aspectRatio: null, resolution: null, safeMode: true },
  createdAt,
});

const upscale = (n: number, createdAt = T0): NewGeneration => ({
  ...edit(n, createdAt),
  kind: 'upscale',
  model: null,
  prompt: null,
  parameters: { v: 1, scale: 2 },
});

/** The job of generation n has id uuid(n + 100); `run` shifts it for a requeue. */
const jobFor = (n: number, run = 0): NewJob => ({
  id: uuid(n + 100 + run * 1000),
  type: IMAGE_GENERATE_JOB,
  resourceClass: 'remote_api',
  fileId: SOURCE,
  lane: PROVIDER,
  payload: { v: 1, generationId: uuid(n) },
  dedupeKey: null,
});

let dir: string;
let db: WorkspaceDatabase;
let handle: Database.Database;

async function addFile(id: string, name: string, sha256: string): Promise<void> {
  await db.files.insertPending({
    id,
    storageId: STORAGE_ID,
    originalName: name,
    relativePath: `inbox/${id}/${name}`,
    mimeType: 'image/png',
    importedAt: T0,
    kind: 'image',
  });
  await db.files.markComplete(id, { sizeBytes: 1, sha256, width: null, height: null });
}

/** Moves a file to the trash through a committed `trash` move. */
async function trash(id: string): Promise<void> {
  await db.fileMoves.begin({
    fileId: id,
    kind: 'trash',
    targetRelativePath: `.assetforge/trash/${id}_x.png`,
    targetAssetId: null,
    targetRole: null,
    createdAt: T1,
  });
  await db.fileMoves.commit(id);
}

/** Trashes and purges a file. */
async function purge(id: string): Promise<void> {
  await trash(id);
  expect(await db.files.purge(id)).toBe(true);
}

const create = (generation: NewGeneration, job = jobFor(Number(generation.id.slice(-12)))) =>
  db.generations.create({ generation, input, job });

/** Claims the oldest `remote_api` generation job. */
const claim = (now = T1) => db.jobs.claimNext({ resourceClass: 'remote_api', types: [IMAGE_GENERATE_JOB], now });

const count = (table: string, generationId: string) =>
  (handle.prepare(`select count(*) as n from ${table} where generation_id = ?`).get(generationId) as { n: number }).n;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-gen-'));
  const pragma = vi.spyOn(Database.prototype, 'pragma');
  try {
    db = await openWorkspaceDatabase(join(dir, 'ws.db'), MIGRATIONS_FOLDER);
    handle = pragma.mock.contexts[0] as Database.Database;
  } finally {
    pragma.mockRestore();
  }
  await db.storages.ensurePrimary({ id: STORAGE_ID, createdAt: T0 });
  await addFile(SOURCE, 'oak.png', 'a'.repeat(64));
  await addFile(OUTPUT, 'oak edit 1.png', 'b'.repeat(64));
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('generation repository', () => {
  test('create writes the generation as pending with its input and job', async () => {
    await create(edit(1));
    expect(await db.generations.get(uuid(1))).toEqual({
      id: uuid(1),
      kind: 'edit',
      status: 'pending',
      errorCode: null,
      providerId: PROVIDER,
      providerName: 'Venice',
      providerKind: 'venice',
      model: 'qwen-image',
      prompt: 'Make it night',
      parameters: { v: 1, aspectRatio: null, resolution: null, safeMode: true },
      jobId: uuid(101),
      jobStatus: 'queued',
      createdAt: T0,
      finishedAt: null,
      inputs: [{ fileId: SOURCE, name: 'oak.png', sha256: 'a'.repeat(64), trashed: false }],
      outputs: [],
    });
    expect(await db.jobs.get(uuid(101))).toMatchObject({
      status: 'queued',
      type: IMAGE_GENERATE_JOB,
      fileId: SOURCE,
      lane: PROVIDER,
      payload: { v: 1, generationId: uuid(1) },
      createdAt: T0,
    });
    expect((await db.generations.byJob(uuid(101)))?.id).toBe(uuid(1));
    expect(await db.generations.byJob(uuid(999))).toBeNull();
    expect(await db.generations.get(uuid(999))).toBeNull();
  });

  test('a duplicate job id leaves no generation and no input row', async () => {
    await db.jobs.enqueue({ jobs: [jobFor(2)], now: T0 });
    await expect(create(edit(1), jobFor(2))).rejects.toThrow();
    expect(await db.generations.get(uuid(1))).toBeNull();
    expect(count('generation_input', uuid(1))).toBe(0);
  });

  test('a job of a trashed source leaves no generation', async () => {
    await trash(SOURCE);
    await expect(create(edit(1))).rejects.toThrow();
    expect(await db.generations.get(uuid(1))).toBeNull();
    expect(await db.jobs.get(uuid(101))).toBeNull();
  });

  test('succeed writes the output and a later settle cancelled changes nothing', async () => {
    await create(edit(1));
    expect(await db.generations.succeed({ id: uuid(1), output, now: T2 })).toBe(true);
    expect(db.generations.settle({ id: uuid(1), outcome: { status: 'cancelled' }, now: T3 })).toBe(false);
    expect(await db.generations.get(uuid(1))).toMatchObject({
      status: 'succeeded',
      errorCode: null,
      finishedAt: T2,
      outputs: [{ fileId: OUTPUT, name: 'oak edit 1.png', sha256: 'b'.repeat(64), trashed: false }],
    });
    expect(await db.generations.succeed({ id: uuid(1), output, now: T3 })).toBe(false);
    expect(count('generation_output', uuid(1))).toBe(1);
  });

  test('settle sets the code for failed, clears it for cancelled and turns succeeded into internal_error', async () => {
    await create(edit(1));
    await create(edit(2));
    await create(edit(3));
    expect(db.generations.settle({ id: uuid(1), outcome: { status: 'failed', errorCode: 'provider_rejected' }, now: T2 })).toBe(true);
    expect(db.generations.settle({ id: uuid(2), outcome: { status: 'cancelled' }, now: T2 })).toBe(true);
    expect(db.generations.settle({ id: uuid(3), outcome: { status: 'succeeded' }, now: T2 })).toBe(true);
    expect(db.generations.settle({ id: uuid(1), outcome: { status: 'cancelled' }, now: T3 })).toBe(false);
    expect(db.generations.settle({ id: uuid(99), outcome: { status: 'cancelled' }, now: T3 })).toBe(false);
    expect(await db.generations.get(uuid(1))).toMatchObject({ status: 'failed', errorCode: 'provider_rejected', finishedAt: T2 });
    expect(await db.generations.get(uuid(2))).toMatchObject({ status: 'cancelled', errorCode: null, finishedAt: T2 });
    expect(await db.generations.get(uuid(3))).toMatchObject({ status: 'failed', errorCode: 'internal_error', finishedAt: T2 });
  });

  test('a settle inside jobs.finish ends the generation with the job', async () => {
    await create(edit(1));
    expect((await claim())?.id).toBe(uuid(101));
    const settled = () => {
      db.generations.settle({ id: uuid(1), outcome: { status: 'failed', errorCode: 'provider_timeout' }, now: T2 });
    };
    expect(await db.jobs.finish(uuid(101), { status: 'failed', errorCode: 'provider_timeout', now: T2, settled })).toBe(true);
    expect(await db.generations.get(uuid(1))).toMatchObject({ status: 'failed', errorCode: 'provider_timeout', jobStatus: 'failed' });
  });

  test('a settle that throws inside jobs.finish rolls the job back to running and the generation to pending', async () => {
    await create(edit(1));
    expect((await claim())?.id).toBe(uuid(101));
    const settled = () => {
      db.generations.settle({ id: uuid(1), outcome: { status: 'cancelled' }, now: T2 });
      throw new Error('boom');
    };
    await expect(db.jobs.finish(uuid(101), { status: 'cancelled', errorCode: null, now: T2, settled })).rejects.toThrow('boom');
    expect(await db.jobs.get(uuid(101))).toMatchObject({ status: 'running', finishedAt: null });
    expect(await db.generations.get(uuid(1))).toMatchObject({ status: 'pending', finishedAt: null, jobStatus: 'running' });
  });

  test('cancelPending with settled cancels the job and its generation in one transaction', async () => {
    await create(edit(1));
    await create(edit(2));
    const seen: string[] = [];
    const n = await db.jobs.cancelPending({
      id: uuid(101),
      now: T2,
      settled: (job) => {
        seen.push(job.id);
        db.generations.settle({ id: uuid(1), outcome: { status: 'cancelled' }, now: T2 });
      },
    });
    expect(n).toBe(1);
    expect(seen).toEqual([uuid(101)]);
    expect(await db.generations.get(uuid(1))).toMatchObject({ status: 'cancelled', jobStatus: 'cancelled', finishedAt: T2 });
    expect(await db.generations.get(uuid(2))).toMatchObject({ status: 'pending', jobStatus: 'queued' });
  });

  test('purging the result file leaves the output with fileId null, its name and its sha', async () => {
    await create(edit(1));
    await db.generations.succeed({ id: uuid(1), output, now: T2 });
    await purge(OUTPUT);
    expect((await db.generations.get(uuid(1)))?.outputs).toEqual([
      { fileId: null, name: 'oak edit 1.png', sha256: 'b'.repeat(64), trashed: false },
    ]);
    expect(await db.generations.madeBy(OUTPUT)).toBeNull();
  });

  test('purging the source deletes its job rows, keeps the input row, and reconcile fails the generation as unknown', async () => {
    await create(edit(1));
    await purge(SOURCE);
    expect(await db.jobs.get(uuid(101))).toBeNull();
    expect(await db.generations.get(uuid(1))).toMatchObject({
      status: 'pending',
      jobId: uuid(101),
      jobStatus: null,
      inputs: [{ fileId: null, name: 'oak.png', sha256: 'a'.repeat(64), trashed: false }],
    });
    expect(await db.generations.reconcile(LATER)).toBe(1);
    expect(await db.generations.get(uuid(1))).toMatchObject({
      status: 'failed',
      errorCode: 'provider_outcome_unknown',
      finishedAt: LATER,
    });
    expect(await db.generations.reconcile(LATER)).toBe(0);
  });

  test('reconcile takes the outcome of a finished job and leaves an active one', async () => {
    for (const n of [1, 2, 3, 4]) await create(edit(n, `2026-11-27T10:00:0${n}.000Z`));
    expect((await claim())?.id).toBe(uuid(101));
    await db.jobs.finish(uuid(101), { status: 'failed', errorCode: 'provider_rejected', now: T2 });
    expect((await claim())?.id).toBe(uuid(102));
    await db.jobs.finish(uuid(102), { status: 'succeeded', errorCode: null, now: T2 });
    await db.jobs.cancelPending({ id: uuid(103), now: T2 });
    expect(await db.generations.reconcile(LATER)).toBe(3);
    expect(await db.generations.get(uuid(1))).toMatchObject({ status: 'failed', errorCode: 'provider_rejected' });
    expect(await db.generations.get(uuid(2))).toMatchObject({ status: 'failed', errorCode: 'internal_error' });
    expect(await db.generations.get(uuid(3))).toMatchObject({ status: 'cancelled', errorCode: null });
    expect(await db.generations.get(uuid(4))).toMatchObject({ status: 'pending', jobStatus: 'queued' });
  });

  test('trashing the source marks the input trashed', async () => {
    await create(edit(1));
    await trash(SOURCE);
    expect((await db.generations.get(uuid(1)))?.inputs).toEqual([
      { fileId: SOURCE, name: 'oak.png', sha256: 'a'.repeat(64), trashed: true },
    ]);
  });

  test('resultsOf is newest first by created_at, then id, and capped at its limit; madeBy answers the generation of an output', async () => {
    await create(edit(1, T0));
    await create(edit(2, T2));
    await create(edit(3, T1));
    await create(edit(4, T2));
    expect((await db.generations.resultsOf(SOURCE, 10)).map((g) => g.id)).toEqual([uuid(4), uuid(2), uuid(3), uuid(1)]);
    expect((await db.generations.resultsOf(SOURCE, 2)).map((g) => g.id)).toEqual([uuid(4), uuid(2)]);
    expect(await db.generations.resultsOf(OUTPUT, 10)).toEqual([]);
    await db.generations.succeed({ id: uuid(3), output, now: T3 });
    expect((await db.generations.madeBy(OUTPUT))?.id).toBe(uuid(3));
    expect(await db.generations.madeBy(SOURCE)).toBeNull();
  });

  test('editRank counts the edits of the input file by created_at, then id', async () => {
    await create(edit(2, T1));
    await create(edit(1, T1));
    await create(upscale(3, T0));
    await create(edit(4, T0));
    expect(await db.generations.editRank(uuid(4))).toBe(1);
    expect(await db.generations.editRank(uuid(1))).toBe(2);
    expect(await db.generations.editRank(uuid(2))).toBe(3);
    expect(await db.generations.editRank(uuid(3))).toBe(0);
    expect(await db.generations.editRank(uuid(99))).toBe(0);
  });

  test('recentPrompts is distinct, newest use first, skips upscales and keeps its limit', async () => {
    await create(edit(1, T0, 'a'));
    await create(edit(2, T1, 'b'));
    await create(edit(3, T2, 'a'));
    await create(upscale(4, T3));
    await create(edit(5, T3, 'c'));
    expect(await db.generations.recentPrompts(20)).toEqual(['c', 'a', 'b']);
    expect(await db.generations.recentPrompts(2)).toEqual(['c', 'a']);
  });

  test('requeue replaces job_id, inserts the job and clears the error and finished_at', async () => {
    await create(edit(1));
    db.generations.settle({ id: uuid(1), outcome: { status: 'failed', errorCode: 'provider_rejected' }, now: T2 });
    expect(await db.generations.requeue({ id: uuid(1), job: jobFor(1, 1), now: T3 })).toBe(true);
    expect(await db.generations.get(uuid(1))).toMatchObject({
      status: 'pending',
      errorCode: null,
      finishedAt: null,
      jobId: uuid(1101),
      jobStatus: 'queued',
    });
    expect(await db.jobs.get(uuid(1101))).toMatchObject({ status: 'queued', createdAt: T3, payload: { v: 1, generationId: uuid(1) } });
    expect((await db.generations.byJob(uuid(1101)))?.id).toBe(uuid(1));
    expect(await db.generations.byJob(uuid(101))).toBeNull();
  });

  test('requeue of a pending generation answers false and writes no job', async () => {
    await create(edit(1));
    expect(await db.generations.requeue({ id: uuid(1), job: jobFor(1, 1), now: T3 })).toBe(false);
    expect(await db.generations.requeue({ id: uuid(99), job: jobFor(1, 2), now: T3 })).toBe(false);
    expect(await db.jobs.get(uuid(1101))).toBeNull();
    expect(await db.jobs.get(uuid(2101))).toBeNull();
    expect(await db.generations.get(uuid(1))).toMatchObject({ status: 'pending', jobId: uuid(101) });
  });

  test('requeue whose job is skipped for a trashed source answers false and leaves the generation', async () => {
    await create(edit(1));
    db.generations.settle({ id: uuid(1), outcome: { status: 'cancelled' }, now: T2 });
    await db.jobs.cancelPending({ id: uuid(101), now: T2 });
    await trash(SOURCE);
    expect(await db.generations.requeue({ id: uuid(1), job: jobFor(1, 1), now: T3 })).toBe(false);
    expect(await db.jobs.get(uuid(1101))).toBeNull();
    expect(await db.generations.get(uuid(1))).toMatchObject({ status: 'cancelled', jobId: uuid(101) });
  });

  test('remove deletes a failed or cancelled generation with its input and output rows', async () => {
    await create(edit(1));
    await create(edit(2));
    await db.generations.succeed({ id: uuid(2), output, now: T2 });
    expect(await db.generations.remove(uuid(1))).toBe(false);
    expect(await db.generations.remove(uuid(2))).toBe(false);
    // A succeeded generation is never cancelled through the repository; raw SQL only sets up the cascade check.
    handle.prepare("update generation set status = 'cancelled' where id = ?").run(uuid(2));
    db.generations.settle({ id: uuid(1), outcome: { status: 'cancelled' }, now: T2 });
    expect(await db.generations.remove(uuid(1))).toBe(true);
    expect(await db.generations.remove(uuid(2))).toBe(true);
    for (const n of [1, 2]) {
      expect(await db.generations.get(uuid(n))).toBeNull();
      expect(count('generation_input', uuid(n))).toBe(0);
      expect(count('generation_output', uuid(n))).toBe(0);
    }
    expect(await db.generations.remove(uuid(1))).toBe(false);
  });

  test('a row whose parameters do not parse throws on read', async () => {
    await create(edit(1));
    handle.prepare("update generation set parameters = '{\"v\":2}' where id = ?").run(uuid(1));
    await expect(db.generations.get(uuid(1))).rejects.toThrow();
  });

  test('the database refuses an unknown kind, status or provider kind', async () => {
    await create(edit(1));
    const set = (column: string) => () => handle.prepare(`update generation set ${column} = 'other' where id = ?`).run(uuid(1));
    expect(set('kind')).toThrow(/CHECK/);
    expect(set('status')).toThrow(/CHECK/);
    expect(set('provider_kind')).toThrow(/CHECK/);
  });

  test('jobs.list takes provider name and model of an image.generate job from its generation', async () => {
    await create(edit(1));
    await create(upscale(2, T1));
    await db.jobs.enqueue({
      jobs: [
        {
          id: uuid(300),
          type: 'vision.analyze_file',
          resourceClass: 'local_gpu',
          fileId: null,
          lane: 'a',
          payload: { version: 4, model: 'm4', mode: 'apply', prompt: null, providerName: 'RunPod' },
          dedupeKey: null,
        },
      ],
      now: T2,
    });
    const { items } = await db.jobs.list({ limit: 10, offset: 0 });
    expect(items.map((i) => [i.id, i.fileName, i.providerId, i.providerName, i.model])).toEqual([
      [uuid(300), null, 'a', 'RunPod', 'm4'],
      [uuid(102), 'oak.png', PROVIDER, 'Venice', null],
      [uuid(101), 'oak.png', PROVIDER, 'Venice', 'qwen-image'],
    ]);
  });

  test('jobs.list names provider and model for every run of a requeued generation', async () => {
    await create(edit(1));
    db.generations.settle({ id: uuid(1), outcome: { status: 'failed', errorCode: 'provider_rejected' }, now: T2 });
    expect(await db.generations.requeue({ id: uuid(1), job: jobFor(1, 1), now: T3 })).toBe(true);
    const { items } = await db.jobs.list({ limit: 10, offset: 0 });
    expect(items.map((i) => [i.id, i.providerName, i.model])).toEqual([
      [uuid(1101), 'Venice', 'qwen-image'],
      [uuid(101), 'Venice', 'qwen-image'],
    ]);
  });
});
