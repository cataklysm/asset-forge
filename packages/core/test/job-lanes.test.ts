import { describe, expect, it } from 'vitest';
import { ANALYZE_FILE_JOB, type JobStatus } from '@assetforge/contracts';
import {
  assignUnroutedJobs,
  countActiveAnalysisJobs,
  InvalidOperationError,
  laneName,
  listJobs,
  listWaitingLanes,
  rerouteJobs,
} from '../src/index.js';
import { setup, T0, type Setup } from './analysis-setup.js';

const PROMPT = { name: 'Detail', text: 'T', maxTags: 9 };
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let counter = 0;

/** Adds an analysis job of the lane with the payload and status, created at `createdAt`. */
async function addJob(
  c: Setup,
  r: { lane: string | null; payload: unknown; status?: JobStatus; createdAt?: string; type?: string },
): Promise<string> {
  const id = `job-${++counter}`;
  await c.db.jobs.enqueue({
    jobs: [{ id, type: r.type ?? ANALYZE_FILE_JOB, resourceClass: 'local_gpu', fileId: null, lane: r.lane, payload: r.payload, dedupeKey: null }],
    now: r.createdAt ?? T0,
  });
  const row = c.db.jobs.rows.find((j) => j.id === id)!;
  row.status = r.status ?? 'queued';
  if (row.status === 'retry_wait') {
    row.attempt = 2;
    row.runAfter = '2030-01-01T00:00:00.000Z';
    row.errorCode = 'provider_unreachable';
  }
  return id;
}

const v3 = (mode: 'apply' | 'propose' = 'apply') => ({ version: 3, model: 'old', mode, prompt: PROMPT });
const v4 = (name: string) => ({ version: 4, model: 'old', mode: 'apply', prompt: PROMPT, providerName: name });

describe('rerouteJobs', () => {
  it('refuses to move onto the same lane and changes nothing', async () => {
    const c = await setup();
    await addJob(c, { lane: A, payload: v4('Local') });
    const before = structuredClone(c.db.jobs.rows);
    const error = await rerouteJobs(c.session, { fromLane: A, to: { id: A, name: 'Local' }, model: 'm' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidOperationError);
    expect((error as Error).message).toBe('Jobs cannot be moved onto the same provider');
    expect(c.db.jobs.rows).toEqual(before);
  });

  it('moves the waiting jobs of a lane with the new name and model and counts them', async () => {
    const c = await setup();
    const queued = await addJob(c, { lane: A, payload: v3('propose') });
    const waiting = await addJob(c, { lane: A, payload: { version: 2, model: 'old', mode: 'apply' }, status: 'retry_wait' });
    const running = await addJob(c, { lane: A, payload: v4('Local'), status: 'running' });
    const failed = await addJob(c, { lane: A, payload: v4('Local'), status: 'failed' });
    const other = await addJob(c, { lane: null, payload: v4('Local') });

    expect(await rerouteJobs(c.session, { fromLane: A, to: { id: B, name: 'RunPod' }, model: 'qwen:9b' })).toEqual({ moved: 2 });

    const row = (id: string) => c.db.jobs.rows.find((j) => j.id === id)!;
    expect(row(queued)).toMatchObject({
      lane: B,
      status: 'queued',
      attempt: 0,
      payload: { version: 4, model: 'qwen:9b', mode: 'propose', prompt: PROMPT, providerName: 'RunPod' },
    });
    expect(row(waiting)).toMatchObject({
      lane: B,
      status: 'queued',
      attempt: 0,
      runAfter: null,
      errorCode: null,
      payload: { version: 4, model: 'qwen:9b', mode: 'apply', prompt: null, providerName: 'RunPod' },
    });
    expect(row(running)).toMatchObject({ lane: A, payload: v4('Local') });
    expect(row(failed)).toMatchObject({ lane: A, status: 'failed' });
    expect(row(other).lane).toBeNull();

    expect(await rerouteJobs(c.session, { fromLane: A, to: { id: B, name: 'RunPod' }, model: 'qwen:9b' })).toEqual({ moved: 0 });
  });

  it('moves a job whose payload does not parse but keeps its payload', async () => {
    const c = await setup();
    const future = { version: 5, model: 'old', mode: 'propose', prompt: PROMPT };
    const id = await addJob(c, { lane: A, payload: future });
    expect(await rerouteJobs(c.session, { fromLane: A, to: { id: B, name: 'RunPod' }, model: 'm' })).toEqual({ moved: 1 });
    expect(c.db.jobs.rows.find((j) => j.id === id)).toMatchObject({ lane: B, status: 'queued', payload: future });
  });

  it('moves the jobs without a lane', async () => {
    const c = await setup();
    const v1 = await addJob(c, { lane: null, payload: { version: 1 } });
    await addJob(c, { lane: A, payload: v4('Local') });
    expect(await rerouteJobs(c.session, { fromLane: null, to: { id: B, name: 'RunPod' }, model: 'm' })).toEqual({ moved: 1 });
    expect(c.db.jobs.rows.find((j) => j.id === v1)).toMatchObject({
      lane: B,
      payload: { version: 4, model: 'm', mode: 'apply', prompt: null, providerName: 'RunPod' },
    });
  });
});

describe('assignUnroutedJobs', () => {
  it('assigns the active jobs without a lane and keeps their model', async () => {
    const c = await setup();
    const v2 = await addJob(c, { lane: null, payload: { version: 2, model: 'own', mode: 'propose' }, status: 'retry_wait' });
    const v1 = await addJob(c, { lane: null, payload: { version: 1 } });
    const done = await addJob(c, { lane: null, payload: v3(), status: 'succeeded' });

    expect(await assignUnroutedJobs(c.session, { id: A, name: 'Ollama', taggingModel: 'llava' })).toBe(2);

    const row = (id: string) => c.db.jobs.rows.find((j) => j.id === id)!;
    expect(row(v2)).toMatchObject({
      lane: A,
      status: 'retry_wait',
      attempt: 2,
      payload: { version: 4, model: 'own', mode: 'propose', prompt: null, providerName: 'Ollama' },
    });
    expect(row(v1)).toMatchObject({ lane: A, payload: { version: 4, model: 'llava', mode: 'apply', prompt: null, providerName: 'Ollama' } });
    expect(row(done)).toMatchObject({ lane: null, payload: v3() });
  });

  it('leaves a v1 row unassigned without a tagging model', async () => {
    const c = await setup();
    const v1 = await addJob(c, { lane: null, payload: { version: 1 } });
    const v3row = await addJob(c, { lane: null, payload: v3() });
    expect(await assignUnroutedJobs(c.session, { id: A, name: 'Ollama', taggingModel: null })).toBe(1);
    expect(c.db.jobs.rows.find((j) => j.id === v1)).toMatchObject({ lane: null, payload: { version: 1 } });
    expect(c.db.jobs.rows.find((j) => j.id === v3row)!.lane).toBe(A);
  });
});

describe('listWaitingLanes and laneName', () => {
  it('lists a lane whose jobs all wait for a retry, with the payload name', async () => {
    const c = await setup();
    await addJob(c, { lane: A, payload: v4('Old name'), status: 'retry_wait' });
    await addJob(c, { lane: A, payload: v4('RunPod'), status: 'retry_wait', createdAt: '2026-01-02T00:00:00.000Z' });
    await addJob(c, { lane: null, payload: { version: 1 } });
    await addJob(c, { lane: B, payload: v4('Done'), status: 'succeeded' });
    await addJob(c, { lane: B, payload: v4('Other type'), type: 'other.type' });

    const lanes = await listWaitingLanes(c.session);
    expect(lanes.sort((x, y) => String(x.lane).localeCompare(String(y.lane)))).toEqual([
      { lane: A, payloadName: 'RunPod', waiting: 2 },
      { lane: null, payloadName: null, waiting: 1 },
    ]);
  });

  it('answers null for a lane with only v2 rows or without jobs', async () => {
    const c = await setup();
    await addJob(c, { lane: A, payload: { version: 2, model: 'm', mode: 'apply' } });
    expect(await laneName(c.session, A)).toBeNull();
    expect(await laneName(c.session, B)).toBeNull();
    await addJob(c, { lane: B, payload: v4('RunPod'), status: 'failed' });
    expect(await laneName(c.session, B)).toBe('RunPod');
  });
});

describe('countActiveAnalysisJobs and listJobs', () => {
  it('counts the active analysis jobs of a lane', async () => {
    const c = await setup();
    await addJob(c, { lane: A, payload: v4('L') });
    await addJob(c, { lane: A, payload: v4('L'), status: 'running' });
    await addJob(c, { lane: A, payload: v4('L'), status: 'retry_wait' });
    await addJob(c, { lane: A, payload: v4('L'), status: 'failed' });
    await addJob(c, { lane: A, payload: v4('L'), type: 'other.type' });
    await addJob(c, { lane: B, payload: v4('L') });
    expect(await countActiveAnalysisJobs(c.session, A)).toBe(3);
  });

  it('filters the job list by lane', async () => {
    const c = await setup();
    const a = await addJob(c, { lane: A, payload: v4('L') });
    await addJob(c, { lane: B, payload: v4('L') });
    const page = await listJobs(c.session, { limit: 10, offset: 0, lane: A });
    expect(page.total).toBe(1);
    expect(page.items.map((j) => j.id)).toEqual([a]);
    expect(page.items[0]).toMatchObject({ providerId: A, providerName: 'L', model: 'old' });
  });
});
