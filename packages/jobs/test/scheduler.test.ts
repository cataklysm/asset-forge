import type { ResourceClass } from '@assetforge/contracts';
import { JobError, type Job, type JobHandler, type JobRepository } from '@assetforge/core';
import { describe, expect, it } from 'vitest';
import { InMemoryJobRepository } from '../../core/test/memory-jobs.js';
import {
  DEFAULT_LIMITS,
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  createPauseGate,
  createScheduler,
  type PauseGate,
  type Scheduler,
} from '../src/index.js';

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
  pause?: PauseGate;
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
    ...(o.pause ? { pause: o.pause } : {}),
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
  const enqueue = async (type: string, resourceClass: ResourceClass, count = 1, lane: string | null = null): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `job-${String(++seq).padStart(3, '0')}`;
      await fake.enqueue({ jobs: [{ id, type, resourceClass, fileId: null, lane, payload: { version: 1 }, dedupeKey: null }], now: iso() });
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
    expect(error.message).toBe('The provider rejected the request');
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
    expect(r.errorMessage).toBe('The provider did not answer in time');
    expect(s.timers).toHaveLength(0);
  });

  it('fails a non-retryable code at once', async () => {
    const h = controlled('remote_api');
    const s = setup({ handlers: { t: h.handler } });
    const [id] = (await s.enqueue('t', 'remote_api')) as [string];
    await s.scheduler.start();
    h.runOf(id).reject(new JobError('provider_rejected'));
    await flush();
    expect(s.row(id)).toMatchObject({ status: 'failed', attempt: 1, errorCode: 'provider_rejected', errorMessage: 'The provider rejected the request' });
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

  it('recovers once when start is called twice without waiting', async () => {
    const h = controlled('cpu');
    // A later listing answers later, so a second recovery would see the job the first start already launched.
    let listings = 0;
    const s = setup({
      handlers: { t: h.handler },
      repo: (fake) =>
        new Proxy(fake, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver) as unknown;
            if (prop !== 'listByStatus' || typeof value !== 'function') return value;
            return async (...args: unknown[]) => {
              const ticks = listings++ * 10;
              for (let i = 0; i < ticks; i++) await new Promise((resolve) => setImmediate(resolve));
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        }),
    });
    const [id] = (await s.enqueue('t', 'cpu')) as [string];
    await s.fake.claimNext({ resourceClass: 'cpu', types: ['t'], now: s.iso() });

    await Promise.all([s.scheduler.start(), s.scheduler.start()]);
    await flush();
    expect(h.runs).toHaveLength(1);
    expect(s.row(id)).toMatchObject({ status: 'running', attempt: 1 });
    h.runOf(id).resolve();
    await flush();
    expect(s.row(id).status).toBe('succeeded');
    expect(h.runs).toHaveLength(1);
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

describe('createScheduler with a purged job row', () => {
  for (const outcome of ['succeeds', 'fails'] as const) {
    it(`a run whose job row was removed settles without an error and frees its slot (${outcome})`, async () => {
      const h = controlled('cpu');
      const s = setup({ handlers: { t: h.handler }, limits: { ...DEFAULT_LIMITS, cpu: 1 } });
      const [first, second] = await s.enqueue('t', 'cpu', 2);
      await s.scheduler.start();
      expect(s.row(first!).status).toBe('running');

      // As when the file of the job is purged while its handler runs: the row goes with it.
      s.fake.rows.splice(s.fake.rows.indexOf(s.row(first!)), 1);
      if (outcome === 'succeeds') h.runOf(first!).resolve();
      // A retryable failure, so the scheduler tries `scheduleRetry` on the missing row.
      else h.runOf(first!).reject(new JobError('provider_unreachable'));
      await flush();

      expect(s.fake.rows.some((r) => r.id === first)).toBe(false);
      expect(s.row(second!).status).toBe('running');
      expect(s.logged).toEqual([]);
    });
  }
});

describe('createScheduler with a pause gate', () => {
  const gpuLimit = { ...DEFAULT_LIMITS, local_gpu: 1 };

  /** Fails the run of a job and lets the scheduler settle it. */
  async function failRun(h: ReturnType<typeof controlled>, id: string, error: unknown): Promise<void> {
    h.runOf(id).reject(error);
    await flush();
  }

  it('pauses a class after three provider-down runs and claims neither queued nor due retry_wait jobs', async () => {
    const gpu = controlled('local_gpu');
    const cpu = controlled('cpu');
    const pause = createPauseGate({});
    const s = setup({ handlers: { gpu: gpu.handler, cpu: cpu.handler }, limits: gpuLimit, pause });
    const [a, b, c, d] = (await s.enqueue('gpu', 'local_gpu', 4)) as [string, string, string, string];
    await s.scheduler.start();

    await failRun(gpu, a, new JobError('provider_unreachable'));
    expect(gpu.runs.at(-1)!.job.id).toBe(b);
    await failRun(gpu, b, new JobError('provider_unavailable'));
    expect(gpu.runs.at(-1)!.job.id).toBe(c);
    expect(pause.reason('local_gpu', null)).toBeNull();
    await failRun(gpu, c, new JobError('provider_timeout'));

    expect(pause.reason('local_gpu', null)).toBe('provider_timeout');
    // The tripping job follows its normal path and keeps its attempt.
    expect(s.row(c)).toMatchObject({ status: 'retry_wait', attempt: 1, errorCode: 'provider_timeout' });
    expect(s.row(d)).toMatchObject({ status: 'queued', attempt: 0 });
    expect(gpu.runs).toHaveLength(3);
    expect(s.timers).toHaveLength(0);

    s.advance(60_000);
    s.scheduler.wake();
    await flush();
    expect(gpu.runs).toHaveLength(3);
    for (const id of [a, b, c]) expect(s.row(id)).toMatchObject({ status: 'retry_wait', attempt: 1 });

    // Another class keeps running.
    const [k] = (await s.enqueue('cpu', 'cpu')) as [string];
    s.scheduler.wake();
    await flush();
    expect(cpu.runs.map((r) => r.job.id)).toEqual([k]);
    expect(gpu.runs).toHaveLength(3);
  });

  it('continues after resume and wake', async () => {
    const gpu = controlled('local_gpu');
    const pause = createPauseGate({});
    const s = setup({ handlers: { gpu: gpu.handler }, limits: gpuLimit, pause });
    const [a, b] = (await s.enqueue('gpu', 'local_gpu', 2)) as [string, string];
    await s.scheduler.start();
    await failRun(gpu, a, new JobError('provider_unauthorized'));
    expect(s.row(a)).toMatchObject({ status: 'failed', errorCode: 'provider_unauthorized' });
    expect(pause.reason('local_gpu', null)).toBe('provider_unauthorized');
    expect(s.row(b).status).toBe('queued');

    pause.resume('local_gpu', null);
    await flush();
    expect(gpu.runs).toHaveLength(1);
    s.scheduler.wake();
    await flush();
    expect(gpu.runs.map((r) => r.job.id)).toEqual([a, b]);
    expect(s.row(b)).toMatchObject({ status: 'running', attempt: 1 });
  });

  it('continues a paused retry_wait job with its attempt count after resume', async () => {
    const gpu = controlled('local_gpu');
    const pause = createPauseGate({ threshold: 1 });
    const s = setup({ handlers: { gpu: gpu.handler }, limits: gpuLimit, pause });
    const [a] = (await s.enqueue('gpu', 'local_gpu')) as [string];
    await s.scheduler.start();
    await failRun(gpu, a, new JobError('provider_unreachable'));
    expect(s.row(a)).toMatchObject({ status: 'retry_wait', attempt: 1 });
    expect(s.timers).toHaveLength(0);

    pause.resume('local_gpu', null);
    s.scheduler.wake();
    await flush();
    expect(s.timers.map((x) => x.ms)).toEqual([5_000]);
    s.advance(5_000);
    await s.fireTimer();
    expect(s.row(a)).toMatchObject({ status: 'running', attempt: 2 });
  });

  it('pauses at once on provider_not_configured', async () => {
    const gpu = controlled('local_gpu');
    const pause = createPauseGate({});
    const s = setup({ handlers: { gpu: gpu.handler }, limits: gpuLimit, pause });
    const [a, b] = (await s.enqueue('gpu', 'local_gpu', 2)) as [string, string];
    await s.scheduler.start();
    await failRun(gpu, a, new JobError('provider_not_configured'));
    expect(pause.reason('local_gpu', null)).toBe('provider_not_configured');
    expect(s.row(b).status).toBe('queued');
    expect(gpu.runs).toHaveLength(1);
  });

  it('does not pause when a success comes between provider-down runs', async () => {
    const gpu = controlled('local_gpu');
    const pause = createPauseGate({});
    const s = setup({ handlers: { gpu: gpu.handler }, limits: gpuLimit, pause });
    const ids = await s.enqueue('gpu', 'local_gpu', 5);
    await s.scheduler.start();
    await failRun(gpu, ids[0]!, new JobError('provider_unreachable'));
    await failRun(gpu, ids[1]!, new JobError('provider_unreachable'));
    gpu.runOf(ids[2]!).resolve();
    await flush();
    await failRun(gpu, ids[3]!, new JobError('provider_unreachable'));
    expect(pause.reason('local_gpu', null)).toBeNull();
    expect(gpu.runs.at(-1)!.job.id).toBe(ids[4]);
  });

  it('lets running jobs finish when their class pauses', async () => {
    const gpu = controlled('local_gpu');
    const pause = createPauseGate({});
    const s = setup({ handlers: { gpu: gpu.handler }, limits: { ...DEFAULT_LIMITS, local_gpu: 2 }, pause });
    const [a, b, c] = (await s.enqueue('gpu', 'local_gpu', 3)) as [string, string, string];
    await s.scheduler.start();
    await failRun(gpu, a, new JobError('provider_unauthorized'));
    expect(pause.reason('local_gpu', null)).toBe('provider_unauthorized');
    expect(s.row(b).status).toBe('running');
    expect(gpu.runOf(b).signal.aborted).toBe(false);

    gpu.runOf(b).resolve();
    await flush();
    expect(s.row(b).status).toBe('succeeded');
    expect(s.row(c).status).toBe('queued');
    expect(pause.reason('local_gpu', null)).toBe('provider_unauthorized');
  });

  it('keeps the pause for a second scheduler handed the same gate', async () => {
    const gpu = controlled('local_gpu');
    const pause = createPauseGate({});
    const s = setup({ handlers: { gpu: gpu.handler }, limits: gpuLimit, pause });
    const [a, b] = (await s.enqueue('gpu', 'local_gpu', 2)) as [string, string];
    await s.scheduler.start();
    await failRun(gpu, a, new JobError('provider_unauthorized'));
    await s.scheduler.stop();

    const next = createScheduler({
      jobs: s.fake,
      handlers: { gpu: gpu.handler },
      limits: gpuLimit,
      pause,
      now: () => new Date(s.iso()),
      setTimer: () => null,
      clearTimer: () => {},
    });
    await next.start();
    await flush();
    expect(gpu.runs).toHaveLength(1);
    expect(s.row(b).status).toBe('queued');

    pause.resume('local_gpu', null);
    next.wake();
    await flush();
    expect(gpu.runs.map((r) => r.job.id)).toEqual([a, b]);
    gpu.runOf(b).resolve();
    await next.stop();
    expect(s.row(b).status).toBe('succeeded');
  });

  it('records ok, the JobError code, or other for every run end', async () => {
    const seen: [ResourceClass, string | null, string][] = [];
    const spy: PauseGate = {
      reason: () => null,
      record: (rc, lane, outcome) => void seen.push([rc, lane, outcome]),
      resume: () => {},
      paused: () => [],
    };
    const cpu = controlled('cpu');
    const s = setup({ handlers: { t: cpu.handler }, limits: { ...DEFAULT_LIMITS, cpu: 5 }, pause: spy });
    const [ok, coded, plain, cancelled, released] = (await s.enqueue('t', 'cpu', 5)) as [string, string, string, string, string];
    await s.scheduler.start();

    cpu.runOf(ok).resolve();
    await flush();
    await failRun(cpu, coded, new JobError('invalid_response'));
    await failRun(cpu, plain, new Error('boom'));
    await s.scheduler.cancel(cancelled);
    await failRun(cpu, cancelled, new JobError('provider_unauthorized'));
    const stopping = s.scheduler.stop();
    await flush();
    cpu.runOf(released).reject(new JobError('provider_unreachable'));
    await stopping;

    expect(seen).toEqual([
      ['cpu', null, 'ok'],
      ['cpu', null, 'invalid_response'],
      ['cpu', null, 'other'],
      ['cpu', null, 'other'],
      ['cpu', null, 'other'],
    ]);
    expect(s.row(released).status).toBe('queued');
  });

  it('logs a gate that throws and still stores the outcome', async () => {
    const cpu = controlled('cpu');
    const failure = new Error('gate broke');
    const broken: PauseGate = {
      reason: () => null,
      record: () => {
        throw failure;
      },
      resume: () => {},
      paused: () => [],
    };
    const s = setup({ handlers: { t: cpu.handler }, pause: broken });
    const [id] = (await s.enqueue('t', 'cpu')) as [string];
    await s.scheduler.start();
    cpu.runOf(id).resolve();
    await flush();
    expect(s.row(id).status).toBe('succeeded');
    expect(s.logged.map((l) => l.cause)).toEqual([failure]);
  });

  it('fires the gate onChange on pause and on resume only', async () => {
    const gpu = controlled('local_gpu');
    const changes = { n: 0 };
    const pause = createPauseGate({ onChange: () => changes.n++ });
    const s = setup({ handlers: { gpu: gpu.handler }, limits: gpuLimit, pause });
    const [a, b] = (await s.enqueue('gpu', 'local_gpu', 2)) as [string, string];
    await s.scheduler.start();
    gpu.runOf(a).resolve();
    await flush();
    expect(changes.n).toBe(0);
    await failRun(gpu, b, new JobError('provider_not_configured'));
    expect(changes.n).toBe(1);
    pause.resume('local_gpu', null);
    expect(changes.n).toBe(2);
  });
});

describe('createScheduler with lanes', () => {
  const gpuLimit = { ...DEFAULT_LIMITS, local_gpu: 1 };

  it('holds the limit per lane: a1 and b1 run together, a2 starts when a1 settles', async () => {
    const gpu = controlled('local_gpu');
    const s = setup({ handlers: { gpu: gpu.handler }, limits: gpuLimit });
    const [a1, a2] = (await s.enqueue('gpu', 'local_gpu', 2, 'a')) as [string, string];
    const [b1] = (await s.enqueue('gpu', 'local_gpu', 1, 'b')) as [string];
    await s.scheduler.start();
    expect(gpu.runs.map((r) => r.job.id)).toEqual([a1, b1]);
    expect(s.row(a2).status).toBe('queued');

    gpu.runOf(b1).resolve();
    await flush();
    expect(gpu.runs).toHaveLength(2);
    expect(s.row(a2).status).toBe('queued');

    gpu.runOf(a1).resolve();
    await flush();
    expect(gpu.runs.map((r) => r.job.id)).toEqual([a1, b1, a2]);
    expect(s.row(a2).status).toBe('running');
  });

  it('keeps lane null apart from named lanes', async () => {
    const gpu = controlled('local_gpu');
    const s = setup({ handlers: { gpu: gpu.handler }, limits: gpuLimit });
    const [n1, n2] = (await s.enqueue('gpu', 'local_gpu', 2)) as [string, string];
    const [a1] = (await s.enqueue('gpu', 'local_gpu', 1, 'a')) as [string];
    await s.scheduler.start();
    expect(gpu.runs.map((r) => r.job.id)).toEqual([n1, a1]);
    expect(s.row(n2).status).toBe('queued');
  });

  it('keeps b running while lane a is paused, and runs a after resume and wake', async () => {
    const gpu = controlled('local_gpu');
    const pause = createPauseGate({});
    const s = setup({ handlers: { gpu: gpu.handler }, limits: gpuLimit, pause });
    const [a1, a2] = (await s.enqueue('gpu', 'local_gpu', 2, 'a')) as [string, string];
    const [b1, b2] = (await s.enqueue('gpu', 'local_gpu', 2, 'b')) as [string, string];
    await s.scheduler.start();
    expect(gpu.runs.map((r) => r.job.id)).toEqual([a1, b1]);

    gpu.runOf(a1).reject(new JobError('provider_unauthorized'));
    await flush();
    expect(pause.reason('local_gpu', 'a')).toBe('provider_unauthorized');
    expect(pause.reason('local_gpu', 'b')).toBeNull();
    expect(s.row(a2).status).toBe('queued');

    gpu.runOf(b1).resolve();
    await flush();
    expect(s.row(b2).status).toBe('running');
    gpu.runOf(b2).resolve();
    await flush();
    expect(s.row(a2).status).toBe('queued');

    pause.resume('local_gpu', 'a');
    await flush();
    expect(s.row(a2).status).toBe('queued');
    s.scheduler.wake();
    await flush();
    expect(s.row(a2)).toMatchObject({ status: 'running', attempt: 1 });
  });

  it('arms no timer for a retry_wait job in a paused lane, and one for a free lane', async () => {
    const gpu = controlled('local_gpu');
    const pause = createPauseGate({});
    const s = setup({ handlers: { gpu: gpu.handler }, limits: gpuLimit, pause });
    const [a] = (await s.enqueue('gpu', 'local_gpu', 1, 'a')) as [string];
    const [b] = (await s.enqueue('gpu', 'local_gpu', 1, 'b')) as [string];
    Object.assign(s.row(a), { status: 'retry_wait', attempt: 1, runAfter: new Date(Date.parse(s.iso()) + 5_000).toISOString() });
    Object.assign(s.row(b), { status: 'retry_wait', attempt: 1, runAfter: new Date(Date.parse(s.iso()) + 30_000).toISOString() });
    pause.record('local_gpu', 'a', 'provider_unauthorized');
    await s.scheduler.start();
    expect(s.timers.map((x) => x.ms)).toEqual([30_000]);

    pause.record('local_gpu', 'b', 'provider_unauthorized');
    s.scheduler.wake();
    await flush();
    expect(s.timers).toHaveLength(0);

    pause.resume('local_gpu', 'a');
    s.scheduler.wake();
    await flush();
    expect(s.timers.map((x) => x.ms)).toEqual([5_000]);
  });

  it('arms no timer for a retry_wait job of a full lane', async () => {
    const gpu = controlled('local_gpu');
    const s = setup({ handlers: { gpu: gpu.handler }, limits: gpuLimit });
    const [a1, a2] = (await s.enqueue('gpu', 'local_gpu', 2, 'a')) as [string, string];
    Object.assign(s.row(a2), { status: 'retry_wait', attempt: 1, runAfter: new Date(Date.parse(s.iso()) + 5_000).toISOString() });
    await s.scheduler.start();
    expect(s.row(a1).status).toBe('running');
    expect(s.timers).toHaveLength(0);
  });

  it('pauses only the lane of a job failing provider_not_configured', async () => {
    const gpu = controlled('local_gpu');
    const pause = createPauseGate({});
    const s = setup({ handlers: { gpu: gpu.handler }, limits: gpuLimit, pause });
    const [a1, a2] = (await s.enqueue('gpu', 'local_gpu', 2, 'a')) as [string, string];
    const [n1, n2] = (await s.enqueue('gpu', 'local_gpu', 2)) as [string, string];
    await s.scheduler.start();
    gpu.runOf(a1).reject(new JobError('provider_not_configured'));
    await flush();
    expect(pause.paused('local_gpu')).toEqual([{ lane: 'a', reason: 'provider_not_configured' }]);
    gpu.runOf(n1).resolve();
    await flush();
    expect(s.row(n2).status).toBe('running');
    expect(s.row(a2).status).toBe('queued');
  });

  it('records the run end under the lane of its job', async () => {
    const seen: [ResourceClass, string | null, string][] = [];
    const spy: PauseGate = {
      reason: () => null,
      record: (rc, lane, outcome) => void seen.push([rc, lane, outcome]),
      resume: () => {},
      paused: () => [],
    };
    const gpu = controlled('local_gpu');
    const s = setup({ handlers: { gpu: gpu.handler }, limits: gpuLimit, pause: spy });
    const [a] = (await s.enqueue('gpu', 'local_gpu', 1, 'a')) as [string];
    const [n] = (await s.enqueue('gpu', 'local_gpu')) as [string];
    await s.scheduler.start();
    gpu.runOf(a).reject(new JobError('provider_timeout'));
    await flush();
    gpu.runOf(n).resolve();
    await flush();
    expect(seen).toEqual([
      ['local_gpu', 'a', 'provider_timeout'],
      ['local_gpu', null, 'ok'],
    ]);
  });
});
