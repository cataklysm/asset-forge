import { act, render, screen } from '@testing-library/react';
import type { JobSummary } from '@assetforge/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_POLL_MS, JobsProvider, useJobs, type JobState } from '../../src/renderer/src/jobs-context';
import { deferred, fakeError, installFakeApi } from './fake-api';

const IDLE: JobSummary = { queued: 0, running: 0, waiting: 0, failed: 0, cancelled: 0, succeeded: 0, changes: 0 };

let seen: JobState[] = [];

function Probe() {
  const state = useJobs();
  seen.push(state);
  return (
    <output aria-label="Jobs">{`active ${state.active} changes ${state.changeToken} results ${state.resultToken}`}</output>
  );
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

  it('changeToken rises only when changes moved; resultToken only when succeeded rose as well', async () => {
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
    expect(latest().resultToken).toBe(0);

    // Nothing moved.
    await tick();
    expect(latest().changeToken).toBe(0);

    // A job started: changes moved, nothing succeeded.
    next = { ...IDLE, queued: 1, running: 1, changes: 6 };
    await tick();
    expect(latest().changeToken).toBe(1);
    expect(latest().resultToken).toBe(0);

    // A job succeeded.
    next = { ...IDLE, queued: 1, succeeded: 1, changes: 7 };
    await tick();
    expect(latest().changeToken).toBe(2);
    expect(latest().resultToken).toBe(1);

    // Finished jobs cleared: the counts drop without a status change.
    next = { ...IDLE, queued: 1, changes: 7 };
    await tick();
    expect(latest().summary).toEqual(next);
    expect(latest().changeToken).toBe(2);
    expect(latest().resultToken).toBe(1);

    // succeeded rose without changes moving: no result.
    next = { ...IDLE, queued: 1, succeeded: 3, changes: 7 };
    await tick();
    expect(latest().changeToken).toBe(2);
    expect(latest().resultToken).toBe(1);
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
    expect(latest().resultToken).toBe(1);
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

  it('outside a provider useJobs gives the empty state with a no-op refresh', () => {
    const api = installFakeApi({});
    render(<Probe />);
    expect(latest()).toMatchObject({ summary: null, active: 0, changeToken: 0, resultToken: 0 });
    act(() => latest().refresh());
    expect(api.calls).toHaveLength(0);
  });
});
