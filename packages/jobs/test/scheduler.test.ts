import type { ResourceClass } from '@assetforge/contracts';
import { JobError, type Job, type JobHandler, type JobRepository } from '@assetforge/core';
import { describe, expect, it } from 'vitest';
import { InMemoryJobRepository } from '../../core/test/memory-jobs.js';
import { DEFAULT_LIMITS, MAX_ATTEMPTS, RETRY_DELAYS_MS, createScheduler, type Scheduler } from '../src/index.js';

interface Deferred {
  resolve(): void;
  reject(error: unknown): void;
}

interface Run extends Deferred {
  job: Job;
  signal: AbortSignal;
}

/** A handler whose runs stay pending until the test settles them. */
function controlled(resourceClass: ResourceClass, onInterrupted: 'requeue' | 'fail' = 'requeue') {
  const runs: Run[] = [];
  const handler: JobHandler = {
    resourceClass,
    onInterrupted,
    run(job, signal) {
      return new Promise<void>((resolve, reject) => runs.push({ job, signal, resolve, reject }));
    },
  };
  const runOf = (id: string): Run => {
    const run = runs.findLast((r) => r.job.id === id);
    if (!run) throw new Error(`no run of ${id}`);
    return run;
  };
  return { handler, runs, runOf };
}

/** Lets every pending promise chain of the scheduler settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

function setup(o: {
  handlers: Record<string, JobHandler>;
  limits?: Record<ResourceClass, number>;
  repo?: (fake: InMemoryJobRepository) => JobRepository;
}) {
  let t = Date.parse('2026-01-01T00:00:00.000Z');
  const iso = () => new Date(t).toISOString();
  const fake = new InMemoryJobRepository();
  const calls = { n: 0 };
  const inner = o.repo ? o.repo(fake) : fake;
  const counted = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.n++;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const timers: { fn: () => void; ms: number }[] = [];
  const changes = { n: 0 };
  const logged: { message: string; cause: unknown }[] = [];
  const scheduler: Scheduler = createScheduler({
    jobs: counted,
    handlers: o.handlers,
    ...(o.limits ? { limits: o.limits } : {}),
    now: () => new Date(t),
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      const i = timers.indexOf(handle as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
    onChange: () => changes.n++,
    log: (message, cause) => logged.push({ message, cause }),
  });
  let seq = 0;
  /** Enqueues jobs one millisecond apart, so their created_at gives the order. */
  const enqueue = async (type: string, resourceClass: ResourceClass, count = 1): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `job-${String(++seq).padStart(3, '0')}`;
      await fake.enqueue({ jobs: [{ id, type, resourceClass, fileId: null, payload: { version: 1 }, dedupeKey: null }], now: iso() });
      ids.push(id);
      t += 1;
    }
    return ids;
  };
  const row = (id: string): Job => {
    const r = fake.rows.find((x) => x.id === id);
    if (!r) throw new Error(`no row ${id}`);
    return r;
  };
  const fireTimer = async () => {
    const timer = timers.shift();
    if (!timer) throw new Error('no timer');
    timer.fn();
    await flush();
  };
  return {
    scheduler,
    fake,
    calls,
    timers,
    changes,
    logged,
    enqueue,
    row,
    fireTimer,
    advance: (ms: number) => {
      t += ms;
    },
    iso,
  };
}

describe('constants', () => {
  it('has the agreed limits, attempts and delays', () => {
    expect(DEFAULT_LIMITS).toEqual({ cpu: 2, io: 2, local_gpu: 1, remote_api: 2 });
    expect(MAX_ATTEMPTS).toBe(3);
    expect(RETRY_DELAYS_MS).toEqual([5_000, 30_000]);
  });
});

describe('JobError', () => {
  it('carries the code and its fixed message', () => {
    const error = new JobError('provider_rejected', { cause: new Error('secret body') });
    expect(error.code).toBe('provider_rejected');
    expect(error.message).toBe('The analysis provider rejected the request');
    expect(error).toBeInstanceOf(Error);
  });
});

describe('createScheduler', () => {
  it('claims first in, first out per resource class', async () => {
    const h = controlled('cpu');
    const s = setup({ handlers: { t: h.handler }, limits: { ...DEFAULT_LIMITS, cpu: 1 } });
    const ids = await s.enqueue('t', 'cpu', 3);
    await s.scheduler.start();
    for (const id of ids) {
      expect(h.runs.at(-1)!.job.id).toBe(id);
      expect(s.row(id).status).toBe('running');
      h.runOf(id).resolve();
      await flush();
      expect(s.row(id).status).toBe('succeeded');
    }
    expect(h.runs.map((r) => r.job.id)).toEqual(ids);
  });

  it('holds each class limit with mixed classes', async () => {
    const gpu = controlled('local_gpu');
    const cpu = controlled('cpu');
    const s = setup({ handlers: { gpu: gpu.handler, cpu: cpu.handler } });
    const gpuIds = await s.enqueue('gpu', 'local_gpu', 2);
    const cpuIds = await s.enqueue('cpu', 'cpu', 3);
    await s.scheduler.start();
    expect(gpu.runs.map((r) => r.job.id)).toEqual([gpuIds[0]]);
    expect(cpu.runs.map((r) => r.job.id)).toEqual([cpuIds[0], cpuIds[1]]);

    cpu.runOf(cpuIds[0]!).resolve();
    await flush();
    expect(cpu.runs.map((r) => r.job.id)).toEqual(cpuIds);
    expect(gpu.runs).toHaveLength(1);

    gpu.runOf(gpuIds[0]!).resolve();
    await flush();
    expect(gpu.runs.map((r) => r.job.id)).toEqual(gpuIds);
  });

  it('retries after 5 s and 30 s and fails after the third run', async () => {
    const h = controlled('remote_api');
    const s = setup({ handlers: { t: h.handler } });
    const [id] = (await s.enqueue('t', 'remote_api')) as [string];
    await s.scheduler.start();

    h.runOf(id).reject(new JobError('provider_timeout'));
    await flush();
    let r = s.row(id);
    expect(r.status).toBe('retry_wait');
    expect(r.attempt).toBe(1);
    expect(r.runAfter).toBe(new Date(Date.parse(s.iso()) + 5_000).toISOString());
    expect(s.timers.map((x) => x.ms)).toEqual([5_000]);

    s.advance(5_000);
    await s.fireTimer();
    expect(h.runs).toHaveLength(2);
    expect(s.row(id).status).toBe('running');
    expect(s.row(id).attempt).toBe(2);

    h.runOf(id).reject(new JobError('provider_unavailable'));
    await flush();
    r = s.row(id);
    expect(r.status).toBe('retry_wait');
    expect(r.runAfter).toBe(new Date(Date.parse(s.iso()) + 30_000).toISOString());
    expect(s.timers.map((x) => x.ms)).toEqual([30_000]);

    s.advance(30_000);
    await s.fireTimer();
    expect(h.runs).toHaveLength(3);
    h.runOf(id).reject(new JobError('provider_timeout'));
    await flush();
    r = s.row(id);
    expect(r.status).toBe('failed');
    expect(r.attempt).toBe(3);
    expect(r.errorCode).toBe('provider_timeout');
    expect(r.errorMessage).toBe('The analysis provider did not answer in time');
    expect(s.timers).toHaveLength(0);
  });

  it('fails a non-retryable code at once', async () => {
    const h = controlled('remote_api');
    const s = setup({ handlers: { t: h.handler } });
    const [id] = (await s.enqueue('t', 'remote_api')) as [string];
    await s.scheduler.start();
    h.runOf(id).reject(new JobError('provider_rejected'));
    await flush();
    expect(s.row(id)).toMatchObject({ status: 'failed', attempt: 1, errorCode: 'provider_rejected', errorMessage: 'The analysis provider rejected the request' });
    expect(s.timers).toHaveLength(0);
  });

  it('turns a thrown non-JobError into internal_error and logs the cause', async () => {
    const h = controlled('cpu');
    const s = setup({ handlers: { t: h.handler } });
    const [id] = (await s.enqueue('t', 'cpu')) as [string];
    await s.scheduler.start();
    const cause = new Error('C:\\secret\\path exploded');
    h.runOf(id).reject(cause);
    await flush();
    expect(s.row(id)).toMatchObject({ status: 'failed', errorCode: 'internal_error', errorMessage: 'The job failed unexpectedly' });
    expect(s.logged.map((l) => l.cause)).toEqual([cause]);
  });

  it('cancels queued, waiting and retry-waiting jobs', async () => {
    const h = controlled('cpu');
    const s = setup({ handlers: { t: h.handler }, limits: { ...DEFAULT_LIMITS, cpu: 1 } });
    const [running, queued, waiting, remote] = (await s.enqueue('t', 'cpu', 4)) as [string, string, string, string];
    Object.assign(s.row(waiting), { status: 'retry_wait', runAfter: '2030-01-01T00:00:00.000Z' });
    Object.assign(s.row(remote), { status: 'waiting_remote' });
    await s.scheduler.start();
    expect(s.row(running).status).toBe('running');

    for (const id of [queued, waiting, remote]) await s.scheduler.cancel(id);
    for (const id of [queued, waiting, remote]) expect(s.row(id).status).toBe('cancelled');
    expect(h.runs).toHaveLength(1);
  });

  it('cancels a running job without waiting for its handler, which ignores the abort', async () => {
    const h = controlled('cpu');
    const s = setup({ handlers: { t: h.handler } });
    const [a, b] = (await s.enqueue('t', 'cpu', 2)) as [string, string];
    await s.scheduler.start();

    await s.scheduler.cancel(a);
    expect(h.runOf(a).signal.aborted).toBe(true);
    expect(s.row(a).status).toBe('running');
    h.runOf(a).resolve();
    await flush();
    expect(s.row(a).status).toBe('cancelled');

    await s.scheduler.cancel(b);
    h.runOf(b).reject(new JobError('provider_timeout'));
    await flush();
    expect(s.row(b)).toMatchObject({ status: 'cancelled', errorCode: null });
  });

  it('treats unknown and finished ids as no-ops', async () => {
    const h = controlled('cpu');
    const s = setup({ handlers: { t: h.handler } });
    const [id] = (await s.enqueue('t', 'cpu')) as [string];
    await s.scheduler.start();
    h.runOf(id).resolve();
    await flush();
    await s.scheduler.cancel(id);
    await s.scheduler.cancel('missing');
    expect(s.row(id).status).toBe('succeeded');
  });

  it('start requeues or fails interrupted jobs per policy without consuming an attempt', async () => {
    const again = controlled('cpu', 'requeue');
    const paid = controlled('remote_api', 'fail');
    const s = setup({ handlers: { again: again.handler, paid: paid.handler } });
    const [a] = (await s.enqueue('again', 'cpu')) as [string];
    const [p] = (await s.enqueue('paid', 'remote_api')) as [string];
    const [u] = (await s.enqueue('unknown', 'cpu')) as [string];
    for (const [rc, type] of [['cpu', 'again'], ['remote_api', 'paid'], ['cpu', 'unknown']] as const) {
      await s.fake.claimNext({ resourceClass: rc, types: [type], now: s.iso() });
    }

    await s.scheduler.start();
    expect(s.row(a)).toMatchObject({ status: 'running', attempt: 1 });
    expect(again.runs).toHaveLength(1);
    expect(s.row(p)).toMatchObject({ status: 'failed', errorCode: 'internal_error' });
    expect(paid.runs).toHaveLength(0);
    expect(s.row(u)).toMatchObject({ status: 'queued', attempt: 0 });
  });

  it('never claims a job whose type has no handler', async () => {
    const h = controlled('cpu');
    const s = setup({ handlers: { t: h.handler } });
    const [u] = (await s.enqueue('unknown', 'cpu')) as [string];
    const [k] = (await s.enqueue('t', 'cpu')) as [string];
    await s.scheduler.start();
    s.scheduler.wake();
    await flush();
    expect(s.row(u).status).toBe('queued');
    expect(h.runs.map((r) => r.job.id)).toEqual([k]);
  });

  it('lets a due retry_wait job compete by its created_at', async () => {
    const h = controlled('cpu');
    const s = setup({ handlers: { t: h.handler }, limits: { ...DEFAULT_LIMITS, cpu: 1 } });
    const [older, newer] = (await s.enqueue('t', 'cpu', 2)) as [string, string];
    Object.assign(s.row(older), { status: 'retry_wait', attempt: 1, runAfter: s.iso() });
    await s.scheduler.start();
    expect(h.runs.map((r) => r.job.id)).toEqual([older]);
    expect(s.row(newer).status).toBe('queued');
  });

  it('calls onChange on claim and on finish', async () => {
    const h = controlled('cpu');
    const s = setup({ handlers: { t: h.handler } });
    const [id] = (await s.enqueue('t', 'cpu')) as [string];
    await s.scheduler.start();
    expect(s.changes.n).toBe(1);
    h.runOf(id).resolve();
    await flush();
    expect(s.changes.n).toBe(2);
  });

  it('does not lose a wake that arrives during a pass', async () => {
    const h = controlled('cpu');
    let gate: (() => void) | null = null;
    let gated = false;
    const s = setup({
      handlers: { t: h.handler },
      repo: (fake) =>
        Object.assign(Object.create(fake) as InMemoryJobRepository, {
          async claimNext(r: Parameters<JobRepository['claimNext']>[0]) {
            const job = await fake.claimNext(r);
            if (gated) {
              gated = false;
              await new Promise<void>((resolve) => (gate = resolve));
            }
            return job;
          },
        }),
    });
    await s.scheduler.start();
    gated = true;
    s.scheduler.wake();
    await flush();
    expect(gate).not.toBeNull();

    const [id] = (await s.enqueue('t', 'cpu')) as [string];
    s.scheduler.wake();
    gate!();
    await flush();
    expect(h.runs.map((r) => r.job.id)).toEqual([id]);
  });

  it('stop puts running jobs back and keeps finished outcomes', async () => {
    const h = controlled('cpu');
    const s = setup({ handlers: { t: h.handler }, limits: { ...DEFAULT_LIMITS, cpu: 3 } });
    const [back, done, cancelled] = (await s.enqueue('t', 'cpu', 3)) as [string, string, string];
    await s.scheduler.start();
    await s.scheduler.cancel(cancelled);

    let stopped = false;
    const stopping = s.scheduler.stop().then(() => (stopped = true));
    await flush();
    for (const run of h.runs) expect(run.signal.aborted).toBe(true);
    expect(stopped).toBe(false);

    h.runOf(back).reject(new JobError('provider_unreachable'));
    h.runOf(done).resolve();
    h.runOf(cancelled).resolve();
    await stopping;
    expect(s.row(back)).toMatchObject({ status: 'queued', attempt: 0, startedAt: null });
    expect(s.row(done).status).toBe('succeeded');
    expect(s.row(cancelled).status).toBe('cancelled');
  });

  it('makes no repository call after stop resolves', async () => {
    const h = controlled('cpu');
    const s = setup({ handlers: { t: h.handler }, limits: { ...DEFAULT_LIMITS, cpu: 3 } });
    const [a, b] = (await s.enqueue('t', 'cpu', 2)) as [string, string];
    const [c] = (await s.enqueue('t', 'cpu')) as [string];
    await s.scheduler.start();
    h.runOf(a).reject(new JobError('provider_timeout'));
    await flush();
    expect(s.timers).toHaveLength(1);
    const timer = s.timers[0]!;

    const stopping = s.scheduler.stop();
    await flush();
    const runB = h.runOf(b);
    const runC = h.runOf(c);
    runB.reject(new Error('late'));
    runC.resolve();
    await stopping;
    expect(s.timers).toHaveLength(0);
    expect(s.row(b).status).toBe('queued');
    expect(s.row(c).status).toBe('succeeded');
    const count = s.calls.n;

    runC.reject(new Error('settled twice'));
    runB.resolve();
    timer.fn();
    s.scheduler.wake();
    await s.scheduler.cancel(a);
    await s.scheduler.cancel(c);
    await s.scheduler.stop();
    await flush();
    expect(s.calls.n).toBe(count);
  });
});
