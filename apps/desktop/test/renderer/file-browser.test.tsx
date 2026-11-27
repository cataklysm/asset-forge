import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { FileList, FileRecord, FileScope, IpcRequest } from '@assetforge/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { FileBrowser, type ViewerList } from '../../src/renderer/src/components/FileBrowser';
import { fileMenuItems, type FileActionContext } from '../../src/renderer/src/file-actions';
import { formatDateTime } from '../../src/renderer/src/format';
import { NO_FILE_FILTERS, type AssetView, type FileFilters } from '../../src/renderer/src/list-state';
import { NO_SELECTION, type FileSelection } from '../../src/renderer/src/selection';
import { deferred, installFakeApi, type FakeHandlers } from './fake-api';
import { fileRecord, nextId, pageOf, tagOf, trashedRecord } from './fixtures';

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
  onDeleteKey?(): void;
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
        onDeleteKey={props.onDeleteKey}
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

/** A host whose "viewer" prints its position and records what the browser asks it to show. */
function ViewerHarness(props: { initialFileId?: string | null; onView?(file: FileRecord | null): void }) {
  const [selection, setSelection] = useState<FileSelection>(NO_SELECTION);
  const [reloadToken, setReloadToken] = useState(0);
  const [fileId, setFileId] = useState<string | null>(props.initialFileId ?? null);
  return (
    <div>
      <button type="button" onClick={() => setReloadToken((n) => n + 1)}>
        Reload
      </button>
      <button type="button" onClick={() => setFileId(null)}>
        Close viewer
      </button>
      <FileBrowser
        scope={ASSET_SCOPE}
        filters={NO_FILE_FILTERS}
        onFiltersChange={() => {}}
        showRoleFilter
        view="grid"
        onViewChange={() => {}}
        selection={selection}
        onSelectionChange={setSelection}
        reloadToken={reloadToken}
        onOpen={(file) => setFileId(file.id)}
        menuItems={() => []}
        emptyText="No files"
        viewer={{
          fileId,
          onView: (file) => {
            props.onView?.(file);
            setFileId(file?.id ?? null);
          },
          render: (list) => <ViewerProbe list={list} />,
        }}
      />
    </div>
  );
}

let viewerList: ViewerList | null = null;

function ViewerProbe({ list }: { list: ViewerList }) {
  viewerList = list;
  return <output aria-label="Viewer">{`index ${list.index} total ${list.total}`}</output>;
}

function viewerText(): string | null {
  return screen.queryByRole('status', { name: 'Viewer' })?.textContent ?? null;
}

function show(index: number) {
  act(() => viewerList!.show(index));
}

/** Serves `items`; requests for the offsets in `gates` wait for their deferred answer. */
function gatedList(items: () => FileRecord[], gates: Map<number, ReturnType<typeof deferred<FileList>>>) {
  return (request: ListRequest) => {
    const gate = gates.get(request.offset);
    const answer = () => pageOf(items().slice(request.offset, request.offset + request.limit), items().length);
    return gate === undefined ? answer() : gate.promise.then(answer);
  };
}

it('the viewer gets the position of the shown file and show() steps, clamped to the list', async () => {
  const user = userEvent.setup();
  const files = many(5);
  const onView = vi.fn();
  install({ 'files:list': listOf(files) });
  render(<ViewerHarness onView={onView} />);
  await screen.findByText('File 0.png');
  expect(viewerText()).toBeNull();

  await user.click(itemOf('File 2.png'));
  await user.keyboard('{Enter}');
  expect(viewerText()).toBe('index 2 total 5');

  show(3);
  expect(onView).toHaveBeenLastCalledWith(files[3]);
  expect(viewerText()).toBe('index 3 total 5');
  show(-1);
  expect(onView).toHaveBeenLastCalledWith(files[0]);
  show(5);
  expect(onView).toHaveBeenLastCalledWith(files[4]);
  expect(viewerText()).toBe('index 4 total 5');
});

it('the viewer keeps its neighbours loaded and show() loads the page it needs; the latest call wins', async () => {
  const files = many(130);
  const onView = vi.fn();
  const gates = new Map([
    [60, deferred<FileList>()],
    [120, deferred<FileList>()],
  ]);
  const api = install({ 'files:list': gatedList(() => files, gates) });
  render(<ViewerHarness initialFileId={files[59]!.id} onView={onView} />);
  await screen.findByText('File 0.png');
  expect(viewerText()).toBe('index 59 total 130');
  // The page after the shown file is requested without scrolling.
  await waitFor(() => expect(listRequests(api).map((r) => r.offset)).toContain(60));

  show(60);
  expect(onView).not.toHaveBeenCalled();
  await act(async () => gates.get(60)!.resolve(pageOf([])));
  expect(onView).toHaveBeenCalledTimes(1);
  expect(onView).toHaveBeenLastCalledWith(files[60]);
  expect(viewerText()).toBe('index 60 total 130');

  show(125);
  await waitFor(() => expect(listRequests(api).map((r) => r.offset)).toContain(120));
  show(126);
  expect(onView).toHaveBeenCalledTimes(1);
  await act(async () => gates.get(120)!.resolve(pageOf([])));
  expect(onView).toHaveBeenCalledTimes(2);
  expect(onView).toHaveBeenLastCalledWith(files[126]);
  expect(viewerText()).toBe('index 126 total 130');
});

it('after a reload without the shown file the viewer moves to the follower, else the previous, else closes', async () => {
  const user = userEvent.setup();
  const all = many(5);
  let items = all;
  const onView = vi.fn();
  const api = install({ 'files:list': (r) => listOf(items)(r) });
  render(<ViewerHarness onView={onView} />);
  await screen.findByText('File 0.png');
  await user.click(itemOf('File 2.png'));
  await user.keyboard('{Enter}');

  // Still present: nothing changes.
  await user.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(listRequests(api)).toHaveLength(2));
  await waitFor(() => expect(document.querySelectorAll('[data-file-tile]')).toHaveLength(5));
  expect(onView).not.toHaveBeenCalled();
  expect(viewerText()).toBe('index 2 total 5');

  // Gone from the middle: the file that followed it.
  items = all.filter((f) => f !== all[2]);
  await user.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(onView).toHaveBeenCalledTimes(1));
  expect(onView).toHaveBeenLastCalledWith(all[3]);
  expect(viewerText()).toBe('index 2 total 4');

  // Gone from the end: the one before it.
  show(3);
  expect(onView).toHaveBeenLastCalledWith(all[4]);
  items = items.filter((f) => f !== all[4]);
  await user.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(onView).toHaveBeenLastCalledWith(all[3]));
  expect(viewerText()).toBe('index 2 total 3');

  // The only file gone: the viewer closes.
  items = [all[3]!];
  await user.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(viewerText()).toBe('index 0 total 1'));
  items = [];
  await user.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(onView).toHaveBeenLastCalledWith(null));
  expect(viewerText()).toBeNull();
});

it('a reload that shrinks the list below a pending show() shows the last file', async () => {
  const user = userEvent.setup();
  let items = many(130);
  const onView = vi.fn();
  const gates = new Map([[120, deferred<FileList>()]]);
  install({ 'files:list': gatedList(() => items, gates) });
  render(<ViewerHarness initialFileId={items[0]!.id} onView={onView} />);
  await screen.findByText('File 0.png');
  show(125);
  items = items.slice(0, 70);
  await user.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(onView).toHaveBeenCalledTimes(1));
  expect(onView).toHaveBeenLastCalledWith(items[69]);
  expect(viewerText()).toBe('index 69 total 70');
  // The old answer arrives late and changes nothing.
  await act(async () => gates.get(120)!.resolve(pageOf([])));
  expect(onView).toHaveBeenCalledTimes(1);
});

it('closing the viewer focuses the tile of the file shown last, also on a page never scrolled to', async () => {
  const user = userEvent.setup();
  const files = many(130);
  install({ 'files:list': listOf(files) });
  const scrollTo = Element.prototype.scrollTo;
  // Like a browser: scrolling moves the offset and fires `scroll`.
  Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
    const top = typeof options === 'object' ? (options.top ?? 0) : 0;
    Object.defineProperty(this, 'scrollTop', { configurable: true, value: top });
    this.dispatchEvent(new Event('scroll'));
  } as typeof Element.prototype.scrollTo;
  try {
    render(<ViewerHarness />);
    await screen.findByText('File 0.png');
    // The scroll range the rows would give in a browser.
    Object.defineProperty(screen.getByRole('listbox', { name: 'Files' }), 'scrollHeight', { value: 100_000 });
    await user.click(itemOf('File 1.png'));
    await user.keyboard('{Enter}');
    show(2);
    await user.click(screen.getByRole('button', { name: 'Close viewer' }));
    expect(document.activeElement).toBe(itemOf('File 2.png'));

    await user.click(itemOf('File 1.png'));
    await user.keyboard('{Enter}');
    show(125);
    await waitFor(() => expect(viewerText()).toBe('index 125 total 130'));
    await user.click(screen.getByRole('button', { name: 'Close viewer' }));
    await waitFor(() => expect(document.activeElement).toBe(itemOf('File 125.png')));
  } finally {
    Element.prototype.scrollTo = scrollTo;
  }
});

it('a reload with a fresh record of the viewed file hands it to the viewer once', async () => {
  const user = userEvent.setup();
  const all = many(3);
  let items = all;
  const onView = vi.fn();
  const api = install({ 'files:list': (r) => listOf(items)(r) });
  render(<ViewerHarness onView={onView} />);
  await screen.findByText('File 0.png');
  await user.click(itemOf('File 1.png'));
  await user.keyboard('{Enter}');

  const fresh = { ...all[1]!, tags: [tagOf('Moss', 'ai')] };
  items = [all[0]!, fresh, all[2]!];
  await user.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(onView).toHaveBeenCalledTimes(1));
  expect(onView).toHaveBeenLastCalledWith(fresh);
  expect(viewerText()).toBe('index 1 total 3');

  // The same records again: nothing to hand over.
  await user.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(listRequests(api)).toHaveLength(3));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(onView).toHaveBeenCalledTimes(1);
});

/** Every action a host can offer, so the menu shows which ones a file gets. */
const FULL_CONTEXT: FileActionContext = {
  cover: { isEffective: false, isChosen: false },
  onDetails: () => {},
  onSetCover: () => {},
  onDetach: () => {},
  onAnalyse: () => {},
  onReviewTags: () => {},
  onImageToPrompt: () => {},
  onDelete: () => {},
  onRestore: () => {},
  onPurge: () => {},
};

const menuLabels = (file: FileRecord, ctx: FileActionContext = FULL_CONTEXT) => fileMenuItems(file, ctx).map((i) => i.label);

it('the menu of a live file ends with Delete', () => {
  const file = fileRecord({ assetId: nextId(), role: 'reference' });
  const items = fileMenuItems(file, FULL_CONTEXT);
  expect(items.map((i) => i.label).slice(-2)).toEqual(['Detach', 'Delete']);
  expect(items.at(-1)!.title).toBe('Moves the file to the trash');
  expect(menuLabels(file)).not.toContain('Restore');
  expect(menuLabels(file)).not.toContain('Delete permanently');
  // Without the host's handler there is no Delete.
  expect(menuLabels(file, { cover: null, onDetails: () => {} })).not.toContain('Delete');
});

it('a pending file has no Delete', () => {
  expect(menuLabels(fileRecord({ status: 'pending', sha256: null }), { cover: null, onDetails: () => {}, onDelete: () => {} })).toEqual([
    'Details',
  ]);
});

it('a failed file offers Details and Delete', () => {
  expect(menuLabels(fileRecord({ status: 'failed', sha256: null }), { cover: null, onDetails: () => {}, onDelete: () => {} })).toEqual([
    'Details',
    'Delete',
  ]);
});

it('a trashed file offers only Details, Restore and Delete permanently', () => {
  const file = trashedRecord({ trashedAssetId: nextId(), trashedAssetName: 'Hero', trashedRole: 'reference' });
  const items = fileMenuItems(file, FULL_CONTEXT);
  expect(items.map((i) => i.label)).toEqual(['Details', 'Restore', 'Delete permanently']);
  expect(items.map((i) => i.title)).toEqual([undefined, 'Puts the file back where it was', 'Removes the file from disk; asks first']);
  expect(menuLabels(file, { ...FULL_CONTEXT, onRestore: undefined, onPurge: undefined })).toEqual(['Details']);
});

it('the Delete key on a focused tile calls onDeleteKey', async () => {
  const user = userEvent.setup();
  const onDeleteKey = vi.fn();
  install({ 'files:list': listOf(many(3)) });
  render(<Harness onDeleteKey={onDeleteKey} />);
  await screen.findByText('File 0.png');
  await user.click(itemOf('File 1.png'));
  const event = fireEvent.keyDown(itemOf('File 1.png'), { key: 'Delete' });
  expect(onDeleteKey).toHaveBeenCalledTimes(1);
  // fireEvent returns false when the default was prevented.
  expect(event).toBe(false);
  // Not from a control inside the tile.
  fireEvent.keyDown(within(itemOf('File 1.png')).getByRole('checkbox', { name: 'Select File 1.png' }), { key: 'Delete' });
  expect(onDeleteKey).toHaveBeenCalledTimes(1);
});

it('the Delete key inside the search field does not', async () => {
  const user = userEvent.setup();
  const onDeleteKey = vi.fn();
  install({ 'files:list': listOf(many(3)) });
  render(<Harness onDeleteKey={onDeleteKey} />);
  await screen.findByText('File 0.png');
  await user.click(itemOf('File 0.png'));
  const search = screen.getByRole('searchbox', { name: 'Search files' });
  await user.type(search, 'oak');
  await user.keyboard('{ArrowLeft}{Delete}');
  expect((search as HTMLInputElement).value).toBe('oa');
  expect(onDeleteKey).not.toHaveBeenCalled();
});

const TRASH_SCOPE: FileScope = { kind: 'trash' };

function trashFiles(): [FileRecord, FileRecord] {
  return [
    trashedRecord({
      originalName: 'hero.png',
      deletedAt: '2026-03-04T05:06:00.000Z',
      trashedAssetId: nextId(),
      trashedAssetName: 'Hero',
      trashedRole: 'texture',
    }),
    trashedRecord({ originalName: 'loose.png', deletedAt: '2026-03-05T05:06:00.000Z' }),
  ];
}

it('the trash table shows the deletion date and the origin', async () => {
  const user = userEvent.setup();
  const [hero, loose] = trashFiles();
  install({ 'files:list': listOf([hero, loose]) });
  render(<Harness scope={TRASH_SCOPE} showRoleFilter={false} />);
  // The tile's meta line names the origin.
  const heroTile = (await screen.findByText('hero.png')).closest<HTMLElement>('[data-index]')!;
  expect(within(heroTile).getByText(/^Hero · PNG/)).toBeTruthy();
  expect(within(itemOf('loose.png')).getByText(/^Inbox · PNG/)).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Show as table' }));
  const table = screen.getByRole('grid', { name: 'Files' });
  const headers = within(table)
    .getAllByRole('columnheader')
    .map((h) => h.textContent);
  expect(headers).toEqual(['', 'Name', 'Type', 'Size', 'Imported', 'Deleted', 'Origin', 'Tags', '']);
  const cells = (name: string) =>
    within(itemOf(name))
      .getAllByRole('gridcell')
      .map((c) => c.textContent);
  expect(cells('hero.png')[5]).toBe(formatDateTime(hero.deletedAt!));
  expect(cells('hero.png')[6]).toBe('Hero');
  expect(cells('loose.png')[6]).toBe('Inbox');
});

it('the trash scope has no role filter, no Proposals toggle and no Analyse all', async () => {
  const api = install({ 'files:list': listOf(trashFiles()) });
  // Even a host that asks for the role filter does not get it in the trash.
  render(<Harness scope={TRASH_SCOPE} showRoleFilter />);
  await screen.findByText('hero.png');
  expect(screen.queryByRole('combobox', { name: 'Role' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Proposals/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Analyse all/ })).toBeNull();
  expect(listRequests(api)[0]).toMatchObject({ scope: TRASH_SCOPE });
});

it('the file type filter offers Video and asks for the kind video', async () => {
  const api = install({ 'files:list': listOf(many(2)) });
  render(<Harness />);
  await screen.findByText('File 0.png');
  const select = screen.getByRole('combobox', { name: 'File type' });
  expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
    'All file types',
    'Image',
    'Video',
    '3D model',
    'Document',
    'Other',
  ]);
  await userEvent.setup().selectOptions(select, 'Video');
  await waitFor(() => expect(listRequests(api).at(-1)).toEqual({ limit: 60, offset: 0, scope: ASSET_SCOPE, kind: 'video' }));
});
