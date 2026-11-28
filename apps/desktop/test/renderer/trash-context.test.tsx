import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TrashSummary } from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import {
  TRASH_SUMMARY_RETRIES,
  TRASH_SUMMARY_RETRY_MS,
  TrashProvider,
  useTrash,
} from '../../src/renderer/src/trash-context';
import { deferred, fakeError, installFakeApi } from './fake-api';

function Probe() {
  const { count, refresh } = useTrash();
  return (
    <div>
      <output aria-label="Count">{count === null ? 'none' : String(count)}</output>
      <button type="button" onClick={refresh}>
        Refresh
      </button>
    </div>
  );
}

const countText = () => screen.getByRole('status', { name: 'Count' }).textContent;
const summaryCalls = (api: ReturnType<typeof installFakeApi>) => api.calls.filter((c) => c.channel === 'trash:summary');

it('loads the count on mount', async () => {
  const api = installFakeApi({ 'trash:summary': () => ({ count: 4 }) });
  render(
    <TrashProvider>
      <Probe />
    </TrashProvider>,
  );
  expect(countText()).toBe('none');
  await waitFor(() => expect(countText()).toBe('4'));
  expect(summaryCalls(api)).toEqual([{ channel: 'trash:summary', request: {} }]);
});

it('refresh loads again', async () => {
  const user = userEvent.setup();
  let count = 1;
  const api = installFakeApi({ 'trash:summary': () => ({ count }) });
  render(
    <TrashProvider>
      <Probe />
    </TrashProvider>,
  );
  await waitFor(() => expect(countText()).toBe('1'));
  count = 2;
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(countText()).toBe('2'));
  expect(summaryCalls(api)).toHaveLength(2);
});

it('a refresh during a request loads once more afterwards', async () => {
  const user = userEvent.setup();
  const first = deferred<TrashSummary>();
  let count = 0;
  const api = installFakeApi({
    'trash:summary': () => {
      count += 1;
      return count === 1 ? first.promise : { count: 7 };
    },
  });
  render(
    <TrashProvider>
      <Probe />
    </TrashProvider>,
  );
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(summaryCalls(api)).toHaveLength(1);
  await act(async () => first.resolve({ count: 3 }));
  await waitFor(() => expect(countText()).toBe('7'));
  expect(summaryCalls(api)).toHaveLength(2);
});

it('a failing request keeps the last count', async () => {
  const user = userEvent.setup();
  let fail = false;
  const api = installFakeApi({
    'trash:summary': () => {
      if (fail) throw fakeError('workspace_not_found');
      return { count: 5 };
    },
  });
  render(
    <TrashProvider>
      <Probe />
    </TrashProvider>,
  );
  await waitFor(() => expect(countText()).toBe('5'));
  fail = true;
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(summaryCalls(api)).toHaveLength(2));
  expect(countText()).toBe('5');
});

it('a failing first request is tried again a few times', async () => {
  vi.useFakeTimers();
  try {
    let attempts = 0;
    const api = installFakeApi({
      'trash:summary': () => {
        attempts += 1;
        if (attempts <= 2) throw fakeError('internal_error');
        return { count: 6 };
      },
    });
    render(
      <TrashProvider>
        <Probe />
      </TrashProvider>,
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(summaryCalls(api)).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(TRASH_SUMMARY_RETRY_MS));
    expect(summaryCalls(api)).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(TRASH_SUMMARY_RETRY_MS));
    expect(summaryCalls(api)).toHaveLength(3);
    expect(countText()).toBe('6');
  } finally {
    vi.useRealTimers();
  }
});

it('a lasting failure stops trying after the retries', async () => {
  vi.useFakeTimers();
  try {
    const api = installFakeApi({
      'trash:summary': () => {
        throw fakeError('internal_error');
      },
    });
    render(
      <TrashProvider>
        <Probe />
      </TrashProvider>,
    );
    await act(async () => vi.advanceTimersByTimeAsync(TRASH_SUMMARY_RETRY_MS * (TRASH_SUMMARY_RETRIES + 3)));
    expect(summaryCalls(api)).toHaveLength(1 + TRASH_SUMMARY_RETRIES);
    expect(countText()).toBe('none');
  } finally {
    vi.useRealTimers();
  }
});

it('useTrash outside a provider is inert', async () => {
  const user = userEvent.setup();
  const api = installFakeApi({ 'trash:summary': () => ({ count: 9 }) });
  render(<Probe />);
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(countText()).toBe('none');
  expect(summaryCalls(api)).toHaveLength(0);
});
