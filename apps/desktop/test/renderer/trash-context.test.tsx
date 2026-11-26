import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TrashSummary } from '@assetforge/contracts';
import { expect, it } from 'vitest';
import { TrashProvider, useTrash } from '../../src/renderer/src/trash-context';
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

it('useTrash outside a provider is inert', async () => {
  const user = userEvent.setup();
  const api = installFakeApi({ 'trash:summary': () => ({ count: 9 }) });
  render(<Probe />);
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(countText()).toBe('none');
  expect(summaryCalls(api)).toHaveLength(0);
});
