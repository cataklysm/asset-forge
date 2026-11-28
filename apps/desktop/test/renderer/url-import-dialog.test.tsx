import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MAX_IMPORT_URLS, type FileTarget } from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { UrlImportDialog } from '../../src/renderer/src/components/UrlImportDialog';
import { JobsProvider } from '../../src/renderer/src/jobs-context';
import { deferred, fakeError, installFakeApi, urlImportResultOf, type FakeHandlers } from './fake-api';

function setup(handlers: FakeHandlers = {}, target: FileTarget | null = null) {
  const api = installFakeApi({ 'files:importUrls': () => urlImportResultOf(), ...handlers });
  const onClose = vi.fn();
  render(
    <JobsProvider>
      <UrlImportDialog target={target} onClose={onClose} />
    </JobsProvider>,
  );
  return { api, onClose, user: userEvent.setup() };
}

const dialog = () => screen.getByRole('dialog', { name: 'Import from URLs' });
const field = () => within(dialog()).getByRole('textbox', { name: 'URLs' }) as HTMLTextAreaElement;
const importButton = () => within(dialog()).getByRole('button', { name: 'Import' }) as HTMLButtonElement;
const requests = (api: ReturnType<typeof setup>['api']) =>
  api.calls.filter((c) => c.channel === 'files:importUrls').map((c) => c.request);

/** Sets the textarea's value at once; typing thousands of lines is too slow. */
async function paste(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(field());
  await user.paste(text);
}

it('shows the field with its tooltip, Skip duplicates checked, and one button look', () => {
  setup();
  expect(field().getAttribute('title')).toBe('One address per line');
  const skip = within(dialog()).getByRole('checkbox', { name: 'Skip duplicates' }) as HTMLInputElement;
  expect(skip.checked).toBe(true);
  expect(skip.closest('label')?.getAttribute('title')).toBe('Identical content is not stored again');
  const buttons = within(dialog()).getAllByRole('button');
  expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Import']);
  expect(new Set(buttons.map((b) => b.className)).size).toBe(1);
  expect(importButton().disabled).toBe(true);
});

it('Import is disabled for whitespace only', async () => {
  const { user } = setup();
  await paste(user, '   \n\t\n  ');
  expect(importButton().disabled).toBe(true);
});

it('sends the lines as typed without a target, skipDuplicates true, trailing empty lines dropped', async () => {
  const { api, user } = setup();
  await paste(user, ' https://a.test/x.png\n\nhttps://b.test/y.png \n\n  \n');
  await user.click(importButton());
  await waitFor(() => expect(requests(api)).toHaveLength(1));
  expect(requests(api)[0]).toEqual({
    urls: [' https://a.test/x.png', '', 'https://b.test/y.png '],
    skipDuplicates: true,
  });
});

it('unchecking Skip duplicates sends false; the target is passed through', async () => {
  const target = { assetId: '11111111-1111-4111-8111-111111111111', role: 'concept' } as const;
  const { api, user } = setup({}, target);
  await user.click(within(dialog()).getByRole('checkbox', { name: 'Skip duplicates' }));
  await paste(user, 'https://a.test/x.png');
  await user.click(importButton());
  await waitFor(() => expect(requests(api)).toHaveLength(1));
  expect(requests(api)[0]).toEqual({ urls: ['https://a.test/x.png'], target, skipDuplicates: false });
});

it('the done state shows the counts above 0, Queued always, the invalid lines and Close', async () => {
  const { api, onClose, user } = setup({
    'files:importUrls': () =>
      urlImportResultOf({ queued: 0, alreadyImported: 2, alreadyQueued: 0, invalid: [{ line: 3, text: 'nope' }] }),
  });
  await paste(user, 'https://a.test/1\nhttps://a.test/2\nnope');
  const summaries = () => api.calls.filter((c) => c.channel === 'jobs:summary').length;
  await waitFor(() => expect(summaries()).toBeGreaterThan(0));
  const before = summaries();
  await user.click(importButton());

  expect(await within(dialog()).findByText('Queued 0')).toBeTruthy();
  expect(within(dialog()).getByText('Already imported 2')).toBeTruthy();
  expect(within(dialog()).queryByText(/Already queued/)).toBeNull();
  expect(within(dialog()).getByText('Not usable 1')).toBeTruthy();
  expect(within(within(dialog()).getByRole('list')).getByText('3: nope')).toBeTruthy();
  expect(within(dialog()).queryByRole('textbox')).toBeNull();
  await waitFor(() => expect(summaries()).toBeGreaterThan(before));

  const buttons = within(dialog()).getAllByRole('button');
  expect(buttons.map((b) => b.textContent)).toEqual(['Close']);
  await user.click(buttons[0]!);
  expect(onClose).toHaveBeenCalled();
});

it('shows every count line when all are above 0 and no list without invalid lines', async () => {
  const { user } = setup({
    'files:importUrls': () => urlImportResultOf({ queued: 4, alreadyImported: 1, alreadyQueued: 2, invalid: [] }),
  });
  await paste(user, 'https://a.test/1');
  await user.click(importButton());
  expect(await within(dialog()).findByText('Queued 4')).toBeTruthy();
  expect(within(dialog()).getByText('Already imported 1')).toBeTruthy();
  expect(within(dialog()).getByText('Already queued 2')).toBeTruthy();
  expect(within(dialog()).queryByText(/Not usable/)).toBeNull();
  expect(within(dialog()).queryByRole('list')).toBeNull();
});

it('a failed call shows its message and keeps the text for another try', async () => {
  const { api, user } = setup({
    'files:importUrls': () => {
      throw fakeError('invalid_operation', 'This asset no longer exists');
    },
  });
  await paste(user, 'https://a.test/x.png');
  await user.click(importButton());
  expect((await within(dialog()).findByRole('alert')).textContent).toBe('This asset no longer exists');
  expect(field().value).toBe('https://a.test/x.png');
  expect(importButton().disabled).toBe(false);
  api.set('files:importUrls', () => urlImportResultOf({ queued: 1 }));
  await user.click(importButton());
  expect(await within(dialog()).findByText('Queued 1')).toBeTruthy();
});

it('Import is disabled while sending', async () => {
  const answer = deferred<ReturnType<typeof urlImportResultOf>>();
  const { api, user } = setup({ 'files:importUrls': () => answer.promise });
  await paste(user, 'https://a.test/x.png');
  await user.click(importButton());
  expect(importButton().disabled).toBe(true);
  await user.click(importButton());
  answer.resolve(urlImportResultOf({ queued: 1 }));
  expect(await within(dialog()).findByText('Queued 1')).toBeTruthy();
  expect(requests(api)).toHaveLength(1);
});

it(`more than ${MAX_IMPORT_URLS} addresses disable Import with a tooltip`, async () => {
  const { user } = setup();
  const lines = Array.from({ length: MAX_IMPORT_URLS + 1 }, (_, i) => `https://a.test/${i}`);
  await paste(user, lines.join('\n'));
  expect(importButton().disabled).toBe(true);
  expect(importButton().getAttribute('title')).toBe(`At most ${MAX_IMPORT_URLS} addresses at once`);
});

it(`more than ${MAX_IMPORT_URLS} lines with at most ${MAX_IMPORT_URLS} addresses send only the non-empty lines`, async () => {
  const { api, user } = setup();
  const lines = Array.from({ length: MAX_IMPORT_URLS }, (_, i) => `https://a.test/${i}`);
  await paste(user, ['', ...lines].join('\n'));
  expect(importButton().disabled).toBe(false);
  await user.click(importButton());
  await waitFor(() => expect(requests(api)).toHaveLength(1));
  expect(requests(api)[0]).toEqual({ urls: lines, skipDuplicates: true });
});

it('moves the focus to Close when the answer arrives', async () => {
  const { user } = setup({ 'files:importUrls': () => urlImportResultOf({ queued: 1 }) });
  await paste(user, 'https://a.test/x.png');
  await user.click(importButton());
  const close = await within(dialog()).findByRole('button', { name: 'Close' });
  await waitFor(() => expect(document.activeElement).toBe(close));
});

it(`numbers the invalid lines as typed when more than ${MAX_IMPORT_URLS} lines went as the non-empty ones`, async () => {
  const lines = ['', '', ...Array.from({ length: MAX_IMPORT_URLS - 1 }, (_, i) => `https://a.test/${i}`), '', 'nope'];
  const { api, user } = setup({
    // The answer numbers the lines as sent: `nope` is the 5000th non-empty line.
    'files:importUrls': () =>
      urlImportResultOf({ queued: MAX_IMPORT_URLS - 1, invalid: [{ line: MAX_IMPORT_URLS, text: 'nope' }] }),
  });
  await paste(user, lines.join('\n'));
  await user.click(importButton());
  await waitFor(() => expect(requests(api)).toHaveLength(1));
  expect((requests(api)[0] as { urls: string[] }).urls).toHaveLength(MAX_IMPORT_URLS);
  const list = await within(dialog()).findByRole('list');
  expect(within(list).getByText(`${lines.length}: nope`)).toBeTruthy();
});

it('sends a line over 10000 characters trimmed and cut, so the request stays valid', async () => {
  const { api, user } = setup();
  const long = `https://a.test/${'x'.repeat(12_000)}`;
  await paste(user, ` ${long}\nhttps://a.test/y.png`);
  await user.click(importButton());
  await waitFor(() => expect(requests(api)).toHaveLength(1));
  expect(requests(api)[0]).toEqual({ urls: [long.slice(0, 10_000), 'https://a.test/y.png'], skipDuplicates: true });
});

it('Cancel closes without a request', async () => {
  const { api, onClose, user } = setup();
  await paste(user, 'https://a.test/x.png');
  await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalled();
  expect(requests(api)).toEqual([]);
});
