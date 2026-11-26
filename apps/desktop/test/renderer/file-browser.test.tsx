import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { FileList, FileRecord, FileScope, IpcRequest } from '@assetforge/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { FileBrowser } from '../../src/renderer/src/components/FileBrowser';
import { fileMenuItems } from '../../src/renderer/src/file-actions';
import { NO_FILE_FILTERS, type AssetView, type FileFilters } from '../../src/renderer/src/list-state';
import { NO_SELECTION, type FileSelection } from '../../src/renderer/src/selection';
import { deferred, installFakeApi, type FakeHandlers } from './fake-api';
import { fileRecord, nextId, pageOf, tagOf } from './fixtures';

afterEach(() => {
  vi.useRealTimers();
});

type ListRequest = IpcRequest<'files:list'>;

const ASSET_SCOPE: FileScope = { kind: 'asset', assetId: nextId() };

function many(count: number): FileRecord[] {
  return Array.from({ length: count }, (_, i) =>
    fileRecord({ originalName: `File ${i}.png`, assetId: ASSET_SCOPE.kind === 'asset' ? ASSET_SCOPE.assetId : null, role: 'reference' }),
  );
}

function listOf(items: FileRecord[]) {
  return (request: ListRequest) => pageOf(items.slice(request.offset, request.offset + request.limit), items.length);
}

function install(handlers: FakeHandlers) {
  return installFakeApi({ 'tags:suggest': () => [], ...handlers });
}

function listRequests(api: ReturnType<typeof install>): ListRequest[] {
  return api.calls.filter((c) => c.channel === 'files:list').map((c) => c.request as ListRequest);
}

function Harness(props: {
  scope?: FileScope;
  initialFilters?: FileFilters;
  initialView?: AssetView;
  showRoleFilter?: boolean;
  emptyText?: string;
  onOpen?(file: FileRecord): void;
  onSelection?(s: FileSelection): void;
}) {
  const [filters, setFilters] = useState(props.initialFilters ?? NO_FILE_FILTERS);
  const [view, setView] = useState<AssetView>(props.initialView ?? 'grid');
  const [selection, setSelection] = useState<FileSelection>(NO_SELECTION);
  const [reloadToken, setReloadToken] = useState(0);
  const onOpen = props.onOpen ?? (() => {});
  return (
    <div>
      <button type="button" onClick={() => setReloadToken((n) => n + 1)}>
        Reload
      </button>
      <FileBrowser
        scope={props.scope ?? ASSET_SCOPE}
        filters={filters}
        onFiltersChange={setFilters}
        showRoleFilter={props.showRoleFilter ?? true}
        view={view}
        onViewChange={setView}
        selection={selection}
        onSelectionChange={(next) => {
          props.onSelection?.(next);
          setSelection(next);
        }}
        reloadToken={reloadToken}
        onOpen={onOpen}
        menuItems={(file) => fileMenuItems(file, { cover: null, onDetails: () => onOpen(file) })}
        emptyText={props.emptyText ?? 'No files'}
      />
    </div>
  );
}

/** The tile (or table row) that shows `name`. */
function itemOf(name: string): HTMLElement {
  const container = screen.queryByRole('listbox', { name: 'Files' }) ?? screen.getByRole('grid', { name: 'Files' });
  const element = within(container).getByText(name).closest<HTMLElement>('[data-index]');
  if (element === null) throw new Error(`no item for ${name}`);
  return element;
}

function selectedNames(): string[] {
  return [...document.querySelectorAll('[data-index][aria-selected="true"]')].map(
    (element) => element.getAttribute('title') ?? '',
  );
}

it('click selects one, Ctrl+click toggles, Shift+click selects the range', async () => {
  const user = userEvent.setup();
  install({ 'files:list': listOf(many(6)) });
  render(<Harness />);
  await screen.findByText('File 0.png');
  const listbox = screen.getByRole('listbox', { name: 'Files' });
  expect(listbox.getAttribute('aria-multiselectable')).toBe('true');
  expect(itemOf('File 0.png').getAttribute('role')).toBe('option');
  expect(itemOf('File 0.png').hasAttribute('data-file-tile')).toBe(true);

  await user.click(itemOf('File 0.png'));
  expect(selectedNames()).toEqual(['File 0.png']);
  await user.click(itemOf('File 1.png'));
  expect(selectedNames()).toEqual(['File 1.png']);

  fireEvent.click(itemOf('File 3.png'), { ctrlKey: true });
  expect(selectedNames()).toEqual(['File 1.png', 'File 3.png']);
  const box = within(itemOf('File 3.png')).getByRole('checkbox', { name: 'Select File 3.png' }) as HTMLInputElement;
  expect(box.checked).toBe(true);
  expect(box.tabIndex).toBe(-1);

  fireEvent.click(itemOf('File 5.png'), { shiftKey: true });
  expect(selectedNames()).toEqual(['File 3.png', 'File 4.png', 'File 5.png']);

  fireEvent.click(itemOf('File 3.png'), { ctrlKey: true });
  expect(selectedNames()).toEqual(['File 4.png', 'File 5.png']);

  // The checkbox toggles like Ctrl+click.
  await user.click(within(itemOf('File 0.png')).getByRole('checkbox', { name: 'Select File 0.png' }));
  expect(selectedNames()).toEqual(['File 0.png', 'File 4.png', 'File 5.png']);
});

it('Space toggles the focused file and Esc clears the selection', async () => {
  const user = userEvent.setup();
  install({ 'files:list': listOf(many(6)) });
  render(<Harness />);
  await screen.findByText('File 0.png');
  await user.click(itemOf('File 0.png'));
  await user.keyboard('{ArrowRight}');
  expect(document.activeElement).toBe(itemOf('File 1.png'));
  // Arrow keys move focus only.
  expect(selectedNames()).toEqual(['File 0.png']);

  await user.keyboard(' ');
  expect(selectedNames()).toEqual(['File 0.png', 'File 1.png']);
  await user.keyboard(' ');
  expect(selectedNames()).toEqual(['File 0.png']);
  await user.keyboard(' ');
  await user.keyboard('{Escape}');
  expect(selectedNames()).toEqual([]);

  const tabbable = screen.getAllByRole('option').filter((option) => option.tabIndex === 0);
  expect(tabbable).toEqual([itemOf('File 1.png')]);
});

it('Ctrl+A loads the missing pages and selects at most 1000', async () => {
  const user = userEvent.setup();
  const onSelection = vi.fn();
  const api = install({ 'files:list': listOf(many(1200)) });
  render(<Harness onSelection={onSelection} />);
  await screen.findByText('File 0.png');
  const count = screen.getByText('1200 files');
  expect(count.getAttribute('title')).toBe('At most 1000 files can be selected');

  await user.click(itemOf('File 0.png'));
  await user.keyboard('{Control>}a{/Control}');
  await waitFor(() => expect((onSelection.mock.lastCall![0] as FileSelection).selected.size).toBe(1000));
  const offsets = [...new Set(listRequests(api).map((r) => r.offset))].sort((a, b) => a - b);
  expect(offsets).toEqual(Array.from({ length: 17 }, (_, i) => i * 60));
  const last = onSelection.mock.lastCall![0] as FileSelection;
  expect([...last.selected.values()].at(-1)!.originalName).toBe('File 999.png');
  expect(itemOf('File 3.png').getAttribute('aria-selected')).toBe('true');
});

it('Enter and the magnifier open the detail; the tile menu offers only allowed actions', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const ok = fileRecord({ originalName: 'ok.png', role: 'reference' });
  const broken = fileRecord({ originalName: 'broken.png', role: 'reference', status: 'failed', sha256: null });
  const api = install({ 'files:list': listOf([ok, broken]), 'files:openExternal': () => null });
  render(<Harness onOpen={onOpen} />);
  await screen.findByText('ok.png');

  await user.click(itemOf('ok.png'));
  await user.keyboard('{Enter}');
  expect(onOpen).toHaveBeenLastCalledWith(ok);

  await user.click(within(itemOf('broken.png')).getByRole('button', { name: 'Details' }));
  expect(onOpen).toHaveBeenLastCalledWith(broken);
  expect(onOpen).toHaveBeenCalledTimes(2);
  // The magnifier does not change the selection.
  expect(selectedNames()).toEqual(['ok.png']);

  const brokenMenu = within(itemOf('broken.png')).getByRole('button', { name: 'File actions' });
  await user.click(brokenMenu);
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Details']);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(brokenMenu);
  expect(selectedNames()).toEqual(['ok.png']);

  await user.click(within(itemOf('ok.png')).getByRole('button', { name: 'File actions' }));
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    'Details',
    'Open externally',
    'Show in folder',
  ]);
  // Keys inside the menu do not reach the tile: Enter selects the item, it does not open the detail.
  await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
  await waitFor(() =>
    expect(api.calls.filter((c) => c.channel === 'files:openExternal').map((c) => c.request)).toEqual([
      { fileId: ok.id },
    ]),
  );
  expect(onOpen).toHaveBeenCalledTimes(2);
  expect(selectedNames()).toEqual(['ok.png']);
});

it('pending and failed imports show their status in the frame', async () => {
  const pending = fileRecord({ originalName: 'wait.png', status: 'pending', sha256: null, role: 'reference' });
  const failed = fileRecord({ originalName: 'bad.png', status: 'failed', sha256: null, role: 'reference' });
  const done = fileRecord({ originalName: 'done.png', role: 'concept', sizeBytes: 2048, tags: [tagOf('Bark')] });
  install({ 'files:list': listOf([pending, failed, done]) });
  render(<Harness />);
  await screen.findByText('done.png');
  expect(within(itemOf('wait.png')).getByText('Pending')).toBeTruthy();
  const status = within(itemOf('bad.png')).getByText('Failed');
  expect(status.className).toContain('text-danger');
  const tile = itemOf('done.png');
  expect(tile.textContent).toContain('Concept · PNG · 2.0 KiB');
  expect(within(tile).getByRole('img', { name: 'Image tags' }).parentElement!.textContent).toContain('Bark');
});

it('the inbox meta line has no role', async () => {
  const file = fileRecord({ originalName: 'loose.png', sizeBytes: 2048 });
  install({ 'files:list': listOf([file]) });
  render(<Harness scope={{ kind: 'inbox' }} showRoleFilter={false} emptyText="Inbox is empty" />);
  await screen.findByText('loose.png');
  expect(itemOf('loose.png').textContent).toContain('PNG | 2.0 KiB');
  expect(screen.queryByRole('combobox', { name: 'Role' })).toBeNull();
});

it('filters go into files:list and an empty result shows the empty text', async () => {
  const bark = fileRecord({ originalName: 'bark.png' });
  const later = deferred<FileList>();
  const api = install({
    'files:list': (request) => (request.query === 'oak' ? later.promise : listOf([bark])(request)),
  });
  const first = render(<Harness initialFilters={{ ...NO_FILE_FILTERS, kind: 'image', tagNames: ['bark'] }} />);
  await screen.findByText('bark.png');
  expect(listRequests(api)).toEqual([{ limit: 60, offset: 0, scope: ASSET_SCOPE, kind: 'image', tagNames: ['bark'] }]);

  vi.useFakeTimers();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search files' }), { target: { value: 'oak ' } });
  act(() => vi.advanceTimersByTime(249));
  expect(listRequests(api).some((r) => r.query !== undefined)).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  expect(listRequests(api).at(-1)).toEqual({
    limit: 60,
    offset: 0,
    scope: ASSET_SCOPE,
    query: 'oak',
    kind: 'image',
    tagNames: ['bark'],
  });
  // The previous result stays until the new page arrives.
  expect(screen.getByText('bark.png')).toBeTruthy();
  await act(async () => later.resolve(pageOf([])));
  expect(screen.getByText('No matching files')).toBeTruthy();
  vi.useRealTimers();
  first.unmount();

  install({ 'files:list': listOf([]) });
  render(<Harness scope={{ kind: 'inbox' }} showRoleFilter={false} emptyText="Inbox is empty" />);
  expect(await screen.findByText('Inbox is empty')).toBeTruthy();
});

it('bumping reloadToken refetches', async () => {
  const user = userEvent.setup();
  let name = 'before.png';
  const id = nextId();
  const api = install({ 'files:list': () => pageOf([fileRecord({ id, originalName: name })]) });
  render(<Harness />);
  await screen.findByText('before.png');
  const calls = listRequests(api).length;
  name = 'after.png';
  await user.click(screen.getByRole('button', { name: 'Reload' }));
  expect(await screen.findByText('after.png')).toBeTruthy();
  expect(listRequests(api).length).toBe(calls + 1);
  expect(screen.queryByText('before.png')).toBeNull();
});

it('the table view shows the columns and keeps the selection rules', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const files = many(3);
  install({ 'files:list': listOf(files) });
  render(<Harness onOpen={onOpen} />);
  await screen.findByText('File 0.png');
  await user.click(screen.getByRole('button', { name: 'Show as table' }));
  const table = screen.getByRole('grid', { name: 'Files' });
  expect(table.getAttribute('aria-multiselectable')).toBe('true');
  const headers = within(table)
    .getAllByRole('columnheader')
    .map((h) => h.textContent);
  expect(headers).toEqual(['', 'Name', 'Role', 'Type', 'Size', 'Imported', 'Tags', '']);
  const row = itemOf('File 0.png');
  expect(row.getAttribute('role')).toBe('row');
  expect(within(row).getByText('Reference')).toBeTruthy();
  expect(within(row).getByText('PNG')).toBeTruthy();

  await user.click(row);
  fireEvent.click(itemOf('File 2.png'), { shiftKey: true });
  expect(selectedNames()).toEqual(['File 0.png', 'File 1.png', 'File 2.png']);
  await user.keyboard('{Escape}');
  expect(selectedNames()).toEqual([]);
  await user.keyboard('{Enter}');
  expect(onOpen).toHaveBeenCalledWith(files[0]);
});
