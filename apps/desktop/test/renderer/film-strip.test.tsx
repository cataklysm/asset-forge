import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileRecord } from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { FilmStrip } from '../../src/renderer/src/components/FilmStrip';
import type { ViewerList } from '../../src/renderer/src/components/FileBrowser';
import { fileRecord } from './fixtures';

function listOf(files: (FileRecord | undefined)[], index: number, total = files.length): ViewerList {
  return {
    total,
    index,
    slot: (i) => {
      const file = files[i];
      return file === undefined ? { kind: 'placeholder' } : { kind: 'loaded', item: file };
    },
    show: vi.fn(),
    want: vi.fn(),
  };
}

const pngs = (count: number) => Array.from({ length: count }, (_, i) => fileRecord({ originalName: `File ${i}.png` }));

it('renders one tile per file with the name as title; the current one is marked', async () => {
  const files = pngs(5);
  const list = listOf(files, 2);
  render(<FilmStrip list={list} />);
  const group = screen.getByRole('group', { name: 'Files' });
  const tiles = within(group).getAllByRole('button');
  expect(tiles).toHaveLength(5);
  expect(tiles.map((t) => t.title)).toEqual(files.map((f) => f.originalName));
  expect(tiles.filter((t) => t.getAttribute('aria-current') === 'true')).toEqual([tiles[2]]);
  await userEvent.setup().click(tiles[3]!);
  expect(list.show).toHaveBeenCalledWith(3);
});

it('shows the format label for a file without preview and no image', () => {
  const text = fileRecord({ originalName: 'notes.txt', mimeType: 'text/plain', previewable: false, kind: 'document' });
  const { container } = render(<FilmStrip list={listOf([text, ...pngs(1)], 0)} />);
  expect(screen.getByText('TXT')).toBeTruthy();
  const tile = screen.getByRole('button', { name: 'notes.txt' });
  expect(tile.querySelector('img')).toBeNull();
  expect(container.querySelectorAll('img')).toHaveLength(1);
});

it('renders an empty tile for an unloaded slot and asks for the range', () => {
  const files = [...pngs(2), undefined, ...pngs(1)];
  const list = listOf(files, 0);
  render(<FilmStrip list={list} />);
  expect(screen.getAllByRole('button')).toHaveLength(4);
  const [first, last] = vi.mocked(list.want).mock.calls.at(-1)!;
  expect(first).toBeLessThanOrEqual(2);
  expect(last).toBeGreaterThanOrEqual(2);
});

it('renders no strip for a single file', () => {
  render(<FilmStrip list={listOf(pngs(1), 0)} />);
  expect(screen.queryByRole('group', { name: 'Files' })).toBeNull();
});

it('virtualises a long list', () => {
  render(<FilmStrip list={listOf(pngs(500), 0)} />);
  const count = screen.getAllByRole('button').length;
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThan(100);
});

it('moving the current index scrolls the strip to its tile', () => {
  const files = pngs(500);
  const scrollTo = vi.spyOn(Element.prototype, 'scrollTo');
  // jsdom lays nothing out; the virtualizer clamps its target to scrollWidth minus clientWidth.
  const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(500 * 104);
  try {
    const { rerender } = render(<FilmStrip list={listOf(files, 0)} />);
    scrollTo.mockClear();
    rerender(<FilmStrip list={listOf(files, 400)} />);
    const lefts = scrollTo.mock.calls.map((call) => (call[0] as ScrollToOptions | undefined)?.left ?? 0);
    // The tile at 400 starts at 400 × (96 + 8) pixels; `auto` puts its end at the right edge of the 1280 pixel strip.
    expect(Math.max(0, ...lefts)).toBeGreaterThan(400 * 104 - 1280);
  } finally {
    scrollTo.mockRestore();
    scrollWidth.mockRestore();
  }
});
