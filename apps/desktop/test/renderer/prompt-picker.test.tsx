import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IpcRequest, IpcResponse } from '@assetforge/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { PromptPicker } from '../../src/renderer/src/components/PromptPicker';
import {
  NO_MATCHING_PROMPTS_TEXT,
  NO_PROMPTS_TEXT,
  PROMPTS_LABEL,
  SEARCH_PROMPTS_LABEL,
} from '../../src/renderer/src/labels';
import { deferred, fakePrompts, installFakeApi, promptDetail } from './fake-api';

afterEach(() => {
  vi.useRealTimers();
});

function install(
  seed = [
    promptDetail({ title: 'Hero shot' }),
    promptDetail({ title: 'Close-up', content: 'Close-up of the {{View}}' }),
  ],
) {
  const store = fakePrompts(seed);
  const api = installFakeApi(store.handlers);
  const lists = () =>
    api.calls.filter((c) => c.channel === 'prompts:list').map((c) => c.request as IpcRequest<'prompts:list'>);
  return { api, seed, lists };
}

const picker = () => screen.getByRole('dialog', { name: PROMPTS_LABEL });

it('lists the prompts and searches after the debounce', async () => {
  const { lists } = install();
  render(<PromptPicker onPick={async () => {}} onClose={() => {}} />);
  await within(picker()).findByText('Hero shot');
  expect(within(picker()).getByText('Close-up')).toBeTruthy();
  expect(lists()[0]).toEqual({ offset: 0, limit: 60 });

  vi.useFakeTimers({ shouldAdvanceTime: true });
  const search = within(picker()).getByRole('searchbox', { name: SEARCH_PROMPTS_LABEL });
  for (const text of ['c', 'cl', 'close ']) fireEvent.change(search, { target: { value: text } });
  act(() => vi.advanceTimersByTime(249));
  expect(lists().some((r) => r.query !== undefined)).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  await waitFor(() => expect(lists().at(-1)).toEqual({ offset: 0, limit: 60, query: 'close' }));
  await waitFor(() => expect(within(picker()).queryByText('Hero shot')).toBeNull());
  expect(within(picker()).getByText('Close-up')).toBeTruthy();

  fireEvent.change(search, { target: { value: 'nothing like it' } });
  await within(picker()).findByText(NO_MATCHING_PROMPTS_TEXT);
});

it('a search answer that arrives after a newer search is dropped', async () => {
  const { api, seed, lists } = install();
  const store = fakePrompts(seed);
  const slow = deferred<IpcResponse<'prompts:list'>>();
  api.set('prompts:list', (request) =>
    request.query === 'hero' ? slow.promise : store.handlers['prompts:list'](request),
  );
  render(<PromptPicker onPick={async () => {}} onClose={() => {}} />);
  await within(picker()).findByText('Hero shot');
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const search = within(picker()).getByRole('searchbox', { name: SEARCH_PROMPTS_LABEL });
  fireEvent.change(search, { target: { value: 'hero' } });
  act(() => vi.advanceTimersByTime(250));
  await waitFor(() => expect(lists().at(-1)?.query).toBe('hero'));
  fireEvent.change(search, { target: { value: 'close' } });
  act(() => vi.advanceTimersByTime(250));
  await waitFor(() => expect(within(picker()).queryByText('Hero shot')).toBeNull());
  expect(within(picker()).getByText('Close-up')).toBeTruthy();
  await act(async () =>
    slow.resolve(
      store.handlers['prompts:list']({ query: 'hero', offset: 0, limit: 60 }) as IpcResponse<'prompts:list'>,
    ),
  );
  expect(within(picker()).queryByText('Hero shot')).toBeNull();
  expect(within(picker()).getByText('Close-up')).toBeTruthy();
});

it('an empty library says so', async () => {
  install([]);
  render(<PromptPicker onPick={async () => {}} onClose={() => {}} />);
  await within(picker()).findByText(NO_PROMPTS_TEXT);
});

it('choosing a row hands its id over, by click and by Enter', async () => {
  const { seed } = install();
  const onPick = vi.fn(async () => {});
  render(<PromptPicker onPick={onPick} onClose={() => {}} />);
  const user = userEvent.setup();
  await user.click(await within(picker()).findByText('Close-up'));
  expect(onPick).toHaveBeenCalledWith(seed[1]!.id);
  within(picker())
    .getByRole('option', { name: /Hero shot/ })
    .focus();
  await user.keyboard('{Enter}');
  expect(onPick).toHaveBeenLastCalledWith(seed[0]!.id);
});

it('a failed pick shows its message in the picker', async () => {
  install();
  render(
    <PromptPicker
      onPick={async () => {
        throw new Error('This prompt does not exist');
      }}
      onClose={() => {}}
    />,
  );
  await userEvent.setup().click(await within(picker()).findByText('Hero shot'));
  expect((await within(picker()).findByRole('alert')).textContent).toBe('This prompt does not exist');
});
