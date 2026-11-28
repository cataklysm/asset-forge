import { act, render, screen } from '@testing-library/react';
import type { Changes, JobSummary } from '@assetforge/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onStorageUnreachable } from '../../src/renderer/src/api';
import { JOB_POLL_MS, JobsProvider, useChanges, useJobs, type JobState } from '../../src/renderer/src/jobs-context';
import { deferred, fakeError, installFakeApi, noChanges } from './fake-api';

const IDLE: JobSummary = {
  queued: 0,
  running: 0,
  waiting: 0,
  failed: 0,
  cancelled: 0,
  succeeded: 0,
  changes: 0,
  paused: [],
  pausedHosts: [],
};

let seen: JobState[] = [];

function Probe() {
  const state = useJobs();
  seen.push(state);
  return <output aria-label="Jobs">{`active ${state.active} changes ${state.changeToken}`}</output>;
}

const latest = () => seen.at(-1)!;

function summaryCalls(api: ReturnType<typeof installFakeApi>) {
  return api.calls.filter((c) => c.channel === 'jobs:summary').length;
}

/** Lets the pending fake IPC answers settle. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
  });
}

describe('JobsProvider', () => {
  beforeEach(() => {
    seen = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls at once and again after 2000 ms, never overlapping', async () => {
    expect(JOB_POLL_MS).toBe(2000);
    const pending = deferred<JobSummary>();
    let answer: () => JobSummary | Promise<JobSummary> = () => pending.promise;
    const api = installFakeApi({ 'jobs:summary': () => answer() });
    render(
      <JobsProvider>
        <Probe />
      </JobsProvider>,
    );
    expect(summaryCalls(api)).toBe(1);
    expect(latest().summary).toBeNull();
    expect(latest().active).toBe(0);

    // Still pending at the next tick: not doubled.
    await tick();
    await tick();
    expect(summaryCalls(api)).toBe(1);

    answer = () => ({ ...IDLE, queued: 1 });
    await act(async () => pending.resolve({ ...IDLE, queued: 2, running: 1, waiting: 1 }));
    expect(latest().summary).toEqual({ ...IDLE, queued: 2, running: 1, waiting: 1 });
    expect(latest().active).toBe(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS - 1);
    });
    expect(summaryCalls(api)).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(summaryCalls(api)).toBe(2);
    expect(latest().active).toBe(1);
  });

  it('a storage_unreachable answer to the polls does not raise the storage banner', async () => {
    const reported = vi.fn();
    const unsubscribe = onStorageUnreachable(reported);
    let summaryFails = true;
    const api = installFakeApi({
      'jobs:summary': () => {
        if (summaryFails) throw fakeError('storage_unreachable');
        return IDLE;
      },
      'changes:since': () => {
        throw fakeError('storage_unreachable');
      },
    });
    render(
      <JobsProvider>
        <Probe />
      </JobsProvider>,
    );
    await settle();
    await tick();
    summaryFails = false;
    await tick();
    expect(api.calls.some((c) => c.channel === 'changes:since')).toBe(true);
    expect(reported).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('changeToken rises only when changes moved', async () => {
    let next: JobSummary = { ...IDLE, queued: 2, changes: 5 };
    installFakeApi({ 'jobs:summary': () => next });
    render(
      <JobsProvider>
        <Probe />
      </JobsProvider>,
    );
    await settle();
    // The first answer is the baseline.
    expect(latest().changeToken).toBe(0);

    // Nothing moved.
    await tick();
    expect(latest().changeToken).toBe(0);

    // A job started: changes moved, nothing succeeded.
    next = { ...IDLE, queued: 1, running: 1, changes: 6 };
    await tick();
    expect(latest().changeToken).toBe(1);

    // A job succeeded.
    next = { ...IDLE, queued: 1, succeeded: 1, changes: 7 };
    await tick();
    expect(latest().changeToken).toBe(2);

    // Finished jobs cleared: the counts drop without a status change.
    next = { ...IDLE, queued: 1, changes: 7 };
    await tick();
    expect(latest().summary).toEqual(next);
    expect(latest().changeToken).toBe(2);

    // succeeded rose without changes moving: no change.
    next = { ...IDLE, queued: 1, succeeded: 3, changes: 7 };
    await tick();
    expect(latest().changeToken).toBe(2);
  });

  it('an unchanged answer keeps the same state object', async () => {
    installFakeApi({ 'jobs:summary': () => ({ ...IDLE, queued: 1 }) });
    render(
      <JobsProvider>
        <Probe />
      </JobsProvider>,
    );
    await settle();
    const before = latest();
    await tick();
    expect(latest()).toBe(before);
  });

  it('a new pause list is taken, an equal one keeps the state object', async () => {
    const a = {
      providerId: '00000000-0000-4000-8000-00000000a001',
      providerName: 'Local',
      kind: 'ollama',
      reason: 'provider_unreachable',
    } as const;
    const b = {
      providerId: '00000000-0000-4000-8000-00000000b001',
      providerName: 'RunPod',
      kind: 'ollama',
      reason: 'provider_unauthorized',
    } as const;
    let next: JobSummary = { ...IDLE, queued: 1, paused: [a] };
    installFakeApi({ 'jobs:summary': () => structuredClone(next) });
    render(
      <JobsProvider>
        <Probe />
      </JobsProvider>,
    );
    await settle();
    const before = latest();
    expect(before.summary?.paused).toEqual([a]);
    await tick();
    expect(latest()).toBe(before);

    next = { ...next, paused: [a, b] };
    await tick();
    expect(latest().summary?.paused).toEqual([a, b]);

    next = { ...next, paused: [a, { ...b, reason: 'provider_not_configured' }] };
    await tick();
    expect(latest().summary?.paused[1]?.reason).toBe('provider_not_configured');

    next = { ...next, paused: [] };
    await tick();
    expect(latest().summary?.paused).toEqual([]);
  });

  it('a rejected poll renders no alert, keeps the previous summary and the next tick polls again', async () => {
    let fail = false;
    const api = installFakeApi({
      'jobs:summary': () => {
        if (fail) throw fakeError('no_workspace_open');
        return { ...IDLE, running: 3, changes: 1 };
      },
    });
    render(
      <JobsProvider>
        <Probe />
      </JobsProvider>,
    );
    await settle();
    expect(latest().active).toBe(3);

    fail = true;
    await tick();
    expect(summaryCalls(api)).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(latest().summary).toEqual({ ...IDLE, running: 3, changes: 1 });
    expect(latest().active).toBe(3);

    // A rejected invoke as well.
    api.set('jobs:summary', () => Promise.reject(new Error('gone')));
    await tick();
    expect(summaryCalls(api)).toBe(3);
    expect(latest().active).toBe(3);

    api.set('jobs:summary', () => ({ ...IDLE, changes: 2, succeeded: 3 }));
    await tick();
    expect(summaryCalls(api)).toBe(4);
    expect(latest().active).toBe(0);
    expect(latest().changeToken).toBe(1);
  });

  it('refresh polls now, and once more after a poll that is still pending', async () => {
    const pending = deferred<JobSummary>();
    let answer: () => JobSummary | Promise<JobSummary> = () => ({ ...IDLE });
    const api = installFakeApi({ 'jobs:summary': () => answer() });
    render(
      <JobsProvider>
        <Probe />
      </JobsProvider>,
    );
    await settle();
    expect(summaryCalls(api)).toBe(1);

    answer = () => pending.promise;
    act(() => latest().refresh());
    expect(summaryCalls(api)).toBe(2);
    act(() => latest().refresh());
    act(() => latest().refresh());
    expect(summaryCalls(api)).toBe(2);

    answer = () => ({ ...IDLE, queued: 1, changes: 1 });
    await act(async () => pending.resolve({ ...IDLE }));
    await settle();
    expect(summaryCalls(api)).toBe(3);
    expect(latest().active).toBe(1);
    // The regular rhythm resumes after the last poll.
    await tick();
    expect(summaryCalls(api)).toBe(4);
  });

  it('unmounting stops polling, also with a poll still pending', async () => {
    const pending = deferred<JobSummary>();
    let answer: () => JobSummary | Promise<JobSummary> = () => ({ ...IDLE });
    const api = installFakeApi({ 'jobs:summary': () => answer() });
    const { unmount } = render(
      <JobsProvider>
        <Probe />
      </JobsProvider>,
    );
    await settle();
    answer = () => pending.promise;
    await tick();
    expect(summaryCalls(api)).toBe(2);
    unmount();
    await act(async () => pending.resolve({ ...IDLE, queued: 1, changes: 1 }));
    await tick();
    await tick();
    expect(summaryCalls(api)).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('useChanges', () => {
    let received: Changes[] = [];
    let renders = 0;

    function Listener() {
      renders += 1;
      useChanges((changes) => received.push(changes));
      return null;
    }

    beforeEach(() => {
      received = [];
      renders = 0;
    });

    const sinceCalls = (api: ReturnType<typeof installFakeApi>) =>
      api.calls.filter((c) => c.channel === 'changes:since').map((c) => c.request);

    it('asks after the first summary and after every poll in which changes moved, with the cursor answered last', async () => {
      let next: JobSummary = { ...IDLE, changes: 3 };
      let answers = 0;
      const api = installFakeApi({
        'jobs:summary': () => next,
        'changes:since': ({ cursor }) => {
          answers += 1;
          return cursor === null
            ? noChanges({ cursor: 'c1', reset: true })
            : noChanges({ cursor: `c${answers}`, fileIds: ['f1'] });
        },
      });
      render(
        <JobsProvider>
          <Listener />
        </JobsProvider>,
      );
      await settle();
      expect(sinceCalls(api)).toEqual([{ cursor: null }]);
      expect(received).toEqual([noChanges({ cursor: 'c1', reset: true })]);
      const rendersAfterFirst = renders;

      // Nothing moved: no request.
      await tick();
      expect(sinceCalls(api)).toHaveLength(1);

      next = { ...IDLE, changes: 4 };
      await tick();
      expect(sinceCalls(api)).toEqual([{ cursor: null }, { cursor: 'c1' }]);
      expect(received.at(-1)).toEqual(noChanges({ cursor: 'c2', fileIds: ['f1'] }));

      next = { ...IDLE, changes: 5 };
      await tick();
      expect(sinceCalls(api).at(-1)).toEqual({ cursor: 'c2' });
      expect(received).toHaveLength(3);
      // Delivering an answer renders nothing that only listens.
      expect(renders).toBe(rendersAfterFirst);
    });

    it('a rejected request keeps the cursor and asks again with the next poll, also when changes did not move', async () => {
      let fail = false;
      const api = installFakeApi({
        'jobs:summary': () => ({ ...IDLE, changes: fail ? 2 : 1 }),
        'changes:since': ({ cursor }) => {
          if (fail) throw fakeError('internal_error');
          return noChanges({ cursor: cursor === null ? 'c1' : 'c2', reset: cursor === null });
        },
      });
      render(
        <JobsProvider>
          <Listener />
        </JobsProvider>,
      );
      await settle();
      expect(received).toHaveLength(1);

      fail = true;
      await tick();
      expect(sinceCalls(api)).toEqual([{ cursor: null }, { cursor: 'c1' }]);
      expect(received).toHaveLength(1);

      // changes stays at 2, but the failed answer is still owed.
      fail = false;
      api.set('jobs:summary', () => ({ ...IDLE, changes: 2 }));
      await tick();
      expect(sinceCalls(api)).toEqual([{ cursor: null }, { cursor: 'c1' }, { cursor: 'c1' }]);
      expect(received.at(-1)?.cursor).toBe('c2');

      // Settled: no further request without a move.
      await tick();
      expect(sinceCalls(api)).toHaveLength(3);
    });

    it('the next poll waits for a pending change request; an unmounted listener receives nothing', async () => {
      const pending = deferred<Changes>();
      const api = installFakeApi({
        'jobs:summary': () => ({ ...IDLE }),
        'changes:since': () => pending.promise,
      });
      const { rerender } = render(
        <JobsProvider>
          <Listener />
        </JobsProvider>,
      );
      await settle();
      await tick();
      await tick();
      expect(summaryCalls(api)).toBe(1);

      rerender(<JobsProvider>{null}</JobsProvider>);
      await act(async () => pending.resolve(noChanges({ reset: true })));
      expect(received).toHaveLength(0);
      await tick();
      expect(summaryCalls(api)).toBe(2);
    });
  });

  it('outside a provider useJobs gives the empty state with a no-op refresh', () => {
    const api = installFakeApi({});
    render(<Probe />);
    expect(latest()).toMatchObject({ summary: null, active: 0, changeToken: 0 });
    act(() => latest().refresh());
    expect(api.calls).toHaveLength(0);
  });
});
