import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type {
  AssetAssignment,
  AssetDetail,
  AssetRelationView,
  AssetType,
  FileRecord,
  IpcRequest,
} from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { NONE_ANALYSABLE } from '../../src/renderer/src/analysis';
import type { AssetTab } from '../../src/renderer/src/list-state';
import { AssetScreen } from '../../src/renderer/src/screens/AssetScreen';
import { deferred, fakeError, installFakeApi, type FakeHandlers } from './fake-api';
import { applyFiles, enqueueAll, fileRecord, nextId, NONE_SKIPPED, nonImageRecord, pageOf, tagOf } from './fixtures';

const NOW = '2026-01-01T00:00:00.000Z';
const TYPE: AssetType = {
  id: nextId(),
  key: 'prop',
  name: 'Prop',
  sortOrder: 0,
  builtIn: true,
  defaultWorkflowTemplateId: null,
};

function assetDetail(p: Partial<AssetDetail> = {}): AssetDetail {
  return {
    id: nextId(),
    name: 'Oak tree',
    typeId: TYPE.id,
    description: '',
    status: 'draft',
    createdAt: NOW,
    updatedAt: NOW,
    coverFileId: null,
    coverIsChosen: false,
    tags: [],
    ...p,
  };
}

function project(name: string) {
  return { id: nextId(), name, description: '', status: 'active' as const, createdAt: NOW, updatedAt: NOW };
}

function assignment(assetId: string, name: string): AssetAssignment {
  const p = project(name);
  return {
    projectId: p.id,
    assetId,
    priority: 'normal',
    intendedUse: '',
    approvalStatus: 'pending',
    notes: '',
    assignedAt: NOW,
    updatedAt: NOW,
    project: p,
  };
}

function relation(assetId: string, otherName: string): AssetRelationView {
  const other = { id: nextId(), name: otherName, typeId: TYPE.id, description: '', status: 'draft' as const, createdAt: NOW, updatedAt: NOW };
  return { fromAssetId: assetId, toAssetId: other.id, kind: 'uses', createdAt: NOW, direction: 'outgoing', other };
}

type ListRequest = IpcRequest<'files:list'>;

function listOf(items: FileRecord[]) {
  return (request: ListRequest) => pageOf(items.slice(request.offset, request.offset + request.limit), items.length);
}

function install(asset: AssetDetail, handlers: FakeHandlers = {}) {
  return installFakeApi({
    'assets:get': () => asset,
    'assetTypes:list': () => [TYPE],
    'assignments:listByAsset': () => [],
    'projects:list': () => pageOf([]),
    'relations:list': () => [],
    'files:list': listOf([]),
    'workflows:get': () => null,
    'workflowTemplates:list': () => [],
    'tags:suggest': () => [],
    'assets:list': () => pageOf([]),
    ...handlers,
  });
}

interface HarnessProps {
  id: string;
  initialTab?: AssetTab;
  onTabChange?(tab: AssetTab): void;
  onBack?(): void;
  onOpenAsset?(id: string): void;
  onOpenProject?(id: string): void;
  onBusyChange?(busy: boolean): void;
}

function Harness(props: HarnessProps) {
  const [tab, setTab] = useState<AssetTab>(props.initialTab ?? 'files');
  const [mounted, setMounted] = useState(true);
  return (
    <div className="flex h-[800px] flex-col">
      <button type="button" onClick={() => setMounted((m) => !m)}>
        Toggle
      </button>
      {mounted && (
        <AssetScreen
          id={props.id}
          tab={tab}
          onTabChange={(next) => {
            props.onTabChange?.(next);
            setTab(next);
          }}
          onBack={props.onBack ?? (() => {})}
          onOpenAsset={props.onOpenAsset ?? (() => {})}
          onOpenProject={props.onOpenProject ?? (() => {})}
          onBusyChange={props.onBusyChange ?? (() => {})}
        />
      )}
    </div>
  );
}

function tile(name: string): HTMLElement {
  const element = within(screen.getByRole('listbox', { name: 'Files' })).getByText(name).closest<HTMLElement>('[data-index]');
  if (element === null) throw new Error(`no tile for ${name}`);
  return element;
}

function callsOf<C extends string>(api: ReturnType<typeof install>, channel: C) {
  return api.calls.filter((c) => c.channel === channel).map((c) => c.request);
}

it('tabs show counts from list totals and the active tab survives remount', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const files = Array.from({ length: 7 }, (_, i) =>
    fileRecord({ originalName: `f${i}.png`, assetId: asset.id, role: 'reference' }),
  );
  const onTabChange = vi.fn();
  const api = install(asset, {
    'files:list': listOf(files),
    'assignments:listByAsset': () => [assignment(asset.id, 'Forest'), assignment(asset.id, 'City')],
    'relations:list': () => [relation(asset.id, 'Bark')],
  });
  render(<Harness id={asset.id} onTabChange={onTabChange} />);
  expect(await screen.findByRole('tab', { name: 'Files 7' })).toBeTruthy();
  expect(await screen.findByRole('tab', { name: 'Projects 2' })).toBeTruthy();
  expect(await screen.findByRole('tab', { name: 'Relations 1' })).toBeTruthy();
  expect(callsOf(api, 'files:list')).toContainEqual({ limit: 1, offset: 0, scope: { kind: 'asset', assetId: asset.id } });

  // An active filter does not change the tab count.
  await screen.findByText('f0.png');
  api.set('files:list', (request) => (request.kind === 'model' ? pageOf([]) : listOf(files)(request)));
  await user.selectOptions(screen.getByRole('combobox', { name: 'File type' }), 'model');
  await screen.findByText('No matching files');
  expect(screen.getByRole('tab', { name: 'Files 7' })).toBeTruthy();

  screen.getByRole('tab', { name: 'Files 7' }).focus();
  await user.keyboard('{ArrowRight}');
  expect(onTabChange).toHaveBeenLastCalledWith('workflow');
  await user.click(screen.getByRole('tab', { name: 'Relations 1' }));
  expect(screen.getByRole('link', { name: 'Bark' })).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Toggle' }));
  await user.click(screen.getByRole('button', { name: 'Toggle' }));
  const relations = await screen.findByRole('tab', { name: 'Relations 1' });
  expect(relations.getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByRole('link', { name: 'Bark' })).toBeTruthy();
});

it('the asset tag row adds and removes through assets:addTag/removeTag', async () => {
  const user = userEvent.setup();
  const asset = assetDetail({ tags: [tagOf('Nature')] });
  const api = install(asset, {
    'assets:addTag': (r) => ({ ...asset, tags: [tagOf('Nature'), tagOf(r.name)] }),
    'assets:removeTag': () => ({ ...asset, tags: [] }),
  });
  render(<Harness id={asset.id} />);
  const row = await screen.findByRole('group', { name: 'Asset tags' });
  await user.type(within(row).getByRole('combobox', { name: 'Add asset tag' }), 'Wood{Enter}');
  expect(await within(row).findByRole('button', { name: 'Remove Wood' })).toBeTruthy();
  expect(callsOf(api, 'assets:addTag')).toEqual([{ assetId: asset.id, name: 'Wood' }]);

  await user.click(within(row).getByRole('button', { name: 'Remove Nature' }));
  await waitFor(() => expect(within(row).queryByRole('button', { name: 'Remove Wood' })).toBeNull());
  expect(callsOf(api, 'assets:removeTag')).toEqual([{ assetId: asset.id, name: 'nature' }]);
});

it('the breadcrumb is a link back to the gallery', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  install(asset);
  const onBack = vi.fn();
  render(<Harness id={asset.id} onBack={onBack} />);
  await screen.findByRole('textbox', { name: 'Name' });
  await user.click(screen.getByRole('link', { name: 'Assets' }));
  expect(onBack).toHaveBeenCalledTimes(1);
});

it('import shows the result strip with failed names and errors, and reports busy', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const picked = deferred<string[]>();
  const imported = fileRecord({ originalName: 'a.png', assetId: asset.id, role: 'concept' });
  const api = install(asset, {
    'dialog:pickFiles': () => picked.promise,
    'files:import': () => [
      { sourcePath: 'C:\\in\\a.png', file: imported, error: null, duplicateOf: [] },
      { sourcePath: 'C:\\in\\b.exe', file: null, error: 'This file type cannot be imported', duplicateOf: [] },
    ],
  });
  const onBusyChange = vi.fn();
  render(<Harness id={asset.id} onBusyChange={onBusyChange} />);
  const role = await screen.findByRole('combobox', { name: 'Role for imported files' });
  expect(role.getAttribute('title')).toBe('Import as');
  expect((role as HTMLSelectElement).value).toBe('reference');
  await user.selectOptions(role, 'concept');

  await user.click(screen.getByRole('button', { name: 'Import files' }));
  expect(screen.getByText('Importing…')).toBeTruthy();
  expect(onBusyChange).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole('link', { name: 'Assets' }).getAttribute('aria-disabled')).toBe('true');
  picked.resolve(['C:\\in\\a.png', 'C:\\in\\b.exe']);

  const strip = await screen.findByRole('alert');
  expect(within(strip).getByText('1 imported, 1 failed')).toBeTruthy();
  expect(strip.textContent).toContain('b.exe');
  expect(strip.textContent).toContain('This file type cannot be imported');
  expect(strip.textContent).not.toContain('C:\\in');
  expect(callsOf(api, 'files:import')).toEqual([
    { sourcePaths: ['C:\\in\\a.png', 'C:\\in\\b.exe'], target: { assetId: asset.id, role: 'concept' } },
  ]);
  await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  expect(screen.queryByText('Importing…')).toBeNull();

  await user.click(within(strip).getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByText('1 imported, 1 failed')).toBeNull();
});

async function selectThree(asset: AssetDetail, handlers: FakeHandlers = {}) {
  const user = userEvent.setup();
  const c1 = fileRecord({ originalName: 'c1.png', assetId: asset.id, role: 'reference' });
  const c2 = fileRecord({ originalName: 'c2.png', assetId: asset.id, role: 'reference' });
  const bad = fileRecord({ originalName: 'bad.png', assetId: asset.id, role: 'reference', status: 'failed', sha256: null });
  const api = install(asset, { 'files:list': listOf([c1, c2, bad]), ...handlers });
  render(<Harness id={asset.id} />);
  await screen.findByText('c1.png');
  await user.click(tile('c1.png'));
  await user.keyboard('{Shift>}');
  await user.click(tile('bad.png'));
  await user.keyboard('{/Shift}');
  expect(await screen.findByText('3 selected')).toBeTruthy();
  return { user, api, c1, c2, bad };
}

it('selection bar: Add tags tags every eligible selected file in one call', async () => {
  const asset = assetDetail();
  const { user, api, c1, c2, bad } = await selectThree(asset, {
    'files:addTagMany': (r) => {
      const items = [c1, c2].filter((f) => r.fileIds.includes(f.id)).map((f) => ({ ...f, tags: [tagOf('oak')] }));
      // The reloaded list shows the tagged records, as the real backend does.
      api.set('files:list', listOf([...items, bad]));
      return { items };
    },
  });
  await user.click(screen.getByRole('button', { name: 'Add tags' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add tags' });
  await user.type(within(dialog).getByRole('combobox', { name: 'Add image tag' }), 'oak{Enter}');
  expect(await within(dialog).findByRole('button', { name: 'Remove oak' })).toBeTruthy();
  expect(callsOf(api, 'files:addTagMany')).toEqual([{ fileIds: [c1.id, c2.id], name: 'oak' }]);
});

it('selection bar: Set role uses files:assignMany with the same asset', async () => {
  const asset = assetDetail();
  const { user, api, c1, c2 } = await selectThree(asset, {
    'files:assignMany': (r) => ({
      items: r.fileIds.map((fileId) => ({
        fileId,
        file: { ...(fileId === c1.id ? c1 : c2), role: r.role },
        error: null,
      })),
    }),
  });
  const before = callsOf(api, 'files:list').length;
  await user.click(screen.getByRole('button', { name: 'Set role' }));
  const dialog = await screen.findByRole('dialog', { name: 'Set role' });
  await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Role' }), 'concept');
  await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Set role' })).toBeNull());
  expect(callsOf(api, 'files:assignMany')).toEqual([{ fileIds: [c1.id, c2.id], assetId: asset.id, role: 'concept' }]);
  await waitFor(() => expect(callsOf(api, 'files:list').length).toBeGreaterThan(before));
});

it('selection bar: Detach unassigns each file and lists failures per file', async () => {
  const asset = assetDetail();
  const { user, api, c1, c2 } = await selectThree(asset, {
    'files:unassign': (r) => {
      if (r.fileId === c2.id) throw fakeError('not_found');
      return { ...c1, assetId: null, role: null };
    },
  });
  const before = callsOf(api, 'files:list').length;
  const detach = screen.getByRole('button', { name: 'Detach' });
  expect(detach.getAttribute('title')).toBe('The files are kept and move to the inbox');
  await user.click(detach);
  const strip = await screen.findByRole('alert');
  expect(within(strip).getByText('1 detached, 1 failed')).toBeTruthy();
  expect(strip.textContent).toContain('c2.png');
  expect(strip.textContent).toContain('This item no longer exists.');
  expect(callsOf(api, 'files:unassign')).toEqual([{ fileId: c1.id }, { fileId: c2.id }]);
  await waitFor(() => expect(callsOf(api, 'files:list').length).toBeGreaterThan(before));
  // The detached file left the selection; the failed one stays.
  expect(screen.getByText('2 selected')).toBeTruthy();
});

it('the file dialog returns focus to the same file after the list reloaded while it was open', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  let file = fileRecord({ originalName: 'leaf.png', assetId: asset.id, role: 'reference' });
  const other = fileRecord({ originalName: 'stem.png', assetId: asset.id, role: 'reference' });
  const api = install(asset, {
    'files:list': (r) => listOf([file, other])(r),
    'files:addTag': () => {
      file = { ...file, tags: [tagOf('Green')] };
      return file;
    },
  });
  render(<Harness id={asset.id} />);
  await screen.findByText('leaf.png');
  await user.click(tile('leaf.png'));
  await user.keyboard('{Enter}');
  const dialog = await screen.findByRole('dialog', { name: 'leaf.png | Oak tree' });
  const before = callsOf(api, 'files:list').length;
  await user.type(within(dialog).getByRole('combobox', { name: 'Add image tag' }), 'Green{Enter}');
  expect(await within(dialog).findByRole('button', { name: 'Remove Green' })).toBeTruthy();
  await waitFor(() => expect(callsOf(api, 'files:list').length).toBeGreaterThan(before));
  // The reloaded list replaced the tiles.
  await waitFor(() => expect(within(tile('leaf.png')).getByText('Green')).toBeTruthy());
  // Adding a tag keeps the same file in the dialog.
  expect(screen.getByRole('dialog', { name: 'leaf.png | Oak tree' })).toBe(dialog);
  expect(within(dialog).getByText('1 / 2')).toBeTruthy();

  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(tile('leaf.png'));
});

function threeFiles(asset: AssetDetail) {
  return ['a.png', 'b.png', 'c.png'].map((name) => fileRecord({ originalName: name, assetId: asset.id, role: 'reference' }));
}

async function openFile(user: ReturnType<typeof userEvent.setup>, name: string) {
  await screen.findByText(name);
  await user.click(tile(name));
  await user.keyboard('{Enter}');
  return screen.findByRole('dialog', { name: `${name} | Oak tree` });
}

it('detaching the shown file shows the following one', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  let files = threeFiles(asset);
  const a = files[0]!;
  const api = install(asset, {
    'files:list': (r) => listOf(files)(r),
    'files:unassign': (r) => {
      files = files.filter((f) => f.id !== r.fileId);
      return { ...a, assetId: null, role: null };
    },
  });
  render(<Harness id={asset.id} />);
  const dialog = await openFile(user, 'a.png');
  expect(within(dialog).getByText('1 / 3')).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'More' }));
  await user.click(screen.getByRole('menuitem', { name: 'Detach' }));

  const next = await screen.findByRole('dialog', { name: 'b.png | Oak tree' });
  expect(within(next).getByText('1 / 2')).toBeTruthy();
  expect(callsOf(api, 'files:unassign')).toEqual([{ fileId: a.id }]);
});

it('a role change that the active role filter no longer matches moves on to the following file', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  let files = threeFiles(asset);
  install(asset, {
    'files:list': (r) => listOf(files.filter((f) => r.role === undefined || f.role === r.role))(r),
    'files:assign': (r) => {
      files = files.map((f) => (f.id === r.fileId ? { ...f, role: r.role } : f));
      return files.find((f) => f.id === r.fileId)!;
    },
  });
  render(<Harness id={asset.id} />);
  await screen.findByText('a.png');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'reference');
  const dialog = await openFile(user, 'b.png');
  expect(within(dialog).getByText('2 / 3')).toBeTruthy();
  await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Role of b.png' }), 'texture');

  const next = await screen.findByRole('dialog', { name: 'c.png | Oak tree' });
  expect(within(next).getByText('2 / 2')).toBeTruthy();
});

it('after stepping, closing the dialog focuses the tile of the file shown last', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const files = threeFiles(asset);
  install(asset, { 'files:list': listOf(files) });
  render(<Harness id={asset.id} />);
  const dialog = await openFile(user, 'a.png');
  await user.click(within(dialog).getByRole('button', { name: 'Next file (→)' }));
  await screen.findByRole('dialog', { name: 'b.png | Oak tree' });
  await user.click(within(dialog).getByRole('button', { name: 'Next file (→)' }));
  const last = await screen.findByRole('dialog', { name: 'c.png | Oak tree' });
  expect(within(last).getByText('3 / 3')).toBeTruthy();
  expect((within(last).getByRole('button', { name: 'Next file (→)' }) as HTMLButtonElement).disabled).toBe(true);

  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(tile('c.png')));
});

it('the tile menu sets the cover once while the call runs', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const file = fileRecord({ originalName: 'leaf.png', assetId: asset.id, role: 'reference' });
  const pending = deferred<AssetDetail>();
  const api = install(asset, { 'files:list': listOf([file]), 'assets:setCover': () => pending.promise });
  render(<Harness id={asset.id} />);
  await screen.findByText('leaf.png');
  for (let i = 0; i < 2; i += 1) {
    await user.click(within(tile('leaf.png')).getByRole('button', { name: 'File actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Use as cover' }));
  }
  expect(callsOf(api, 'assets:setCover')).toEqual([{ assetId: asset.id, fileId: file.id }]);
  pending.resolve({ ...asset, coverFileId: file.id, coverIsChosen: true });
  expect(await within(tile('leaf.png')).findByText('Cover')).toBeTruthy();
});

it('a failed asset re-read after a file change shows an alert and keeps the screen usable', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const file = fileRecord({ originalName: 'leaf.png', assetId: asset.id, role: 'reference' });
  const api = install(asset, {
    'files:list': listOf([file]),
    'assets:setCover': () => ({ ...asset, coverFileId: file.id, coverIsChosen: true }),
  });
  render(<Harness id={asset.id} />);
  await screen.findByText('leaf.png');
  api.set('assets:get', () => {
    throw fakeError('storage_unreachable');
  });
  await user.click(within(tile('leaf.png')).getByRole('button', { name: 'File actions' }));
  await user.click(screen.getByRole('menuitem', { name: 'Use as cover' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(callsOf(api, 'assets:get').length).toBeGreaterThan(1);
  expect(screen.getByRole('textbox', { name: 'Name' })).toBeTruthy();
  expect(screen.getByRole('tablist')).toBeTruthy();
  expect(within(tile('leaf.png')).getByText('Cover')).toBeTruthy();
});

it('not found shows an alert with the breadcrumb', async () => {
  const asset = assetDetail();
  install(asset, {
    'assets:get': () => {
      throw fakeError('not_found');
    },
  });
  render(<Harness id={asset.id} />);
  expect((await screen.findByRole('alert')).textContent).toBe('This item no longer exists.');
  expect(screen.getByRole('link', { name: 'Assets' })).toBeTruthy();
  expect(screen.queryByRole('tablist')).toBeNull();
});

it('each tab panel shows its own load error and empty status', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  install(asset);
  const { unmount } = render(<Harness id={asset.id} />);
  expect(await screen.findByText('No files')).toBeTruthy();
  await user.click(screen.getByRole('tab', { name: /Relations/ }));
  expect(await screen.findByText('No relations')).toBeTruthy();
  await user.click(screen.getByRole('tab', { name: /Projects/ }));
  expect(await screen.findByText('Not assigned to any project')).toBeTruthy();
  unmount();

  install(asset, {
    'files:list': () => {
      throw fakeError('storage_unreachable');
    },
    'relations:list': () => {
      throw new Error('Relations failed');
    },
  });
  render(<Harness id={asset.id} />);
  const files = await screen.findByRole('tabpanel');
  expect(await within(files).findByRole('alert')).toBeTruthy();
  expect(within(files).getByRole('button', { name: 'Retry' })).toBeTruthy();
  await user.click(screen.getByRole('tab', { name: /Relations/ }));
  const panel = screen.getByRole('tabpanel');
  expect((await within(panel).findByRole('alert')).textContent).toBe('The application did not respond');
  expect(within(panel).queryByText('No relations')).toBeNull();
});

it('projects tab: links, remove with tooltip and add to project', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const forest = assignment(asset.id, 'Forest');
  const city = project('City');
  const onOpenProject = vi.fn();
  const api = install(asset, {
    'assignments:listByAsset': () => [forest],
    'projects:list': () => pageOf([{ ...forest.project, assetCount: 1, imageCount: 0 }, { ...city, assetCount: 0, imageCount: 0 }]),
    'assignments:remove': () => null,
    'assignments:assign': () => forest as never,
  });
  render(<Harness id={asset.id} initialTab="projects" onOpenProject={onOpenProject} />);
  await user.click(await screen.findByRole('link', { name: 'Forest' }));
  expect(onOpenProject).toHaveBeenCalledWith(forest.projectId);
  const remove = screen.getByRole('button', { name: 'Remove Oak tree from Forest' });
  expect(remove.getAttribute('title')).toBe('Removes the assignment only; the asset and its files are kept');
  await user.click(remove);
  expect(callsOf(api, 'assignments:remove')).toEqual([{ projectId: forest.projectId, assetId: asset.id }]);
  expect((screen.getByRole('combobox', { name: 'Project to add' }) as HTMLSelectElement).value).toBe(city.id);
  await user.click(screen.getByRole('button', { name: 'Add to project' }));
  expect(callsOf(api, 'assignments:assign')).toEqual([{ projectId: city.id, assetId: asset.id }]);
});

it('relations tab: remove with tooltip and add through the asset picker without self', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const bark = relation(asset.id, 'Bark');
  const leaf = { id: nextId(), name: 'Leaf', typeId: TYPE.id, description: '', status: 'draft' as const, createdAt: NOW, updatedAt: NOW };
  const onOpenAsset = vi.fn();
  const api = install(asset, {
    'relations:list': () => [bark],
    'relations:remove': () => null,
    'relations:add': () => bark as never,
    'assets:list': () =>
      pageOf([
        { ...asset, projectCount: 0, fileCount: 0, workflowProgress: null, coverTags: [] },
        { ...leaf, projectCount: 0, fileCount: 0, workflowProgress: null, coverFileId: null, tags: [], coverTags: [] },
      ]),
  });
  render(<Harness id={asset.id} initialTab="relations" onOpenAsset={onOpenAsset} />);
  await user.click(await screen.findByRole('link', { name: 'Bark' }));
  expect(onOpenAsset).toHaveBeenCalledWith(bark.other.id);
  const remove = screen.getByRole('button', { name: 'Remove relation Uses Bark' });
  expect(remove.getAttribute('title')).toBe('Removes the relation only; both assets and their files are kept');
  await user.click(remove);
  expect(callsOf(api, 'relations:remove')).toEqual([{ fromAssetId: asset.id, toAssetId: bark.toAssetId, kind: 'uses' }]);

  await user.selectOptions(screen.getByRole('combobox', { name: 'Relation kind' }), 'variant_of');
  const picker = screen.getByRole('combobox', { name: 'Search assets' });
  await user.click(picker);
  const results = await screen.findByRole('listbox', { name: 'Assets' });
  await waitFor(() => expect(within(results).getAllByRole('option').map((o) => o.textContent)).toEqual(['Leaf']));
  await user.keyboard('{ArrowDown}{Enter}');
  await waitFor(() =>
    expect(callsOf(api, 'relations:add')).toEqual([{ fromAssetId: asset.id, toAssetId: leaf.id, kind: 'variant_of' }]),
  );
});

it('workflow tab: start, step state without skipped for mandatory steps, and remove with its tooltip', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const template = { id: nextId(), key: 'basic', name: 'Basic', builtIn: true, latestVersion: 1 };
  const workflow = {
    id: nextId(),
    assetId: asset.id,
    templateId: template.id,
    templateName: 'Basic',
    templateVersion: 1,
    createdAt: NOW,
    progress: { done: 0, total: 1 },
    steps: [
      { id: nextId(), key: 'model', name: 'Model', position: 0, mandatory: true, state: 'not_started' as const, notes: '' },
    ],
  };
  install(asset, {
    'workflowTemplates:list': () => [template],
    'workflows:start': () => workflow as never,
  });
  render(<Harness id={asset.id} initialTab="workflow" />);
  await user.click(await screen.findByRole('button', { name: 'Start workflow' }));
  const state = await screen.findByRole('combobox', { name: 'State of Model' });
  expect(within(state).queryByRole('option', { name: 'Skipped' })).toBeNull();
  expect(screen.getByRole('progressbar', { name: 'Workflow progress' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Remove workflow' }).getAttribute('title')).toBe(
    'Step states and notes are deleted; asks first',
  );
});

it('files tab: the tile menu analyses a complete image and shows the outcome', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const leaf = fileRecord({ originalName: 'leaf.png', assetId: asset.id, role: 'reference' });
  const blend = nonImageRecord('tree.blend', { assetId: asset.id, role: 'working' });
  const api = install(asset, {
    'files:list': listOf([leaf, blend]),
    'analysis:enqueue': enqueueAll,
  });
  render(<Harness id={asset.id} />);
  await screen.findByText('tree.blend');
  await user.click(within(tile('tree.blend')).getByRole('button', { name: 'File actions' }));
  expect(screen.queryByRole('menuitem', { name: 'Analyse' })).toBeNull();
  await user.keyboard('{Escape}');
  await user.click(within(tile('leaf.png')).getByRole('button', { name: 'File actions' }));
  await user.click(screen.getByRole('menuitem', { name: 'Analyse' }));
  expect((await screen.findByRole('status')).textContent).toContain('1 queued, 0 skipped');
  expect(callsOf(api, 'analysis:enqueue')).toEqual([applyFiles([leaf.id])]);
});

it('files tab: Analyse in the selection bar sends only the analysable images and counts the skipped ones', async () => {
  const asset = assetDetail();
  const { user, api, c1, c2 } = await selectThree(asset, {
    'analysis:enqueue': () => ({ enqueued: 1, skipped: { ...NONE_SKIPPED, alreadyQueued: 1 } }),
  });
  await user.click(screen.getByRole('button', { name: 'Analyse' }));
  const strip = await screen.findByRole('status');
  expect(within(strip).getByText('1 queued, 1 skipped')).toBeTruthy();
  expect(callsOf(api, 'analysis:enqueue')).toEqual([applyFiles([c1.id, c2.id])]);
  expect(screen.getByText('3 selected')).toBeTruthy();
});

it('files tab: Analyse is disabled without images, and a rejected call shows the alert', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const doc = nonImageRecord('notes.pdf', { assetId: asset.id, role: 'reference' });
  const leaf = fileRecord({ originalName: 'leaf.png', assetId: asset.id, role: 'reference' });
  install(asset, {
    'files:list': listOf([doc, leaf]),
    'analysis:enqueue': () => {
      throw fakeError('not_found');
    },
  });
  render(<Harness id={asset.id} />);
  await screen.findByText('notes.pdf');
  await user.click(tile('notes.pdf'));
  const analyse = screen.getByRole('button', { name: 'Analyse' }) as HTMLButtonElement;
  expect(analyse.disabled).toBe(true);
  expect(analyse.title).toBe(NONE_ANALYSABLE);

  await user.click(tile('leaf.png'));
  expect(analyse.disabled).toBe(false);
  await user.click(analyse);
  expect((await screen.findByRole('alert')).textContent).toBe('This item no longer exists.');
  expect(screen.getByText('1 selected')).toBeTruthy();
});
