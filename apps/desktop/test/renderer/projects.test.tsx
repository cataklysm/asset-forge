import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type {
  AssetList,
  AssetType,
  IpcRequest,
  Project,
  ProjectMember,
  ProjectSummary,
} from '@assetforge/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceShell } from '../../src/renderer/src/components/WorkspaceShell';
import { NO_PROJECT_FILTERS, type AssetFilters, type ProjectListState } from '../../src/renderer/src/list-state';
import { ProjectScreen } from '../../src/renderer/src/screens/ProjectScreen';
import { ProjectsScreen } from '../../src/renderer/src/screens/ProjectsScreen';
import { deferred, fakeError, installFakeApi, type FakeHandlers } from './fake-api';
import { assetSummary, nextId, pageOf, projectSummary, tagOf } from './fixtures';

afterEach(() => {
  vi.useRealTimers();
});

const NOW = '2026-01-01T00:00:00.000Z';

const TYPE: AssetType = {
  id: nextId(),
  key: 'tree',
  name: 'Tree',
  sortOrder: 0,
  builtIn: true,
  defaultWorkflowTemplateId: null,
};

const INITIAL: ProjectListState = { filters: NO_PROJECT_FILTERS, scrollOffset: 0, selectedId: null };

type ListRequest = IpcRequest<'projects:list'>;

/** Serves `items` page by page; the unfiltered count call (`limit: 1`) gets `allTotal`. */
function listOf(items: ProjectSummary[], allTotal: number = items.length) {
  return (request: ListRequest) =>
    request.limit === 1 && Object.keys(request).length === 2
      ? pageOf(items.slice(0, 1), allTotal)
      : pageOf(items.slice(request.offset, request.offset + request.limit), items.length);
}

function many(count: number): ProjectSummary[] {
  return Array.from({ length: count }, (_, i) => projectSummary({ name: `Project ${i}` }));
}

function install(handlers: FakeHandlers) {
  return installFakeApi({
    'assetTypes:list': () => [TYPE],
    'tags:suggest': () => [],
    'assets:list': () => pageOf([]),
    ...handlers,
  });
}

interface HarnessProps {
  initial?: ProjectListState;
  onState?(s: ProjectListState): void;
  onOpen?(id: string): void;
  onOpenAsset?(id: string): void;
  onShowAssets?(f: Pick<AssetFilters, 'projectId' | 'tagNames'>): void;
}

function Harness(props: HarnessProps) {
  const [state, setState] = useState(props.initial ?? INITIAL);
  return (
    <ProjectsScreen
      state={state}
      onStateChange={(next) => {
        props.onState?.(next);
        setState(next);
      }}
      onOpen={props.onOpen ?? (() => {})}
      onOpenAsset={props.onOpenAsset ?? (() => {})}
      onShowAssets={props.onShowAssets ?? (() => {})}
    />
  );
}

function listRequests(api: ReturnType<typeof install>): ListRequest[] {
  return api.calls.filter((c) => c.channel === 'projects:list').map((c) => c.request as ListRequest);
}

function rowOf(name: string): HTMLElement {
  const row = within(screen.getByRole('grid', { name: 'Projects' })).getByText(name).closest<HTMLElement>('[data-index]');
  if (row === null) throw new Error(`no row for ${name}`);
  return row;
}

function details(): HTMLElement {
  return screen.getByRole('complementary');
}

it('search, status and tags go into projects:list after the debounce', async () => {
  const user = userEvent.setup();
  const api = install({ 'projects:list': listOf(many(3), 9) });
  render(<Harness />);
  await screen.findByText('Project 0');
  await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: /Projects/ }).textContent).toBe('Projects9'));
  expect(listRequests(api)).toContainEqual({ limit: 1, offset: 0 });
  expect(listRequests(api)).toContainEqual({ limit: 60, offset: 0 });
  expect(screen.getByText('3 projects')).toBeTruthy();

  await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'archived');
  await waitFor(() => expect(listRequests(api).at(-1)).toEqual({ limit: 60, offset: 0, status: 'archived' }));
  await user.type(screen.getByRole('combobox', { name: 'Tags' }), 'Bark{Enter}');
  await waitFor(() =>
    expect(listRequests(api).at(-1)).toEqual({ limit: 60, offset: 0, status: 'archived', tagNames: ['bark'] }),
  );

  vi.useFakeTimers();
  const search = screen.getByRole('searchbox', { name: 'Search projects' });
  for (const text of ['o', 'oa', 'oak', 'oak ']) fireEvent.change(search, { target: { value: text } });
  act(() => vi.advanceTimersByTime(249));
  expect(listRequests(api).some((r) => r.query !== undefined)).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  expect(listRequests(api).filter((r) => r.query !== undefined)).toEqual([
    { limit: 60, offset: 0, query: 'oak', status: 'archived', tagNames: ['bark'] },
  ]);
});

it('Matching tags shows file-matched tags after an image icon', async () => {
  const project = projectSummary({
    name: 'Forest',
    assetCount: 2,
    matchedTags: [
      { name: 'oak', displayName: 'oak', onAsset: true, onFiles: false },
      { name: 'bark', displayName: 'bark', onAsset: false, onFiles: true },
    ],
  });
  install({ 'projects:list': listOf([project]) });
  render(<Harness initial={{ ...INITIAL, filters: { ...NO_PROJECT_FILTERS, tagNames: ['oak', 'bark'] } }} />);
  await screen.findByText('Forest');
  const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
  expect(headers).toEqual(['Project', 'Status', 'Assets', 'Matching tags', '']);
  const row = rowOf('Forest');
  const cell = within(row).getAllByRole('gridcell')[3]!;
  const oak = within(cell).getByText('oak');
  const icon = within(cell).getByRole('img', { name: 'Image tags' });
  const bark = within(cell).getByText('bark');
  expect(oak.compareDocumentPosition(icon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(icon.compareDocumentPosition(bark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect([...cell.querySelectorAll('[data-matched]')].map((chip) => chip.textContent)).toEqual(['oak', 'bark']);
});

it('without a tag filter there is no Matching tags column', async () => {
  install({ 'projects:list': listOf([projectSummary({ name: 'Forest', assetCount: 4, status: 'on_hold' })]) });
  render(<Harness />);
  await screen.findByText('Forest');
  expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Project', 'Status', 'Assets', '']);
  const row = rowOf('Forest');
  expect(within(row).getByText('4')).toBeTruthy();
  expect(within(row).getByText('On hold')).toBeTruthy();
});

it('a click selects, double-click, Enter and Open open the project', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const [a, b] = [projectSummary({ name: 'Forest' }), projectSummary({ name: 'Desert' })];
  install({ 'projects:list': listOf([a!, b!]) });
  render(<Harness onOpen={onOpen} />);
  await screen.findByText('Forest');
  await user.click(rowOf('Forest'));
  expect(rowOf('Forest').getAttribute('aria-selected')).toBe('true');
  expect(rowOf('Desert').getAttribute('aria-selected')).toBe('false');
  expect(onOpen).not.toHaveBeenCalled();

  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(rowOf('Desert'));
  expect(rowOf('Desert').getAttribute('aria-selected')).toBe('true');
  await user.keyboard('{Enter}');
  expect(onOpen).toHaveBeenLastCalledWith(b!.id);

  await user.dblClick(rowOf('Forest'));
  expect(onOpen).toHaveBeenLastCalledWith(a!.id);

  await user.click(within(rowOf('Desert')).getByRole('button', { name: 'Open Desert' }));
  expect(onOpen).toHaveBeenLastCalledWith(b!.id);
  expect(onOpen).toHaveBeenCalledTimes(3);

  const tabbable = screen.getAllByRole('row').filter((row) => row.tabIndex === 0);
  expect(tabbable).toEqual([rowOf('Desert')]);
});

it('selecting a project fills Project details with Images and Matching content', async () => {
  const user = userEvent.setup();
  const onOpenAsset = vi.fn();
  const project = projectSummary({
    name: 'Forest',
    status: 'on_hold',
    assetCount: 3,
    imageCount: 7,
    description: 'Trees for the northern map',
    matchedTags: [{ name: 'oak', displayName: 'Oak', onAsset: true, onFiles: true }],
  });
  const asset = assetSummary({
    name: 'Old oak',
    typeId: TYPE.id,
    status: 'in_review',
    tags: [tagOf('Oak'), tagOf('Tall')],
    coverTags: [tagOf('Bark')],
    matchedTags: [{ name: 'oak', displayName: 'Oak', onAsset: true, onFiles: true }],
  });
  const api = install({
    'projects:list': listOf([project]),
    'assets:list': () => pageOf([asset]),
  });
  render(
    <Harness onOpenAsset={onOpenAsset} initial={{ ...INITIAL, filters: { ...NO_PROJECT_FILTERS, tagNames: ['oak'] } }} />,
  );
  await screen.findByText('Forest');
  const column = details();
  expect(within(column).getByRole('heading', { name: 'Project details' })).toBeTruthy();
  expect(within(column).queryByText('Forest')).toBeNull();

  await user.click(rowOf('Forest'));
  expect(within(column).getByText('Forest')).toBeTruthy();
  expect(within(column).getByText('On hold')).toBeTruthy();
  expect(within(column).getByText('3')).toBeTruthy();
  expect(within(column).getByText('7')).toBeTruthy();
  expect(within(column).getByText('Trees for the northern map')).toBeTruthy();

  const content = await within(column).findByRole('region', { name: 'Matching content' });
  expect(api.calls.filter((c) => c.channel === 'assets:list').map((c) => c.request)).toEqual([
    { projectId: project.id, tagNames: ['oak'], limit: 20, offset: 0 },
  ]);
  const link = await within(content).findByRole('link', { name: 'Old oak' });
  expect(within(content).getByText('Tree')).toBeTruthy();
  expect(within(content).getByText('In review')).toBeTruthy();
  expect(within(content).getByLabelText('Asset tags').textContent).toBe('OakTall');
  const imageTags = within(content).getByRole('img', { name: 'Image tags' }).parentElement!;
  // The cover tags plus the file tag that matched.
  expect(imageTags.textContent).toBe('BarkOak');
  expect([...content.querySelectorAll('[data-matched]')].map((chip) => chip.textContent)).toEqual(['Oak', 'Oak']);
  expect(within(column).queryByRole('button', { name: 'Show all' })).toBeNull();

  await user.click(link);
  expect(onOpenAsset).toHaveBeenCalledWith(asset.id);
});

it('Matching content shows only the answer for the current selection and reports failures', async () => {
  const user = userEvent.setup();
  const [a, b] = [projectSummary({ name: 'Forest' }), projectSummary({ name: 'Desert' })];
  const late = deferred<AssetList>();
  install({
    'projects:list': listOf([a!, b!]),
    'assets:list': (request) => {
      if (request.projectId === a!.id) return late.promise;
      throw fakeError('invalid_operation');
    },
  });
  render(<Harness initial={{ ...INITIAL, filters: { ...NO_PROJECT_FILTERS, tagNames: ['oak'] } }} />);
  await screen.findByText('Forest');
  await user.click(rowOf('Forest'));
  await user.click(rowOf('Desert'));
  const alert = await within(details()).findByRole('alert');
  expect(alert.textContent).toBe('invalid_operation');
  await act(async () => late.resolve(pageOf([assetSummary({ name: 'Old oak', typeId: TYPE.id })])));
  expect(within(details()).queryByText('Old oak')).toBeNull();
  expect(within(details()).getByText('Desert')).toBeTruthy();
});

it('Show all opens the gallery filtered by project and tags', async () => {
  const user = userEvent.setup();
  const onShowAssets = vi.fn();
  const project = projectSummary({ name: 'Forest' });
  const assets = Array.from({ length: 20 }, (_, i) => assetSummary({ name: `Asset ${i}`, typeId: TYPE.id }));
  install({ 'projects:list': listOf([project]), 'assets:list': () => pageOf(assets, 25) });
  render(
    <Harness
      onShowAssets={onShowAssets}
      initial={{ ...INITIAL, selectedId: project.id, filters: { ...NO_PROJECT_FILTERS, tagNames: ['oak', 'bark'] } }}
    />,
  );
  await user.click(await within(details()).findByRole('button', { name: 'Show all' }));
  expect(onShowAssets).toHaveBeenCalledWith({ projectId: project.id, tagNames: ['oak', 'bark'] });
});

it('Show all in the shell switches to the assets gallery with the project and tag filter', async () => {
  const user = userEvent.setup();
  const project = projectSummary({ name: 'Forest' });
  const assets = Array.from({ length: 20 }, (_, i) => assetSummary({ name: `Asset ${i}`, typeId: TYPE.id }));
  const api = install({
    'projects:list': listOf([project]),
    'assets:list': (request) => pageOf(assets.slice(0, Math.min(request.limit, 20)), 25),
    'assignments:listByAsset': () => [],
  });
  render(
    <WorkspaceShell
      workspace={{ id: nextId(), name: 'W', rootPath: 'root', lastOpenedAt: NOW }}
      onClosed={() => {}}
    />,
  );
  await user.click(screen.getByRole('link', { name: /Projects/ }));
  await user.click(await screen.findByText('Forest'));
  await user.type(screen.getByRole('combobox', { name: 'Tags' }), 'Oak{Enter}');
  api.calls.length = 0;
  await user.click(await within(details()).findByRole('button', { name: 'Show all' }));
  await waitFor(() =>
    expect(api.calls.map((c) => c.request)).toContainEqual({ limit: 60, offset: 0, projectId: project.id, tagNames: ['oak'] }),
  );
  expect((screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement).value).toBe(project.id);
});

it('list state round trip keeps filters, scroll offset and selection', async () => {
  const user = userEvent.setup();
  const items = many(200);
  const onState = vi.fn();
  const api = install({ 'projects:list': listOf(items) });
  const { unmount } = render(<Harness onState={onState} />);
  await screen.findByText('Project 0');

  await user.type(screen.getByRole('searchbox', { name: 'Search projects' }), 'oak');
  await user.type(screen.getByRole('combobox', { name: 'Tags' }), 'Bark{Enter}');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'active');
  const expected = { limit: 60, offset: 0, query: 'oak', tagNames: ['bark'], status: 'active' };
  await waitFor(() => expect(listRequests(api).at(-1)).toEqual(expected));
  // The last request only proves it was sent: wait until the list has settled on the new page,
  // so the click cannot hit a stale row that is about to be replaced.
  await waitFor(() => expect(document.querySelector('[aria-busy]')).toBeNull());
  await user.click(await screen.findByText('Project 2'));
  await waitFor(() => expect(rowOf('Project 2').getAttribute('aria-selected')).toBe('true'));

  const grid = screen.getByRole('grid', { name: 'Projects' });
  Object.defineProperty(grid, 'scrollTop', { configurable: true, value: 4800 });
  fireEvent.scroll(grid);
  unmount();
  const saved = onState.mock.lastCall![0] as ProjectListState;
  expect(saved).toEqual({
    filters: { query: 'oak', tagNames: ['bark'], status: 'active' },
    scrollOffset: 4800,
    selectedId: items[2]!.id,
  });

  api.calls.length = 0;
  render(<Harness initial={saved} />);
  await waitFor(() => expect(listRequests(api)).toContainEqual({ ...expected, offset: 60 }));
  expect(listRequests(api)).toContainEqual(expected);
  expect((screen.getByRole('searchbox', { name: 'Search projects' }) as HTMLInputElement).value).toBe('oak');
  expect(within(details()).getByText('Project 2')).toBeTruthy();
  // 48 px rows: row 100 is at the top, row 2 is not rendered.
  expect(await screen.findByText('Project 100')).toBeTruthy();
  expect(screen.queryByText('Project 2', { selector: '[role=gridcell] *' })).toBeNull();
});

it('opening a project keeps the scroll offset and the selection', async () => {
  const user = userEvent.setup();
  const items = many(20);
  const onState = vi.fn();
  const onOpen = vi.fn();
  install({ 'projects:list': listOf(items) });
  const { unmount } = render(<Harness onState={onState} onOpen={onOpen} />);
  await user.dblClick(await screen.findByText('Project 7'));
  expect(onOpen).toHaveBeenCalledWith(items[7]!.id);
  const saved = onState.mock.lastCall![0] as ProjectListState;
  expect(saved.selectedId).toBe(items[7]!.id);
  unmount();
  expect(onState.mock.lastCall![0]).toEqual(saved);
});

it('empty and no-result states', async () => {
  const user = userEvent.setup();
  const api = install({ 'projects:list': listOf([]) });
  const { unmount } = render(<Harness />);
  expect(await screen.findByText('No projects')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  unmount();

  render(<Harness initial={{ ...INITIAL, filters: { ...NO_PROJECT_FILTERS, status: 'archived' } }} />);
  expect(await screen.findByText('No matching projects')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(await screen.findByText('No projects')).toBeTruthy();
  expect(listRequests(api).at(-1)).toEqual({ limit: 60, offset: 0 });
});

it('a failed first page shows Retry', async () => {
  const user = userEvent.setup();
  let fail = true;
  install({
    'projects:list': (request) => {
      if (fail && request.limit === 60) throw fakeError('internal_error');
      return listOf([projectSummary({ name: 'Back' })])(request);
    },
  });
  render(<Harness />);
  const retry = await screen.findByRole('button', { name: 'Retry' });
  fail = false;
  await user.click(retry);
  expect(await screen.findByText('Back')).toBeTruthy();
});

it('New project creates a project with a description and opens it', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const created: Project = { id: nextId(), name: 'Forest', description: 'North', status: 'active', createdAt: NOW, updatedAt: NOW };
  const api = install({ 'projects:list': listOf([]), 'projects:create': () => created });
  render(<Harness onOpen={onOpen} />);
  await screen.findByText('No projects');
  const trigger = screen.getByRole('button', { name: /New project/ });
  await user.click(trigger);
  const dialog = document.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  const name = within(dialog).getByRole('textbox', { name: 'Project name' });
  expect(document.activeElement).toBe(name);
  await user.type(name, ' Forest ');
  await user.type(within(dialog).getByRole('textbox', { name: 'Description' }), 'North');
  await user.click(within(dialog).getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(created.id));
  expect(api.calls.find((c) => c.channel === 'projects:create')?.request).toEqual({ name: 'Forest', description: 'North' });
});

it('a failed create shows the error in the dialog and Cancel returns focus', async () => {
  const user = userEvent.setup();
  install({
    'projects:list': listOf([]),
    'projects:create': () => {
      throw fakeError('invalid_operation');
    },
  });
  render(<Harness />);
  await screen.findByText('No projects');
  const trigger = screen.getByRole('button', { name: /New project/ });
  await user.click(trigger);
  const dialog = document.querySelector('dialog')!;
  await user.type(within(dialog).getByRole('textbox', { name: 'Project name' }), 'Forest{Enter}');
  expect((await within(dialog).findByRole('alert')).textContent).toBe('invalid_operation');
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(dialog.open).toBe(false);
  expect(document.activeElement).toBe(trigger);
});

// The project screen

function member(projectId: string, name: string): ProjectMember {
  const asset = { id: nextId(), name, typeId: TYPE.id, description: '', status: 'in_review' as const, createdAt: NOW, updatedAt: NOW };
  return {
    projectId,
    assetId: asset.id,
    priority: 'normal',
    intendedUse: '',
    approvalStatus: 'pending',
    notes: 'Keep the bark',
    assignedAt: NOW,
    updatedAt: NOW,
    asset,
  };
}

it('the project screen keeps the member pager and member editing', async () => {
  const user = userEvent.setup();
  const onNavigate = vi.fn();
  const project: Project = { id: nextId(), name: 'Forest', description: 'North', status: 'active', createdAt: NOW, updatedAt: NOW };
  const members = Array.from({ length: 120 }, (_, i) => member(project.id, `Member ${i}`));
  const api = installFakeApi({
    'projects:get': () => project,
    'projects:update': ({ patch }) => ({ ...project, ...patch }),
    'assetTypes:list': () => [TYPE],
    'assignments:listByProject': ({ limit, offset }) => pageOf(members.slice(offset, offset + limit), members.length),
    'assignments:update': ({ patch }) => ({ ...members[0]!, ...patch }),
    'assignments:remove': () => null,
    'assets:list': () => pageOf([]),
  });
  render(<ProjectScreen id={project.id} onNavigate={onNavigate} />);

  const breadcrumb = await screen.findByRole('navigation', { name: 'Breadcrumb' });
  expect(breadcrumb.textContent).toBe('Projects / Forest');
  await user.click(within(breadcrumb).getByRole('link', { name: 'Projects' }));
  expect(onNavigate).toHaveBeenCalledWith({ name: 'projects' });

  const nameField = screen.getByRole('textbox', { name: 'Name' });
  await user.clear(nameField);
  await user.type(nameField, 'Woods{Enter}');
  await waitFor(() =>
    expect(api.calls.find((c) => c.channel === 'projects:update')?.request).toEqual({ id: project.id, patch: { name: 'Woods' } }),
  );
  await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'archived');
  expect(api.calls.filter((c) => c.channel === 'projects:update').at(-1)?.request).toEqual({
    id: project.id,
    patch: { status: 'archived' },
  });
  expect((screen.getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement).value).toBe('North');

  const table = await screen.findByRole('table', { name: 'Members' });
  const row = (await within(table).findByText('Member 0')).closest('tr')!;
  expect(within(row).getByText('Tree')).toBeTruthy();
  expect(within(row).getByText('In review')).toBeTruthy();
  await user.click(within(row).getByRole('link', { name: 'Member 0' }));
  expect(onNavigate).toHaveBeenLastCalledWith({ name: 'asset', id: members[0]!.assetId });

  await user.selectOptions(within(row).getByRole('combobox', { name: 'Priority' }), 'high');
  await waitFor(() =>
    expect(api.calls.find((c) => c.channel === 'assignments:update')?.request).toEqual({
      projectId: project.id,
      assetId: members[0]!.assetId,
      patch: { priority: 'high' },
    }),
  );
  expect(within(row).getByRole('combobox', { name: 'Approval' })).toBeTruthy();
  expect(within(row).getByRole('textbox', { name: 'Intended use' })).toBeTruthy();

  // Notes live in an expandable row.
  expect(within(table).queryByRole('textbox', { name: 'Notes' })).toBeNull();
  const toggle = within(row).getByRole('button', { name: 'Notes for Member 0' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  await user.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect((within(table).getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement).value).toBe('Keep the bark');

  const remove = within(row).getByRole('button', { name: 'Remove Member 0 from Forest' });
  expect(remove.getAttribute('title')).toBe('Removes the assignment only; the asset and its files are kept');
  await user.click(remove);
  await waitFor(() =>
    expect(api.calls.find((c) => c.channel === 'assignments:remove')?.request).toEqual({
      projectId: project.id,
      assetId: members[0]!.assetId,
    }),
  );

  // The member pager of 50.
  const pager = screen.getByRole('navigation', { name: 'Pagination' });
  expect(pager.textContent).toContain('1–50 of 120');
  await user.click(within(pager).getByRole('button', { name: 'Next' }));
  expect(await screen.findByText('Member 50')).toBeTruthy();
  expect(api.calls.filter((c) => c.channel === 'assignments:listByProject').map((c) => c.request)).toContainEqual({
    projectId: project.id,
    limit: 50,
    offset: 50,
  });

  // Add asset excludes every member, including those on other pages.
  expect(api.calls.filter((c) => c.channel === 'assignments:listByProject').map((c) => c.request)).toContainEqual({
    projectId: project.id,
    limit: 200,
    offset: 0,
  });
  expect(screen.getByRole('combobox', { name: 'Search assets' })).toBeTruthy();
});
