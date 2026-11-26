import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { AssetPicker } from '../../src/renderer/src/components/AssetPicker';
import { installFakeApi } from './fake-api';
import { assetSummary, pageOf } from './fixtures';

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
