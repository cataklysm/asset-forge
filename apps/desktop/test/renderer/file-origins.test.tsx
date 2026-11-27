import { act, render, screen, waitFor, within } from '@testing-library/react';
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
  const anchors = [...section.querySelectorAll('a')];
  expect(anchors).toHaveLength(2);
  for (const anchor of anchors) expect(anchor.getAttribute('href')).toBe('#');
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

/** Lets every pending answer pass through the fake API, `call` and the component, and React commit. */
async function settle() {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

it('renders nothing for a file without origins and nothing for a failed load', async () => {
  const shown = nextId();
  const empty = nextId();
  const broken = nextId();
  const api = installFakeApi({
    'files:origins': ({ fileId }) => {
      if (fileId === broken) throw fakeError('internal_error');
      return fileId === shown ? [origin('https://example.org/shown.png')] : [];
    },
  });
  // The same harness renders a resolved answer, so the empty cases below are answered, not still loading.
  const { container, rerender } = render(<FileOrigins fileId={shown} />);
  await settle();
  expect(screen.getByRole('region', { name: 'Source' })).toBeTruthy();

  rerender(<FileOrigins fileId={empty} />);
  await settle();
  expect(api.calls.at(-1)?.request).toEqual({ fileId: empty });
  expect(container.innerHTML).toBe('');

  rerender(<FileOrigins fileId={shown} />);
  await settle();
  expect(screen.getByText('https://example.org/shown.png')).toBeTruthy();

  rerender(<FileOrigins fileId={broken} />);
  await settle();
  expect(api.calls.at(-1)?.request).toEqual({ fileId: broken });
  expect(container.innerHTML).toBe('');
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
  await settle();
  expect(screen.queryByText('https://example.org/first.png')).toBeNull();
  expect(screen.getByText('https://example.org/second.png')).toBeTruthy();
  expect(api.calls.filter((c) => c.channel === 'files:origins').map((c) => c.request)).toEqual([
    { fileId: first },
    { fileId: second },
  ]);
});
