import { describe, expect, it } from 'vitest';
import type { NewJob } from '../src/jobs.js';
import { InMemoryJobRepository } from './memory-jobs.js';

const T = 'vision.analyze_file';
const T0 = '2026-11-26T10:00:00.000Z';
const T1 = '2026-11-26T10:00:01.000Z';
const T2 = '2026-11-26T10:00:02.000Z';
const LATER = '2026-11-26T11:00:00.000Z';

const job = (id: string, lane: string | null, payload: unknown = { version: 1 }, type = T): NewJob => ({
  id,
  type,
  resourceClass: 'local_gpu',
  fileId: null,
  lane,
  payload,
  dedupeKey: null,
});

/** Inserts the jobs one at a time, one second apart, so their order is the order given. */
async function repoWith(jobs: NewJob[]): Promise<InMemoryJobRepository> {
  const repo = new InMemoryJobRepository();
  for (const [i, j] of jobs.entries()) {
    await repo.enqueue({ jobs: [j], now: new Date(Date.parse(T0) + i * 1000).toISOString() });
  }
  return repo;
}

const row = (repo: InMemoryJobRepository, id: string) => repo.rows.find((r) => r.id === id)!;

/** Puts a job into `status` directly, as a test fixture. */
function setStatus(repo: InMemoryJobRepository, id: string, status: 'running' | 'failed' | 'cancelled' | 'succeeded' | 'retry_wait' | 'waiting_remote', runAfter: string | null = null) {
  Object.assign(row(repo, id), { status, runAfter, attempt: 2, errorCode: status === 'retry_wait' ? 'provider_timeout' : null });
}

const claim = (repo: InMemoryJobRepository, excludeLanes?: (string | null)[]) =>
  repo.claimNext({ resourceClass: 'local_gpu', types: [T], now: LATER, excludeLanes });

describe('InMemoryJobRepository lanes', () => {
  it('enqueue stores the lane', async () => {
    const repo = await repoWith([job('a1', 'a'), job('n1', null)]);
    expect((await repo.get('a1'))?.lane).toBe('a');
    expect((await repo.get('n1'))?.lane).toBeNull();
  });

  it('claimNext skips jobs of an excluded lane', async () => {
    const repo = await repoWith([job('a1', 'a'), job('b1', 'b'), job('a2', 'a')]);
    expect((await claim(repo, ['a']))?.id).toBe('b1');
    expect(await claim(repo, ['a', 'b'])).toBeNull();
    expect((await claim(repo))?.id).toBe('a1');
  });

  it('claimNext with null excluded skips a job without lane', async () => {
    const repo = await repoWith([job('n1', null), job('a1', 'a')]);
    expect((await claim(repo, [null]))?.id).toBe('a1');
    expect(await claim(repo, [null])).toBeNull();
    expect((await claim(repo, []))?.id).toBe('n1');
  });

  it('nextRunAfter ignores a retry_wait job of an excluded lane', async () => {
    const repo = await repoWith([job('a1', 'a'), job('b1', 'b')]);
    setStatus(repo, 'a1', 'retry_wait', '2026-11-26T10:05:00.000Z');
    setStatus(repo, 'b1', 'retry_wait', '2026-11-26T10:10:00.000Z');
    expect(await repo.nextRunAfter([T])).toBe('2026-11-26T10:05:00.000Z');
    expect(await repo.nextRunAfter([T], ['a'])).toBe('2026-11-26T10:10:00.000Z');
    expect(await repo.nextRunAfter([T], ['a', 'b'])).toBeNull();
  });

  it('rerouteWaiting moves the queued and retry_wait jobs of a lane and leaves the others', async () => {
    const repo = await repoWith([
      job('q', 'a', { n: 'q' }),
      job('w', 'a', { n: 'w' }),
      job('r', 'a'),
      job('f', 'a'),
      job('c', 'a'),
      job('other', 'c'),
      job('otherType', 'a', { version: 1 }, 'other.type'),
    ]);
    setStatus(repo, 'w', 'retry_wait', '2026-11-26T10:05:00.000Z');
    setStatus(repo, 'r', 'running');
    setStatus(repo, 'f', 'failed');
    setStatus(repo, 'c', 'cancelled');

    const moved = await repo.rerouteWaiting({
      type: T,
      fromLane: 'a',
      toLane: 'b',
      rewrite: (p) => ({ ...(p as object), moved: true }),
      now: LATER,
    });

    expect(moved).toBe(2);
    for (const id of ['q', 'w']) {
      expect(row(repo, id)).toMatchObject({
        lane: 'b',
        status: 'queued',
        attempt: 0,
        runAfter: null,
        errorCode: null,
        errorMessage: null,
        payload: { n: id, moved: true },
        updatedAt: LATER,
      });
    }
    expect(row(repo, 'r')).toMatchObject({ lane: 'a', status: 'running', attempt: 2 });
    expect(row(repo, 'f')).toMatchObject({ lane: 'a', status: 'failed' });
    expect(row(repo, 'c')).toMatchObject({ lane: 'a', status: 'cancelled' });
    expect(row(repo, 'other').lane).toBe('c');
    expect(row(repo, 'otherType').lane).toBe('a');
    expect(await repo.rerouteWaiting({ type: T, fromLane: 'a', toLane: 'b', rewrite: (p) => p, now: LATER })).toBe(0);
  });

  it('rerouteWaiting from null moves the jobs without lane', async () => {
    const repo = await repoWith([job('n1', null), job('a1', 'a')]);
    expect(await repo.rerouteWaiting({ type: T, fromLane: null, toLane: 'b', rewrite: (p) => p, now: LATER })).toBe(1);
    expect(row(repo, 'n1').lane).toBe('b');
    expect(row(repo, 'a1').lane).toBe('a');
  });

  it('assignLane gives active jobs without lane a lane, unless rewrite answers null', async () => {
    const repo = await repoWith([
      job('q', null, { keep: false }),
      job('w', null, { keep: false }),
      job('skip', null, { keep: true }),
      job('done', null, { keep: false }),
      job('laned', 'a', { keep: false }),
    ]);
    setStatus(repo, 'w', 'retry_wait', '2026-11-26T10:05:00.000Z');
    setStatus(repo, 'done', 'succeeded');

    const changed = await repo.assignLane({
      type: T,
      lane: 'b',
      rewrite: (p) => ((p as { keep: boolean }).keep ? null : { ...(p as object), laned: true }),
      now: LATER,
    });

    expect(changed).toBe(2);
    expect(row(repo, 'q')).toMatchObject({ lane: 'b', status: 'queued', attempt: 0, payload: { keep: false, laned: true } });
    expect(row(repo, 'w')).toMatchObject({
      lane: 'b',
      status: 'retry_wait',
      attempt: 2,
      runAfter: '2026-11-26T10:05:00.000Z',
      payload: { keep: false, laned: true },
    });
    expect(row(repo, 'skip')).toMatchObject({ lane: null, payload: { keep: true } });
    expect(row(repo, 'done')).toMatchObject({ lane: null, payload: { keep: false } });
    expect(row(repo, 'laned')).toMatchObject({ lane: 'a', payload: { keep: false } });
  });

  it('waitingByLane counts queued and retry_wait jobs per lane', async () => {
    const repo = await repoWith([
      job('a1', 'a'),
      job('a2', 'a'),
      job('a3', 'a'),
      job('n1', null),
      job('b1', 'b'),
      job('x', 'a', { version: 1 }, 'other.type'),
    ]);
    setStatus(repo, 'a2', 'retry_wait', LATER);
    setStatus(repo, 'a3', 'running');
    setStatus(repo, 'b1', 'failed');
    const waiting = await repo.waitingByLane(T);
    expect(waiting).toHaveLength(2);
    expect(waiting).toEqual(
      expect.arrayContaining([
        { lane: 'a', waiting: 2 },
        { lane: null, waiting: 1 },
      ]),
    );
  });

  it('countActiveInLane counts every active job of the lane', async () => {
    const repo = await repoWith([job('a1', 'a'), job('a2', 'a'), job('a3', 'a'), job('a4', 'a'), job('b1', 'b'), job('x', 'a', {}, 'other.type')]);
    setStatus(repo, 'a2', 'running');
    setStatus(repo, 'a3', 'waiting_remote');
    setStatus(repo, 'a4', 'cancelled');
    expect(await repo.countActiveInLane(T, 'a')).toBe(3);
    expect(await repo.countActiveInLane(T, 'b')).toBe(1);
    expect(await repo.countActiveInLane(T, 'c')).toBe(0);
  });

  it('latestPayloadOfLane answers the payload of the newest job of the lane in any status', async () => {
    const repo = await repoWith([job('a1', 'a', { n: 1 }), job('a2', 'a', { n: 2 }), job('b1', 'b', { n: 3 }), job('n1', null, { n: 4 })]);
    setStatus(repo, 'a2', 'failed');
    expect(await repo.latestPayloadOfLane(T, 'a')).toEqual({ n: 2 });
    expect(await repo.latestPayloadOfLane(T, null)).toEqual({ n: 4 });
    expect(await repo.latestPayloadOfLane(T, 'c')).toBeNull();
    expect(await repo.latestPayloadOfLane('other.type', 'a')).toBeNull();
  });

  it('list filters by lane and carries provider id, provider name and model', async () => {
    const v4 = { version: 4, model: 'm4', mode: 'apply', prompt: null, providerName: 'RunPod' };
    const repo = await repoWith([job('a1', 'a', v4), job('b1', 'b', { version: 2, model: 'm2', mode: 'apply' }), job('n1', null)]);

    const all = await repo.list({ limit: 10, offset: 0 });
    expect(all.total).toBe(3);
    expect(all.items.map((i) => [i.id, i.providerId, i.providerName, i.model])).toEqual([
      ['n1', null, null, null],
      ['b1', 'b', null, 'm2'],
      ['a1', 'a', 'RunPod', 'm4'],
    ]);

    const a = await repo.list({ limit: 10, offset: 0, lane: 'a' });
    expect(a.total).toBe(1);
    expect(a.items[0]).toMatchObject({ id: 'a1', providerId: 'a', providerName: 'RunPod', model: 'm4', createdAt: T0 });
    expect((await repo.list({ limit: 10, offset: 0, lane: 'a', status: 'failed' })).total).toBe(0);
    expect((await repo.list({ limit: 10, offset: 0, lane: 'b' })).items[0]?.createdAt).toBe(T1);
    expect((await repo.list({ limit: 10, offset: 0 })).items[0]?.createdAt).toBe(T2);
  });
});

describe('InMemoryJobRepository settled hooks and retry exclusions', () => {
  it('finish with settled runs it once, only when the row changed', async () => {
    const repo = await repoWith([job('r', 'a'), job('q', 'a')]);
    setStatus(repo, 'r', 'running');
    let calls = 0;
    const settled = () => {
      calls++;
    };
    expect(await repo.finish('r', { status: 'failed', errorCode: 'provider_timeout', now: LATER, settled })).toBe(true);
    expect(calls).toBe(1);
    expect(await repo.finish('r', { status: 'failed', errorCode: 'provider_timeout', now: LATER, settled })).toBe(false);
    expect(await repo.finish('q', { status: 'succeeded', errorCode: null, now: LATER, settled })).toBe(false);
    expect(calls).toBe(1);
  });

  it('a throwing settled in finish rolls the end back', async () => {
    const repo = await repoWith([job('r', 'a')]);
    setStatus(repo, 'r', 'running');
    const settled = () => {
      throw new Error('boom');
    };
    await expect(repo.finish('r', { status: 'succeeded', errorCode: null, now: LATER, settled })).rejects.toThrow('boom');
    expect(row(repo, 'r')).toMatchObject({ status: 'running', finishedAt: null });
  });

  it('cancelPending calls settled per cancelled job', async () => {
    const repo = await repoWith([job('q', 'a'), job('w', 'a'), job('r', 'a'), job('f', 'a')]);
    setStatus(repo, 'w', 'retry_wait', LATER);
    setStatus(repo, 'r', 'running');
    setStatus(repo, 'f', 'failed');
    const seen: [string, string][] = [];
    expect(await repo.cancelPending({ now: LATER, settled: (j) => seen.push([j.id, j.status]) })).toBe(2);
    expect(seen.sort()).toEqual([
      ['q', 'cancelled'],
      ['w', 'cancelled'],
    ]);
    expect(await repo.cancelPending({ now: LATER, settled: (j) => seen.push([j.id, j.status]) })).toBe(0);
    expect(seen).toHaveLength(2);
  });

  it('a throwing settled in cancelPending rolls every cancel back', async () => {
    const repo = await repoWith([job('q1', 'a'), job('q2', 'a')]);
    let n = 0;
    const settled = () => {
      if (++n === 2) throw new Error('boom');
    };
    await expect(repo.cancelPending({ now: LATER, settled })).rejects.toThrow('boom');
    expect(row(repo, 'q1').status).toBe('queued');
    expect(row(repo, 'q2').status).toBe('queued');
  });

  it('retry with excludeTypes skips those rows', async () => {
    const repo = await repoWith([job('a', 'a'), job('g', 'v', { v: 1 }, 'image.generate')]);
    setStatus(repo, 'a', 'failed');
    setStatus(repo, 'g', 'failed');
    expect(await repo.retry({ now: LATER, excludeTypes: ['image.generate'] })).toBe(1);
    expect(row(repo, 'a').status).toBe('queued');
    expect(row(repo, 'g').status).toBe('failed');
    expect(await repo.retry({ id: 'g', now: LATER, excludeTypes: ['image.generate'] })).toBe(0);
    expect(await repo.retry({ id: 'g', now: LATER })).toBe(1);
  });
});
