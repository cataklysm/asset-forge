import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AssetSource } from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { SourceList } from '../../src/renderer/src/components/SourceList';
import { deferred } from './fake-api';
import { nextId } from './fixtures';

const NOW = '2026-01-01T00:00:00.000Z';
const LONG = `https://textures.example.com/wood/${'oak-'.repeat(40)}12.png`;

function source(url: string): AssetSource {
  return { id: nextId(), url, createdAt: NOW };
}

function setup(p: Partial<Parameters<typeof SourceList>[0]> = {}) {
  const props = {
    sources: [] as AssetSource[],
    disabled: false,
    onAdd: vi.fn(async () => {}),
    onRemove: vi.fn(async () => {}),
    onOpen: vi.fn(async () => {}),
    ...p,
  };
  render(<SourceList {...props} />);
  return { user: userEvent.setup(), props };
}

const group = () => screen.getByRole('group', { name: 'Sources' });
const input = () => within(group()).getByRole('textbox', { name: 'Add URL' }) as HTMLInputElement;
/** The row of one source: the list item holding its link. */
const row = (url: string) => within(group()).getByRole('link', { name: url }).closest('li') as HTMLElement;

it('renders one link per source with the URL as text and title; no href is a source URL', () => {
  const sources = [source('https://example.org/doors/oak-12'), source(LONG)];
  setup({ sources });
  const links = within(group()).getAllByRole('link');
  expect(links.map((l) => l.textContent)).toEqual(sources.map((s) => s.url));
  expect(links.map((l) => l.getAttribute('title'))).toEqual(sources.map((s) => s.url));
  const hrefs = [...document.querySelectorAll('[href]')].map((e) => e.getAttribute('href'));
  for (const s of sources) expect(hrefs).not.toContain(s.url);
  expect(input().placeholder).toBe('Add URL');
  expect(input().maxLength).toBe(2000);
});

it('a click on a source calls onOpen with its ID', async () => {
  const sources = [source('https://example.org/a'), source('https://example.org/b')];
  const { user, props } = setup({ sources });
  await user.click(screen.getByRole('link', { name: 'https://example.org/b' }));
  expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(sources[1]!.id);
});

it('remove calls onRemove with the ID; copy writes the URL to the clipboard', async () => {
  const sources = [source('https://example.org/a'), source('https://example.org/b')];
  const { user, props } = setup({ sources });
  const remove = within(row('https://example.org/a')).getByRole('button', { name: 'Remove source' });
  expect(remove.getAttribute('title')).toBe('Remove source');
  await user.click(remove);
  expect(props.onRemove).toHaveBeenCalledExactlyOnceWith(sources[0]!.id);

  const write = vi.spyOn(navigator.clipboard, 'writeText');
  const copy = within(row('https://example.org/b')).getByRole('button', { name: 'Copy URL' });
  expect(copy.getAttribute('title')).toBe('Copy URL');
  await user.click(copy);
  expect(write).toHaveBeenCalledExactlyOnceWith('https://example.org/b');
});

it('a failed copy shows an alert that a working copy clears', async () => {
  const { user } = setup({ sources: [source('https://example.org/a')] });
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
  const copy = within(row('https://example.org/a')).getByRole('button', { name: 'Copy URL' });
  await user.click(copy);
  expect((await screen.findByRole('alert')).textContent).toBe('The URL could not be copied');
  write.mockResolvedValueOnce(undefined);
  await user.click(copy);
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

it('Enter adds the typed URL once and clears the input after it resolved', async () => {
  const pending = deferred<void>();
  const { user, props } = setup({ onAdd: vi.fn(() => pending.promise) });
  await user.type(input(), 'https://example.org{Enter}');
  expect(props.onAdd).toHaveBeenCalledExactlyOnceWith('https://example.org');
  expect(input().value).toBe('https://example.org');
  pending.resolve();
  await waitFor(() => expect(input().value).toBe(''));
  expect(props.onAdd).toHaveBeenCalledTimes(1);
});

it('Enter twice while adding calls onAdd once; the input is disabled meanwhile', async () => {
  const pending = deferred<void>();
  const { user, props } = setup({ onAdd: vi.fn(() => pending.promise) });
  await user.type(input(), 'https://example.org');
  input().focus();
  await user.keyboard('{Enter}{Enter}');
  expect(props.onAdd).toHaveBeenCalledTimes(1);
  expect(input().disabled).toBe(true);
  pending.resolve();
  await waitFor(() => expect(input().disabled).toBe(false));
  expect(props.onAdd).toHaveBeenCalledTimes(1);
});

it('a rejected add keeps the text; Enter on a blank input calls nothing', async () => {
  const { user, props } = setup({ onAdd: vi.fn(async () => Promise.reject(new Error('This source already exists'))) });
  await user.type(input(), '   {Enter}');
  expect(props.onAdd).not.toHaveBeenCalled();
  await user.clear(input());
  await user.type(input(), 'https://example.org{Enter}');
  await waitFor(() => expect(input().disabled).toBe(false));
  expect(props.onAdd).toHaveBeenCalledTimes(1);
  expect(input().value).toBe('https://example.org');
});

it('disabled disables the input and the remove buttons, not open and copy', async () => {
  const sources = [source('https://example.org/a')];
  const { user, props } = setup({ sources, disabled: true });
  expect(input().disabled).toBe(true);
  const r = row('https://example.org/a');
  expect((within(r).getByRole('button', { name: 'Remove source' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(r).getByRole('button', { name: 'Copy URL' }) as HTMLButtonElement).disabled).toBe(false);
  const link = within(r).getByRole('link', { name: 'https://example.org/a' });
  expect(link.getAttribute('aria-disabled')).toBeNull();
  await user.click(link);
  expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(sources[0]!.id);
});

it('the list scrolls inside the block and a long URL is cut', () => {
  setup({ sources: Array.from({ length: 6 }, (_, i) => source(`https://example.org/${i}`)) });
  const list = within(group()).getByRole('list');
  expect(list.className).toContain('max-h-');
  expect(list.className).toContain('overflow-y-auto');
  // The padding keeps the 2 px focus outline with its 2 px offset inside the scrolling box.
  expect(list.className.split(' ')).toContain('p-1');
  expect(within(group()).getAllByRole('link')[0]!.className).toContain('truncate');
});
