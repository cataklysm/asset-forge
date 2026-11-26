import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { JOB_ERROR_MESSAGES, type AssetAssignment, type AssetSummary, type AssetType, type IpcRequest } from '@assetforge/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { NO_FILTERS, renameInFilters, type AssetListState } from '../../src/renderer/src/list-state';
import { ProviderSettingsProvider } from '../../src/renderer/src/provider-context';
import { AnalysisPromptsProvider } from '../../src/renderer/src/analysis-prompts-context';
import { AssetsScreen } from '../../src/renderer/src/screens/AssetsScreen';
import { TagsProvider } from '../../src/renderer/src/tags-context';
import { deferred, fakeError, installFakeApi, type FakeHandlers } from './fake-api';
import { assetSummary, nextId, pageOf, projectSummary, tagOf } from './fixtures';
import { renameHandlers, renameThroughDialog, RenameTrigger } from './rename-flow';

afterEach(() => {
  vi.useRealTimers();
});

const TYPE: AssetType = {
  id: nextId(),
  key: 'tree',
  name: 'Tree',
  sortOrder: 0,
  builtIn: true,
  defaultWorkflowTemplateId: null,
};

const INITIAL: AssetListState = { filters: NO_FILTERS, scrollOffset: 0, openedIndex: null, selectedId: null };

type ListRequest = IpcRequest<'assets:list'>;

/** Serves `items` page by page; the unfiltered count call (`limit: 1`) gets `libraryTotal`. */
function listOf(items: AssetSummary[], libraryTotal: number = items.length) {
  return (request: ListRequest) =>
    request.limit === 1 && Object.keys(request).length === 2
      ? pageOf(items.slice(0, 1), libraryTotal)
      : pageOf(items.slice(request.offset, request.offset + request.limit), items.length);
}

function many(count: number): AssetSummary[] {
  return Array.from({ length: count }, (_, i) => assetSummary({ name: `Asset ${i}`, typeId: TYPE.id }));
}

function assignment(assetId: string, projectName: string): AssetAssignment {
  const project = projectSummary({ name: projectName });
  return {
    projectId: project.id,
    assetId,
    priority: 'normal',
    intendedUse: '',
    approvalStatus: 'pending',
    notes: '',
    assignedAt: project.createdAt,
    updatedAt: project.createdAt,
    project: {
      id: project.id,
      name: project.name,
      description: '',
      status: project.status,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
  };
}

function install(handlers: FakeHandlers) {
  return installFakeApi({
    'assetTypes:list': () => [TYPE],
    'projects:list': () => pageOf([]),
    'assignments:listByAsset': () => [],
    'tags:suggest': () => [],
    ...handlers,
  });
}

function Harness(props: {
  initial?: AssetListState;
  onState?(s: AssetListState): void;
  onOpen?(id: string): void;
}) {
  const [state, setState] = useState(props.initial ?? INITIAL);
  return (
    <AssetsScreen
      state={state}
      onStateChange={(next) => {
        props.onState?.(next);
        setState(next);
      }}
      onOpen={props.onOpen ?? (() => {})}
    />
  );
}

function listRequests(api: ReturnType<typeof install>): ListRequest[] {
  return api.calls.filter((c) => c.channel === 'assets:list').map((c) => c.request as ListRequest);
}

/** The tile (or table row) that shows `name`. */
function itemOf(name: string): HTMLElement {
  const element = within(screen.getByRole('grid', { name: 'Assets' })).getByText(name).closest<HTMLElement>('[data-index]');
  if (element === null) throw new Error(`no item for ${name}`);
  return element;
}

function selectionColumn(): HTMLElement {
  return screen.getByRole('complementary');
}

it('the title count comes from an unfiltered limit-1 call', async () => {
  const items = many(3);
  const api = install({ 'assets:list': listOf(items, 12) });
  render(<Harness initial={{ ...INITIAL, filters: { ...NO_FILTERS, status: 'in_review' } }} />);
  await screen.findByText('Asset 0');
  await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: /Assets/ }).textContent).toBe('Assets12'));
  expect(listRequests(api)).toContainEqual({ limit: 1, offset: 0 });
  expect(listRequests(api)).toContainEqual({ limit: 60, offset: 0, status: 'in_review' });
  expect(screen.getByText('3 assets')).toBeTruthy();
});

it('typing searches after 250 ms and old tiles stay until the new page arrives', async () => {
  const oak = assetSummary({ name: 'Oak tree', typeId: TYPE.id });
  const pine = assetSummary({ name: 'Pine', typeId: TYPE.id });
  const later = deferred<{ items: AssetSummary[]; total: number }>();
  const api = install({
    'assets:list': (request) => (request.query === 'pine' ? later.promise : listOf([oak])(request)),
  });
  render(<Harness />);
  await screen.findByText('Oak tree');
  await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: /Assets/ }).textContent).toBe('Assets1'));
  const tile = itemOf('Oak tree');

  vi.useFakeTimers();
  const search = screen.getByRole('searchbox', { name: 'Search assets' });
  for (const text of ['p', 'pi', 'pin', 'pine ']) fireEvent.change(search, { target: { value: text } });
  act(() => vi.advanceTimersByTime(249));
  expect(listRequests(api).some((r) => r.query !== undefined)).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  expect(listRequests(api).filter((r) => r.query !== undefined)).toEqual([{ limit: 60, offset: 0, query: 'pine' }]);

  // The old tile stays, the same element: the view is not remounted before the new page arrives.
  expect(itemOf('Oak tree')).toBe(tile);
  await act(async () => later.resolve(pageOf([pine])));
  expect(screen.getByText('Pine')).toBeTruthy();
  expect(screen.queryByText('Oak tree')).toBeNull();
  expect(listRequests(api).filter((r) => r.query !== undefined).map((r) => r.query)).toEqual(['pine']);
});

it('a single click selects and fills the Selection column; double-click and Enter open', async () => {
  const user = userEvent.setup();
  const oak = assetSummary({ name: 'Oak tree', typeId: TYPE.id, status: 'in_review', fileCount: 4, tags: [tagOf('Oak')] });
  const pine = assetSummary({ name: 'Pine', typeId: TYPE.id });
  const onOpen = vi.fn();
  const api = install({
    'assets:list': listOf([oak, pine]),
    'assignments:listByAsset': ({ assetId }) => (assetId === oak.id ? [assignment(oak.id, 'P1'), assignment(oak.id, 'P2')] : []),
  });
  render(<Harness onOpen={onOpen} />);
  await screen.findByText('Oak tree');
  const column = selectionColumn();
  expect(within(column).getByRole('heading', { name: 'Selection' })).toBeTruthy();
  expect(within(column).queryByText('Oak tree')).toBeNull();

  await user.click(itemOf('Oak tree'));
  expect(itemOf('Oak tree').getAttribute('aria-selected')).toBe('true');
  expect(itemOf('Pine').getAttribute('aria-selected')).toBe('false');
  expect(onOpen).not.toHaveBeenCalled();
  expect(within(column).getByText('Oak tree')).toBeTruthy();
  expect(within(column).getByText('Tree')).toBeTruthy();
  expect(within(column).getByText('In review')).toBeTruthy();
  expect(within(column).getByText('4')).toBeTruthy();
  expect(within(column).getByLabelText('Asset tags').textContent).toContain('Oak');
  expect(await within(column).findByText('P1, P2')).toBeTruthy();
  expect(api.calls.filter((c) => c.channel === 'assignments:listByAsset').map((c) => c.request)).toEqual([
    { assetId: oak.id },
  ]);

  await user.dblClick(itemOf('Oak tree'));
  expect(onOpen).toHaveBeenLastCalledWith(oak.id);

  await user.click(itemOf('Pine'));
  expect(await within(column).findByText('–', { selector: '[data-projects]' })).toBeTruthy();
  await user.keyboard('{Enter}');
  expect(onOpen).toHaveBeenLastCalledWith(pine.id);

  await user.click(within(column).getByRole('button', { name: 'Open asset' }));
  expect(onOpen).toHaveBeenCalledTimes(3);
  expect(onOpen).toHaveBeenLastCalledWith(pine.id);
});

it('arrow keys move focus and selection together', async () => {
  const user = userEvent.setup();
  const items = many(20);
  const onState = vi.fn();
  install({ 'assets:list': listOf(items) });
  render(<Harness onState={onState} />);
  await screen.findByText('Asset 0');
  await user.click(itemOf('Asset 0'));
  expect(document.activeElement).toBe(itemOf('Asset 0'));

  await user.keyboard('{ArrowRight}');
  expect(document.activeElement).toBe(itemOf('Asset 1'));
  expect(itemOf('Asset 1').getAttribute('aria-selected')).toBe('true');
  expect(itemOf('Asset 0').getAttribute('aria-selected')).toBe('false');
  expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ selectedId: items[1]!.id }));

  // 1280 px wide: five columns of 240 + 16.
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(itemOf('Asset 6'));
  expect(itemOf('Asset 6').getAttribute('aria-selected')).toBe('true');
  expect(within(selectionColumn()).getByText('Asset 6')).toBeTruthy();

  // Roving tab index: only the active tile is reachable with Tab.
  const tabbable = screen.getAllByRole('gridcell').filter((cell) => cell.tabIndex === 0);
  expect(tabbable).toEqual([itemOf('Asset 6')]);
});

const ANALYSIS: FakeHandlers = {
  'settings:getVision': () => ({
    baseUrl: 'http://127.0.0.1:11500',
    timeoutSeconds: 120,
    taggingModel: 'vision-a',
    promptModel: null,
    hasApiKey: false,
    fromEnvironment: false,
    canStoreKey: true,
  }),
  'settings:listVisionModels': () => ({ ok: true, models: [{ name: 'vision-a', vision: true }] }),
  'analysis:preview': () => ({ analysable: 3, alreadyAnalysed: 0, alreadyQueued: 0, notAnalysable: 0 }),
  'analysis:enqueue': () => ({ enqueued: 3, skipped: { notFound: 0, notAnalysable: 0, alreadyQueued: 0, alreadyAnalysed: 0 } }),
};

function renderWithProvider(initial: AssetListState = INITIAL) {
  return render(
    <ProviderSettingsProvider>
      <AnalysisPromptsProvider>
        <Harness initial={initial} />
      </AnalysisPromptsProvider>
    </ProviderSettingsProvider>,
  );
}

it('Analyse all starts the current asset filter and shows the outcome', async () => {
  const user = userEvent.setup();
  const api = install({ 'assets:list': listOf(many(2)), ...ANALYSIS });
  renderWithProvider({ ...INITIAL, filters: { ...NO_FILTERS, status: 'in_review', tagNames: ['oak'] } });
  await screen.findByText('Asset 0');
  await user.click(screen.getByRole('button', { name: 'Analyse all' }));
  await screen.findByRole('dialog', { name: 'Analyse' });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false));
  expect(api.calls.find((c) => c.channel === 'analysis:preview')?.request).toEqual({
    target: { kind: 'assetFilter', filter: { status: 'in_review', tagNames: ['oak'] } },
    model: 'vision-a',
  });
  await user.click(screen.getByRole('button', { name: 'Start' }));
  expect(within(await screen.findByRole('status')).getByText('3 queued')).toBeTruthy();
});

it('Analyse in the Selection column starts the selected asset', async () => {
  const user = userEvent.setup();
  const oak = assetSummary({ name: 'Oak tree', typeId: TYPE.id });
  const api = install({ 'assets:list': listOf([oak]), ...ANALYSIS });
  renderWithProvider();
  await user.click(await screen.findByText('Oak tree'));
  await user.click(within(selectionColumn()).getByRole('button', { name: 'Analyse' }));
  await screen.findByRole('dialog', { name: 'Analyse' });
  await waitFor(() => expect(api.calls.some((c) => c.channel === 'analysis:preview')).toBe(true));
  expect(api.calls.find((c) => c.channel === 'analysis:preview')?.request).toEqual({
    target: { kind: 'asset', assetId: oak.id },
    model: 'vision-a',
  });
});

it('without a configured provider Analyse all and the Selection Analyse are disabled', async () => {
  const user = userEvent.setup();
  const oak = assetSummary({ name: 'Oak tree', typeId: TYPE.id });
  install({
    'assets:list': listOf([oak]),
    ...ANALYSIS,
    'settings:getVision': () => ({
      baseUrl: null,
      timeoutSeconds: 120,
      taggingModel: null,
      promptModel: null,
      hasApiKey: false,
      fromEnvironment: false,
      canStoreKey: true,
    }),
  });
  renderWithProvider();
  await user.click(await screen.findByText('Oak tree'));
  const all = screen.getByRole('button', { name: 'Analyse all' }) as HTMLButtonElement;
  await waitFor(() => expect(all.title).toBe(JOB_ERROR_MESSAGES.provider_not_configured));
  expect(all.disabled).toBe(true);
  const one = within(selectionColumn()).getByRole('button', { name: 'Analyse' }) as HTMLButtonElement;
  expect(one.disabled).toBe(true);
  expect(one.title).toBe(JOB_ERROR_MESSAGES.provider_not_configured);
});

it('the table view shows the columns and keeps the selection rules', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const oak = assetSummary({
    name: 'Oak tree',
    typeId: TYPE.id,
    workflowProgress: { done: 2, total: 5 },
    tags: [tagOf('Oak')],
    coverTags: [tagOf('Bark')],
  });
  install({ 'assets:list': listOf([oak]) });
  try {
    render(<Harness onOpen={onOpen} />);
    await screen.findByText('Oak tree');
    await user.click(screen.getByRole('button', { name: 'Show as table' }));
    expect(screen.getByRole('button', { name: 'Show as table' }).getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem('assetforge.assets.view')).toBe('table');
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['', 'Name', 'Type', 'Status', 'Progress', 'Asset tags', 'Image tags', 'Last change']);
    const row = itemOf('Oak tree');
    expect(row.getAttribute('role')).toBe('row');
    expect(within(row).getByText('2 / 5')).toBeTruthy();
    expect(within(row).getByLabelText('Asset tags').textContent).toContain('Oak');
    expect(within(row).getByRole('img', { name: 'Image tags' }).parentElement!.textContent).toContain('Bark');
    await user.click(row);
    expect(row.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledWith(oak.id);
  } finally {
    window.localStorage.clear();
  }
});

it('tiles separate cover file tags from asset tags', async () => {
  const oak = assetSummary({ name: 'Oak tree', typeId: TYPE.id, tags: [tagOf('Oak')], coverTags: [tagOf('Bark')] });
  install({ 'assets:list': listOf([oak]) });
  render(<Harness />);
  await screen.findByText('Oak tree');
  const tile = itemOf('Oak tree');
  const imageTags = within(tile).getByRole('img', { name: 'Image tags' }).parentElement!;
  const assetTags = within(tile).getByLabelText('Asset tags');
  expect(imageTags.textContent).toContain('Bark');
  expect(imageTags.textContent).not.toContain('Oak');
  expect(assetTags.textContent).toContain('Oak');
  expect(assetTags.textContent).not.toContain('Bark');
  expect(tile.textContent).toContain('Type Tree');
  expect(tile.textContent).toContain('Status Draft');
});

it('tags that matched the tag filter are highlighted', async () => {
  const oak = assetSummary({
    name: 'Oak tree',
    typeId: TYPE.id,
    tags: [tagOf('Oak'), tagOf('Tall')],
    coverTags: [tagOf('Bark')],
    matchedTags: [
      { name: 'oak', displayName: 'Oak', onAsset: true, onFiles: false },
      { name: 'bark', displayName: 'Bark', onAsset: false, onFiles: true },
    ],
  });
  install({ 'assets:list': listOf([oak]) });
  render(<Harness initial={{ ...INITIAL, filters: { ...NO_FILTERS, tagNames: ['oak', 'bark'] } }} />);
  await screen.findByText('Oak tree');
  const tile = itemOf('Oak tree');
  const matched = [...tile.querySelectorAll('[data-matched]')].map((chip) => chip.textContent);
  expect(matched.sort()).toEqual(['Bark', 'Oak']);
});

it('list state round trip keeps filters, selection and scroll offset', async () => {
  const user = userEvent.setup();
  const items = many(200);
  const onState = vi.fn();
  const api = install({ 'assets:list': listOf(items) });
  const { unmount } = render(<Harness onState={onState} />);
  await screen.findByText('Asset 0');

  await user.type(screen.getByRole('searchbox', { name: 'Search assets' }), 'oak');
  await user.type(screen.getByRole('combobox', { name: 'Tags' }), 'Bark{Enter}');
  await user.selectOptions(screen.getByRole('combobox', { name: 'File type' }), 'Image');
  const expected = { limit: 60, offset: 0, query: 'oak', tagNames: ['bark'], fileKind: 'image' };
  await waitFor(() => expect(listRequests(api).at(-1)).toEqual(expected));
  // The last request only proves it was sent: wait until the list has settled on the new page,
  // so the click cannot hit a stale tile that is about to be replaced.
  await waitFor(() => expect(document.querySelector('[aria-busy]')).toBeNull());
  await user.click(await screen.findByText('Asset 2'));
  await waitFor(() => expect(itemOf('Asset 2').getAttribute('aria-selected')).toBe('true'));

  const grid = screen.getByRole('grid', { name: 'Assets' });
  Object.defineProperty(grid, 'scrollTop', { configurable: true, value: 4400 });
  fireEvent.scroll(grid);
  unmount();
  const saved = onState.mock.lastCall![0] as AssetListState;
  expect(saved).toEqual({
    filters: { ...NO_FILTERS, query: 'oak', tagNames: ['bark'], fileKind: 'image' },
    scrollOffset: 4400,
    openedIndex: null,
    selectedId: items[2]!.id,
  });

  api.calls.length = 0;
  render(<Harness initial={saved} />);
  await waitFor(() => expect(listRequests(api)).toContainEqual({ ...expected, offset: 60 }));
  expect(listRequests(api)).toContainEqual(expected);
  expect((screen.getByRole('searchbox', { name: 'Search assets' }) as HTMLInputElement).value).toBe('oak');
  expect(screen.getByText('bark')).toBeTruthy();
  expect(await within(selectionColumn()).findByText('Asset 2')).toBeTruthy();
  // Row 13 of 336 px is at the top: tile 65 is rendered, tile 2 is not.
  expect(screen.getByText('Asset 65')).toBeTruthy();
  expect(screen.queryByText('Asset 2', { selector: '[role=gridcell] *' })).toBeNull();
});

it('opening an asset keeps its index and focuses it on return', async () => {
  const user = userEvent.setup();
  const items = many(20);
  const onState = vi.fn();
  install({ 'assets:list': listOf(items) });
  const { unmount } = render(<Harness onState={onState} onOpen={() => {}} />);
  await screen.findByText('Asset 7');
  await user.dblClick(itemOf('Asset 7'));
  const saved = onState.mock.lastCall![0] as AssetListState;
  expect(saved.openedIndex).toBe(7);
  expect(saved.selectedId).toBe(items[7]!.id);
  unmount();
  expect(onState.mock.lastCall![0]).toEqual(saved);

  render(<Harness initial={saved} />);
  await waitFor(() => expect(document.activeElement).toBe(itemOf('Asset 7')));
  expect(itemOf('Asset 7').getAttribute('aria-selected')).toBe('true');
});

it('empty library, no result and boot failure states', async () => {
  const user = userEvent.setup();
  const api = install({ 'assets:list': listOf([]) });
  const { unmount } = render(<Harness />);
  expect(await screen.findByText('No assets')).toBeTruthy();
  expect(screen.getByRole('button', { name: /New asset/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  unmount();

  const second = render(<Harness initial={{ ...INITIAL, filters: { ...NO_FILTERS, status: 'archived' } }} />);
  expect(await screen.findByText('No matching assets')).toBeTruthy();
  expect(screen.queryByText('No assets')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(await screen.findByText('No assets')).toBeTruthy();
  expect(listRequests(api).at(-1)).toEqual({ limit: 60, offset: 0 });
  second.unmount();

  let fail = true;
  install({
    'assets:list': (request) => {
      if (fail && request.limit === 60) throw fakeError('internal_error');
      return listOf([assetSummary({ name: 'Back', typeId: TYPE.id })])(request);
    },
  });
  render(<Harness />);
  const retry = await screen.findByRole('button', { name: 'Retry' });
  fail = false;
  await user.click(retry);
  expect(await screen.findByText('Back')).toBeTruthy();
});

it('a failed page shows a Retry slot in the gallery', async () => {
  const user = userEvent.setup();
  const items = many(200);
  let fail = true;
  install({
    'assets:list': (request) => {
      if (fail && request.offset === 60) throw fakeError('internal_error');
      return listOf(items)(request);
    },
  });
  render(<Harness initial={{ ...INITIAL, scrollOffset: 4400 }} />);
  const retry = await screen.findByRole('button', { name: 'Retry' });
  fail = false;
  await user.click(retry);
  expect(await screen.findByText('Asset 65')).toBeTruthy();
});

it('project names that fail to load show an alert inside the column', async () => {
  const user = userEvent.setup();
  const oak = assetSummary({ name: 'Oak tree', typeId: TYPE.id });
  install({
    'assets:list': listOf([oak]),
    'assignments:listByAsset': () => {
      throw fakeError('invalid_operation');
    },
  });
  render(<Harness />);
  await user.click(await screen.findByText('Oak tree'));
  const alert = await within(selectionColumn()).findByRole('alert');
  expect(alert.textContent).toBe('invalid_operation');
});

it('New asset creates an asset in a dialog and opens it', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const created = assetSummary({ name: 'Birch', typeId: TYPE.id });
  const api = install({
    'assets:list': listOf([]),
    'assets:create': ({ name, typeId }) => ({ ...created, name, typeId }),
  });
  render(<Harness onOpen={onOpen} />);
  await screen.findByText('No assets');
  const trigger = screen.getByRole('button', { name: /New asset/ });
  await user.click(trigger);
  const dialog = document.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  const name = within(dialog).getByRole('textbox', { name: 'Asset name' });
  expect(document.activeElement).toBe(name);
  expect((within(dialog).getByRole('combobox', { name: 'Asset type' }) as HTMLSelectElement).value).toBe(TYPE.id);
  await user.type(name, ' Birch {Enter}');
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(created.id));
  expect(api.calls.find((c) => c.channel === 'assets:create')?.request).toEqual({ name: 'Birch', typeId: TYPE.id });
});

it('a failed create shows the error in the dialog and Cancel returns focus', async () => {
  const user = userEvent.setup();
  install({
    'assets:list': listOf([]),
    'assets:create': () => {
      throw fakeError('invalid_operation');
    },
  });
  render(<Harness />);
  await screen.findByText('No assets');
  const trigger = screen.getByRole('button', { name: /New asset/ });
  await user.click(trigger);
  const dialog = document.querySelector('dialog')!;
  await user.type(within(dialog).getByRole('textbox', { name: 'Asset name' }), 'Birch{Enter}');
  expect((await within(dialog).findByRole('alert')).textContent).toBe('invalid_operation');
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(dialog.open).toBe(false);
  expect(document.activeElement).toBe(trigger);
});

/** The gallery inside a `TagsProvider` whose renames rewrite the filters, as the workspace shell does. */
function RenamingHarness(props: { initial: AssetListState }) {
  const [state, setState] = useState(props.initial);
  return (
    <TagsProvider onRenamed={(change) => setState((s) => ({ ...s, filters: renameInFilters(s.filters, change) }))}>
      <RenameTrigger tag={{ name: 'front view', displayName: 'Front View' }} />
      <AssetsScreen state={state} onStateChange={setState} onOpen={() => {}} />
    </TagsProvider>
  );
}

it('a rename switches a tag filter on the old name to the new one and reloads', async () => {
  const user = userEvent.setup();
  const api = install({ 'assets:list': listOf(many(2)), ...renameHandlers({ 'front view': 'Front View' }) });
  render(<RenamingHarness initial={{ ...INITIAL, filters: { ...NO_FILTERS, tagNames: ['front view'] } }} />);
  expect(await screen.findByRole('button', { name: 'Remove front view' })).toBeTruthy();
  await renameThroughDialog(user, 'Front View', 'front');
  await waitFor(() => expect(listRequests(api).some((r) => r.tagNames?.join() === 'front')).toBe(true));
  expect(screen.getByRole('button', { name: 'Remove front' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Remove front view' })).toBeNull();
});

it('a merge into a name the filter already holds leaves one chip', async () => {
  const user = userEvent.setup();
  const api = install({
    'assets:list': listOf(many(2)),
    ...renameHandlers({ 'front view': 'Front View', front: 'Front' }),
  });
  render(<RenamingHarness initial={{ ...INITIAL, filters: { ...NO_FILTERS, tagNames: ['front view', 'front'] } }} />);
  expect(await screen.findByRole('button', { name: 'Remove front view' })).toBeTruthy();
  await renameThroughDialog(user, 'Front View', 'front');
  await waitFor(() => expect(listRequests(api).some((r) => r.tagNames?.join() === 'front')).toBe(true));
  expect(screen.getAllByRole('button', { name: 'Remove front' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Remove front view' })).toBeNull();
});

it('a rename of a tag outside the filter still reloads the gallery', async () => {
  const user = userEvent.setup();
  const api = install({ 'assets:list': listOf(many(2)), ...renameHandlers({ 'front view': 'Front View' }) });
  render(<RenamingHarness initial={INITIAL} />);
  await screen.findByText('Asset 0');
  const before = listRequests(api).length;
  await renameThroughDialog(user, 'Front View', 'Side');
  await waitFor(() => expect(listRequests(api).length).toBeGreaterThan(before));
  expect(screen.getByText('Asset 0')).toBeTruthy();
});
