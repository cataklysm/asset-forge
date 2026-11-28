import type { AssetList } from '@assetforge/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AssetPicker } from '../../src/renderer/src/components/AssetPicker';
import { deferred, installFakeApi } from './fake-api';
import { assetSummary, pageOf } from './fixtures';

/** The `query` of every `assets:list` request, '' for none. */
function queries(api: ReturnType<typeof installFakeApi>): string[] {
  return api.calls
    .filter((entry) => entry.channel === 'assets:list')
    .map((entry) => (entry.request as { query?: string }).query ?? '');
}

it('the suggestion popup is as wide as the picker and truncates long names with a title', async () => {
  const name = 'An extraordinarily long asset name that would never fit a narrow column';
  installFakeApi({ 'assets:list': () => pageOf([assetSummary({ name })]) });
  const user = userEvent.setup();
  render(<AssetPicker onPick={() => {}} />);
  await user.click(screen.getByRole('combobox', { name: 'Search assets' }));
  const option = await screen.findByRole('option');
  expect(option.getAttribute('title')).toBe(name);
  expect(option.className.split(/\s+/)).toContain('truncate');
  const popup = screen.getByRole('listbox', { name: 'Assets' }).parentElement!;
  const classes = popup.className.split(/\s+/);
  expect(classes).toEqual(expect.arrayContaining(['inset-x-0', 'min-w-0']));
  expect(classes).not.toContain('min-w-64');
});

it('typing searches once the input rests, never once per keystroke', async () => {
  const api = installFakeApi({
    'assets:list': ({ query }) => pageOf(query === 'oak' ? [assetSummary({ name: 'Oak tree' })] : []),
  });
  const user = userEvent.setup();
  render(<AssetPicker onPick={() => {}} />);
  await user.type(screen.getByRole('combobox', { name: 'Search assets' }), 'oak');
  expect(await screen.findByRole('option', { name: 'Oak tree' })).toBeTruthy();
  expect(queries(api)).toEqual(['', 'oak']);
});

it('an answer for an earlier text never replaces the answer for the current one', async () => {
  const slow = deferred<AssetList>();
  installFakeApi({
    'assets:list': ({ query }) => {
      if (query === 'a') return slow.promise;
      return pageOf(query === 'ab' ? [assetSummary({ name: 'Abacus' })] : []);
    },
  });
  const user = userEvent.setup();
  render(<AssetPicker onPick={() => {}} />);
  const input = screen.getByRole('combobox', { name: 'Search assets' });
  await user.type(input, 'a');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await user.type(input, 'b');
  expect(await screen.findByRole('option', { name: 'Abacus' })).toBeTruthy();
  slow.resolve(pageOf([assetSummary({ name: 'Apple' })]));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole('option', { name: 'Apple' })).toBeNull();
});

it('a pick hands on the asset and the excluded ones are never offered', async () => {
  const own = assetSummary({ name: 'Own' });
  const other = assetSummary({ name: 'Other' });
  installFakeApi({ 'assets:list': () => pageOf([own, other]) });
  const user = userEvent.setup();
  const onPick = vi.fn();
  render(<AssetPicker excludeIds={[own.id]} onPick={onPick} />);
  await user.click(screen.getByRole('combobox', { name: 'Search assets' }));
  await user.click(await screen.findByRole('option', { name: 'Other' }));
  await waitFor(() => expect(onPick).toHaveBeenCalledWith(other));
  expect(screen.queryByRole('option', { name: 'Own' })).toBeNull();
});
