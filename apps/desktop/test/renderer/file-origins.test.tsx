import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileOrigin } from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { FileOrigins } from '../../src/renderer/src/components/FileOrigins';
import { deferred, fakeError, fakeFileOrigins, installFakeApi } from './fake-api';
import { nextId } from './fixtures';

const CREATED = '2026-11-27T08:00:00.000Z';

function origin(url: string): FileOrigin {
  return { id: nextId(), url, createdAt: CREATED };
}

function row(url: string): HTMLElement {
  return screen.getByText(url).closest('li')!;
}

it('shows each origin under Source; following one asks files:openOrigin and no anchor carries the URL', async () => {
  const user = userEvent.setup();
  const fileId = nextId();
  const origins = [origin('https://example.org/a.png'), origin('https://cdn.example.com/b.png')];
  const fake = fakeFileOrigins({ [fileId]: origins });
  const api = installFakeApi(fake.handlers);
  render(<FileOrigins fileId={fileId} />);

  const section = await screen.findByRole('region', { name: 'Source' });
  expect(within(section).getByRole('heading', { level: 3 }).textContent).toBe('Source');
  const links = within(section).getAllByRole('link');
  expect(links.map((l) => l.textContent)).toEqual(['https://example.org/a.png', 'https://cdn.example.com/b.png']);
  expect(links.map((l) => l.getAttribute('title'))).toEqual(['https://example.org/a.png', 'https://cdn.example.com/b.png']);
  for (const anchor of section.querySelectorAll('a')) {
    expect(anchor.getAttribute('href')).not.toContain('example');
  }
  expect(api.calls.filter((c) => c.channel === 'files:origins').map((c) => c.request)).toEqual([{ fileId }]);

  await user.click(links[1]!);
  await waitFor(() => expect(fake.state.opened).toEqual([{ fileId, originId: origins[1]!.id }]));
});

it('copy writes the URL to the clipboard; a failed copy shows the message', async () => {
  const user = userEvent.setup();
  const fileId = nextId();
  installFakeApi(fakeFileOrigins({ [fileId]: [origin('https://example.org/a.png'), origin('https://example.org/b.png')] }).handlers);
  render(<FileOrigins fileId={fileId} />);
  await screen.findByText('https://example.org/b.png');

  const write = vi.spyOn(navigator.clipboard, 'writeText');
  const copy = within(row('https://example.org/b.png')).getByRole('button', { name: 'Copy URL' });
  expect(copy.getAttribute('title')).toBe('Copy URL');
  await user.click(copy);
  expect(write).toHaveBeenCalledExactlyOnceWith('https://example.org/b.png');

  write.mockRejectedValueOnce(new Error('denied'));
  await user.click(copy);
  expect((await screen.findByRole('alert')).textContent).toBe('The URL could not be copied');
});

it('a refused open shows the message', async () => {
  const user = userEvent.setup();
  const fileId = nextId();
  installFakeApi({
    'files:origins': () => [origin('https://example.org/a.png')],
    'files:openOrigin': () => {
      throw fakeError('invalid_operation', 'This source could not be opened');
    },
  });
  render(<FileOrigins fileId={fileId} />);
  await user.click(await screen.findByRole('link', { name: 'https://example.org/a.png' }));
  expect((await screen.findByRole('alert')).textContent).toBe('This source could not be opened');
});

it('renders nothing without origins and nothing for a failed load', async () => {
  const api = installFakeApi({});
  const { container, unmount } = render(<FileOrigins fileId={nextId()} />);
  await waitFor(() => expect(api.calls.some((c) => c.channel === 'files:origins')).toBe(true));
  await Promise.resolve();
  expect(container.innerHTML).toBe('');
  unmount();

  const failing = installFakeApi({
    'files:origins': () => {
      throw fakeError('internal_error');
    },
  });
  const second = render(<FileOrigins fileId={nextId()} />);
  await waitFor(() => expect(failing.calls.some((c) => c.channel === 'files:origins')).toBe(true));
  await Promise.resolve();
  expect(second.container.innerHTML).toBe('');
});

it('more than five origins scroll in a bounded list', async () => {
  const fileId = nextId();
  const origins = Array.from({ length: 7 }, (_, i) => origin(`https://example.org/${i}.png`));
  installFakeApi(fakeFileOrigins({ [fileId]: origins }).handlers);
  render(<FileOrigins fileId={fileId} />);
  await screen.findByText('https://example.org/6.png');
  const list = screen.getByRole('list');
  expect(list.className).toContain('max-h-46');
  expect(list.className).toContain('overflow-y-auto');
  expect(within(list).getAllByRole('listitem')).toHaveLength(7);
});

it('reloads for a new file id and ignores a late answer for the previous one', async () => {
  const first = nextId();
  const second = nextId();
  const late = deferred<FileOrigin[]>();
  const api = installFakeApi({
    'files:origins': ({ fileId }) => (fileId === first ? late.promise : [origin('https://example.org/second.png')]),
  });
  const { rerender } = render(<FileOrigins fileId={first} />);
  rerender(<FileOrigins fileId={second} />);
  await screen.findByText('https://example.org/second.png');
  late.resolve([origin('https://example.org/first.png')]);
  await late.promise;
  await Promise.resolve();
  expect(screen.queryByText('https://example.org/first.png')).toBeNull();
  expect(screen.getByText('https://example.org/second.png')).toBeTruthy();
  expect(api.calls.filter((c) => c.channel === 'files:origins').map((c) => c.request)).toEqual([
    { fileId: first },
    { fileId: second },
  ]);
});
