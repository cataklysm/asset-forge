import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import {
  JOB_ERROR_MESSAGES,
  type AssetAssignment,
  type Changes,
  type AssetDetail,
  type AssetRelationView,
  type AssetType,
  type FileRecord,
  type IpcRequest,
  type IpcResponse,
  type ProviderView,
} from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { NONE_ANALYSABLE } from '../../src/renderer/src/analysis';
import { JOB_POLL_MS, JobsProvider } from '../../src/renderer/src/jobs-context';
import { ANALYSE_ASSET_TITLE } from '../../src/renderer/src/labels';
import type { AssetTab } from '../../src/renderer/src/list-state';
import { ProviderSettingsProvider } from '../../src/renderer/src/provider-context';
import { AnalysisPromptsProvider } from '../../src/renderer/src/analysis-prompts-context';
import { AssetScreen } from '../../src/renderer/src/screens/AssetScreen';
import { TagsProvider } from '../../src/renderer/src/tags-context';
import {
  deferred,
  fakeAssetSources,
  fakeError,
  fakeProviders,
  importResultOf,
  installFakeApi,
  noChanges,
  providerView,
  type FakeHandlers,
} from './fake-api';
import { fileRecord, nextId, NONE_SKIPPED, nonImageRecord, pageOf, tagOf } from './fixtures';
import { renameHandlers, renameThroughDialog } from './rename-flow';

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
    sources: [],
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
      { sourcePath: 'C:\\in\\a.png', entryName: null, file: imported, error: null, duplicateOf: [] },
      { sourcePath: 'C:\\in\\b.exe', entryName: null, file: null, error: 'This file type cannot be imported', duplicateOf: [] },
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
    { sourcePaths: ['C:\\in\\a.png', 'C:\\in\\b.exe'], target: { assetId: asset.id, role: 'concept' }, unpackArchives: false },
  ]);
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  expect(screen.queryByText('Importing…')).toBeNull();

  await user.click(within(strip).getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByText('1 imported, 1 failed')).toBeNull();
});

it('a picked ZIP asks first; Unpack imports the entries with the role and the strip counts them', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const d = fileRecord({ originalName: 'd.png', assetId: asset.id, role: 'reference' });
  const failedRow = fileRecord({ originalName: 'e.png', status: 'failed', sha256: null, error: 'The checksum did not match' });
  const api = install(asset, {
    'dialog:pickFiles': () => ['C:\\in\\pack.zip'],
    'files:import': () => [
      importResultOf('C:\\in\\pack.zip', { entryName: 'd.png', file: d }),
      importResultOf('C:\\in\\pack.zip', { entryName: 'e.png', file: failedRow, error: 'The checksum did not match' }),
      importResultOf('C:\\in\\pack.zip', { entryName: 'a.exe', error: 'This file type cannot be imported' }),
    ],
  });
  render(<Harness id={asset.id} />);
  await user.click(await screen.findByRole('button', { name: 'Import files' }));
  const dialog = await screen.findByRole('dialog', { name: 'ZIP archive' });
  expect(within(dialog).getByText('pack.zip')).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Unpack' }));

  const strip = await screen.findByRole('alert');
  expect(within(strip).getByText('1 imported, 2 failed')).toBeTruthy();
  expect(strip.textContent).toContain('a.exe (pack.zip)');
  expect(strip.textContent).toContain('e.png (pack.zip)');
  expect(callsOf(api, 'files:import')).toEqual([
    { sourcePaths: ['C:\\in\\pack.zip'], target: { assetId: asset.id, role: 'reference' }, unpackArchives: true },
  ]);
});

it('Import as file in the asset screen sends unpackArchives false', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const api = install(asset, {
    'dialog:pickFiles': () => ['C:\\in\\pack.zip'],
    'files:import': () => [importResultOf('C:\\in\\pack.zip', { error: 'This file is not a readable ZIP archive' })],
  });
  render(<Harness id={asset.id} />);
  await user.click(await screen.findByRole('button', { name: 'Import files' }));
  await user.click(within(await screen.findByRole('dialog', { name: 'ZIP archive' })).getByRole('button', { name: 'Import as file' }));
  const strip = await screen.findByRole('alert');
  expect(within(strip).getByText('0 imported, 1 failed')).toBeTruthy();
  expect(within(strip).getByText('pack.zip')).toBeTruthy();
  expect(callsOf(api, 'files:import')).toEqual([
    { sourcePaths: ['C:\\in\\pack.zip'], target: { assetId: asset.id, role: 'reference' }, unpackArchives: false },
  ]);
});

it('Cancel in the ZIP dialog of the asset screen imports nothing and ends the busy state', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const api = install(asset, { 'dialog:pickFiles': () => ['C:\\in\\pack.zip'], 'files:import': () => [] });
  const onBusyChange = vi.fn();
  render(<Harness id={asset.id} onBusyChange={onBusyChange} />);
  await user.click(await screen.findByRole('button', { name: 'Import files' }));
  await user.click(within(await screen.findByRole('dialog', { name: 'ZIP archive' })).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Import files' }) as HTMLButtonElement).disabled).toBe(false));
  expect(onBusyChange).toHaveBeenLastCalledWith(false);
  expect(callsOf(api, 'files:import')).toEqual([]);
  expect(screen.queryByRole('alert')).toBeNull();
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

const VISION: ProviderView = providerView();

/** The provider, job and analysis channels the dialogs use. */
function analysisHandlers(entry: ProviderView | null = VISION): FakeHandlers {
  return {
    ...(entry === null
      ? fakeProviders().handlers
      : fakeProviders({ providers: [entry], lastUsedId: entry.id }, { [entry.id]: { ok: true, models: [{ name: 'vision-a', vision: true }] } })
          .handlers),
    'jobs:summary': () => ({ queued: 0, running: 0, waiting: 0, failed: 0, cancelled: 0, succeeded: 0, changes: 0, paused: [], pausedHosts: [] }),
    'analysis:getProposal': () => ({ proposal: null, job: null }),
    'analysis:preview': () => ({ analysable: 2, alreadyAnalysed: 1, alreadyQueued: 0, notAnalysable: 0 }),
    'analysis:enqueue': () => ({ enqueued: 2, skipped: { ...NONE_SKIPPED, alreadyAnalysed: 1 } }),
  };
}

function renderWithProvider(id: string) {
  return render(
    <JobsProvider>
      <ProviderSettingsProvider>
        <AnalysisPromptsProvider>
          <Harness id={id} />
        </AnalysisPromptsProvider>
      </ProviderSettingsProvider>
    </JobsProvider>,
  );
}

it('a file a job added to this asset refreshes the files and the tab count in place; one added elsewhere does nothing', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const asset = assetDetail();
    let files = Array.from({ length: 3 }, (_, i) => fileRecord({ originalName: `f${i}.png`, assetId: asset.id, role: 'reference' }));
    let summary = { queued: 1, running: 0, waiting: 0, failed: 0, cancelled: 0, succeeded: 0, changes: 1, paused: [], pausedHosts: [] };
    let changes = noChanges();
    const api = install(asset, {
      ...analysisHandlers(),
      'jobs:summary': () => summary,
      'changes:since': () => changes,
      'files:list': (request) => listOf(files)(request),
    });
    const change = async (p: Partial<Changes>) => {
      summary = { ...summary, changes: summary.changes + 1 };
      changes = noChanges(p);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
      });
      changes = noChanges();
    };
    renderWithProvider(asset.id);
    expect(await screen.findByRole('tab', { name: 'Files 3' })).toBeTruthy();
    await screen.findByText('f0.png');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const listbox = screen.getByRole('listbox', { name: 'Files' });

    api.calls.length = 0;
    await change({ added: [{ assetId: nextId() }, { assetId: null }] });
    expect(callsOf(api, 'files:list')).toEqual([]);

    files = [...files, fileRecord({ originalName: 'f3.png', assetId: asset.id, role: 'generated' })];
    await change({ added: [{ assetId: asset.id }] });
    expect(await screen.findByText('f3.png')).toBeTruthy();
    expect(await screen.findByRole('tab', { name: 'Files 4' })).toBeTruthy();
    expect(screen.getByRole('listbox', { name: 'Files' })).toBe(listbox);
    expect(callsOf(api, 'files:list')).toEqual(
      expect.arrayContaining([
        { limit: 1, offset: 0, scope: { kind: 'asset', assetId: asset.id } },
        { limit: 60, offset: 0, scope: { kind: 'asset', assetId: asset.id } },
      ]),
    );
  } finally {
    vi.useRealTimers();
  }
});

/** The Analyse button of the selection bar (the header has one for the whole asset). */
function selectionAnalyse(): HTMLButtonElement {
  const button = screen
    .getAllByRole('button', { name: 'Analyse' })
    .find((b) => b.title !== ANALYSE_ASSET_TITLE && b.closest('header') === null);
  if (button === undefined) throw new Error('no selection Analyse');
  return button as HTMLButtonElement;
}

it('files tab: the tile menu Analyse opens the result dialog of a complete image', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const leaf = fileRecord({ originalName: 'leaf.png', assetId: asset.id, role: 'reference' });
  const blend = nonImageRecord('tree.blend', { assetId: asset.id, role: 'working' });
  const api = install(asset, { 'files:list': listOf([leaf, blend]), ...analysisHandlers() });
  renderWithProvider(asset.id);
  await screen.findByText('tree.blend');
  await user.click(within(tile('tree.blend')).getByRole('button', { name: 'File actions' }));
  expect(screen.queryByRole('menuitem', { name: 'Analyse' })).toBeNull();
  await user.keyboard('{Escape}');
  await user.click(within(tile('leaf.png')).getByRole('button', { name: 'File actions' }));
  await user.click(screen.getByRole('menuitem', { name: 'Analyse' }));
  await screen.findByRole('dialog', { name: 'leaf.png' });
  expect(callsOf(api, 'analysis:getProposal')).toEqual([{ fileId: leaf.id }]);
  expect(callsOf(api, 'analysis:enqueue')).toEqual([]);
});

it('files tab: Analyse in the selection bar opens the start dialog for the selected files; Start fills the strip', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const c1 = fileRecord({ originalName: 'c1.png', assetId: asset.id, role: 'reference' });
  const c2 = fileRecord({ originalName: 'c2.png', assetId: asset.id, role: 'reference' });
  const bad = fileRecord({ originalName: 'bad.png', assetId: asset.id, role: 'reference', status: 'failed', sha256: null });
  const api = install(asset, { 'files:list': listOf([c1, c2, bad]), ...analysisHandlers() });
  renderWithProvider(asset.id);
  await screen.findByText('c1.png');
  await user.click(tile('c1.png'));
  await user.keyboard('{Shift>}');
  await user.click(tile('bad.png'));
  await user.keyboard('{/Shift}');
  expect(await screen.findByText('3 selected')).toBeTruthy();
  await user.click(selectionAnalyse());
  await screen.findByRole('dialog', { name: 'Analyse' });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false));
  expect(callsOf(api, 'analysis:preview')).toEqual([
    { target: { kind: 'files', fileIds: [c1.id, c2.id, bad.id] }, model: 'vision-a', providerId: VISION.id },
  ]);
  await user.click(screen.getByRole('button', { name: 'Start' }));
  const strip = await screen.findByRole('status');
  expect(within(strip).getByText('2 queued, 1 already analysed')).toBeTruthy();
  expect(screen.getByText('3 selected')).toBeTruthy();
});

it('files tab: Analyse is disabled without images', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const doc = nonImageRecord('notes.pdf', { assetId: asset.id, role: 'reference' });
  const leaf = fileRecord({ originalName: 'leaf.png', assetId: asset.id, role: 'reference' });
  install(asset, { 'files:list': listOf([doc, leaf]), ...analysisHandlers() });
  renderWithProvider(asset.id);
  await screen.findByText('notes.pdf');
  await user.click(tile('notes.pdf'));
  expect(selectionAnalyse().disabled).toBe(true);
  expect(selectionAnalyse().title).toBe(NONE_ANALYSABLE);
  await user.click(tile('leaf.png'));
  expect(selectionAnalyse().disabled).toBe(false);
});

it('files tab: Analyse all sends the asset scope with the current filters', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const leaf = fileRecord({ originalName: 'leaf.png', assetId: asset.id, role: 'texture' });
  const api = install(asset, { 'files:list': listOf([leaf]), ...analysisHandlers() });
  renderWithProvider(asset.id);
  await screen.findByText('leaf.png');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'texture');
  await user.click(screen.getByRole('button', { name: 'Analyse all' }));
  await screen.findByRole('dialog', { name: 'Analyse' });
  await waitFor(() => expect(callsOf(api, 'analysis:preview')).toHaveLength(1));
  expect(callsOf(api, 'analysis:preview')[0]).toEqual({
    target: { kind: 'fileFilter', filter: { scope: { kind: 'asset', assetId: asset.id }, role: 'texture' } },
    model: 'vision-a',
    providerId: VISION.id,
  });
});

it('the header Analyse starts the whole asset', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const api = install(asset, analysisHandlers());
  renderWithProvider(asset.id);
  const header = await screen.findByRole('button', { name: 'Analyse' });
  expect(header.title).toBe(ANALYSE_ASSET_TITLE);
  await user.click(header);
  await screen.findByRole('dialog', { name: 'Analyse' });
  await waitFor(() => expect(callsOf(api, 'analysis:preview')).toHaveLength(1));
  expect(callsOf(api, 'analysis:preview')[0]).toEqual({ target: { kind: 'asset', assetId: asset.id }, model: 'vision-a', providerId: VISION.id });
  await user.click(screen.getByRole('button', { name: 'Start' }));
  expect(within(await screen.findByRole('status')).getByText('2 queued, 1 already analysed')).toBeTruthy();
});

/** A `files:trashMany` answer that trashes every requested file except those in `failing`. */
function trashAnswer(files: FileRecord[], failing: ReadonlySet<string> = new Set()) {
  return (r: IpcRequest<'files:trashMany'>) => ({
    items: r.fileIds.map((fileId) =>
      failing.has(fileId)
        ? { fileId, file: null, error: { code: 'invalid_operation' as const, message: 'The file is still being imported' } }
        : { fileId, file: { ...files.find((f) => f.id === fileId)!, assetId: null, role: null, deletedAt: NOW }, error: null },
    ),
  });
}

it('Delete in the tile menu calls files:trashMany with the file and reloads the list and the asset', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  let files = threeFiles(asset);
  const a = files[0]!;
  const api = install(asset, {
    'files:list': (r) => listOf(files)(r),
    'files:trashMany': (r) => {
      const answer = trashAnswer(files)(r);
      files = files.filter((f) => !r.fileIds.includes(f.id));
      return answer;
    },
  });
  render(<Harness id={asset.id} />);
  await screen.findByText('a.png');
  const reads = callsOf(api, 'assets:get').length;
  await user.click(within(tile('a.png')).getByRole('button', { name: 'File actions' }));
  const item = screen.getByRole('menuitem', { name: 'Delete' });
  expect(item.getAttribute('title')).toBe('Moves the file to the trash');
  await user.click(item);
  await waitFor(() => expect(within(screen.getByRole('listbox', { name: 'Files' })).queryByText('a.png')).toBeNull());
  expect(callsOf(api, 'files:trashMany')).toEqual([{ fileIds: [a.id] }]);
  await waitFor(() => expect(callsOf(api, 'assets:get').length).toBeGreaterThan(reads));
  expect(await screen.findByRole('tab', { name: 'Files 2' })).toBeTruthy();
});

it('Delete in the selection bar sends all selected files including a failed one', async () => {
  const asset = assetDetail();
  const holder: { files: FileRecord[] } = { files: [] };
  const { user, api, c1, c2, bad } = await selectThree(asset, {
    'files:trashMany': (r) => trashAnswer(holder.files)(r),
  });
  holder.files = [c1, c2, bad];
  const button = screen.getByRole('button', { name: 'Delete' });
  expect(button.getAttribute('title')).toBe('Moves the files to the trash');
  // After Detach in the selection bar.
  const bar = button.parentElement!;
  const labels = within(bar)
    .getAllByRole('button')
    .map((b) => b.textContent);
  expect(labels.indexOf('Delete')).toBe(labels.indexOf('Detach') + 1);
  await user.click(button);
  await waitFor(() => expect(callsOf(api, 'files:trashMany')).toEqual([{ fileIds: [c1.id, c2.id, bad.id] }]));
  await waitFor(() => expect(screen.queryByText('3 selected')).toBeNull());
  // Nothing failed: no strip.
  expect(screen.queryByRole('alert')).toBeNull();
});

it('a partly failing batch shows "1 deleted, 1 failed" and keeps the failed file selected', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const files = threeFiles(asset);
  const [a, b] = files as [FileRecord, FileRecord, FileRecord];
  const api = install(asset, { 'files:list': listOf(files), 'files:trashMany': trashAnswer(files, new Set([b.id])) });
  render(<Harness id={asset.id} />);
  await screen.findByText('a.png');
  await user.click(tile('a.png'));
  await user.keyboard('{Shift>}');
  await user.click(tile('b.png'));
  await user.keyboard('{/Shift}');
  await user.click(screen.getByRole('button', { name: 'Delete' }));
  const strip = await screen.findByRole('alert');
  expect(within(strip).getByText('1 deleted, 1 failed')).toBeTruthy();
  expect(strip.textContent).toContain('b.png');
  expect(strip.textContent).toContain('The file is still being imported');
  expect(callsOf(api, 'files:trashMany')).toEqual([{ fileIds: [a.id, b.id] }]);
  expect(screen.getByText('1 selected')).toBeTruthy();
});

it('pressing Delete twice sends one request', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const files = threeFiles(asset);
  const pending = deferred<IpcResponse<'files:trashMany'>>();
  const api = install(asset, { 'files:list': listOf(files), 'files:trashMany': () => pending.promise });
  render(<Harness id={asset.id} />);
  await screen.findByText('a.png');
  await user.click(tile('a.png'));
  await user.keyboard('{Delete}');
  await user.keyboard('{Delete}');
  expect(callsOf(api, 'files:trashMany')).toEqual([{ fileIds: [files[0]!.id] }]);
  expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
  pending.resolve(trashAnswer(files)({ fileIds: [files[0]!.id] }));
  await waitFor(() => expect(screen.queryByText('1 selected')).toBeNull());
  expect(callsOf(api, 'files:trashMany')).toHaveLength(1);
});

it('no dialog opens on Delete', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const files = threeFiles(asset);
  const api = install(asset, { 'files:list': listOf(files), 'files:trashMany': trashAnswer(files) });
  render(<Harness id={asset.id} />);
  await screen.findByText('a.png');
  await user.click(tile('a.png'));
  await user.keyboard('{Delete}');
  await waitFor(() => expect(callsOf(api, 'files:trashMany')).toHaveLength(1));
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(within(tile('b.png')).getByRole('button', { name: 'File actions' }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  await waitFor(() => expect(callsOf(api, 'files:trashMany')).toHaveLength(2));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('without a configured provider the header Analyse is disabled with the reason', async () => {
  const asset = assetDetail();
  install(asset, analysisHandlers(null));
  renderWithProvider(asset.id);
  const header = (await screen.findByRole('button', { name: 'Analyse' })) as HTMLButtonElement;
  await waitFor(() => expect(header.title).toBe(JOB_ERROR_MESSAGES.provider_not_configured));
  expect(header.disabled).toBe(true);
});

it('renaming an asset tag re-reads the asset and reloads the files tab', async () => {
  const user = userEvent.setup();
  const asset = assetDetail({ tags: [tagOf('Front View')] });
  const file = fileRecord({ originalName: 'c1.png', assetId: asset.id, role: 'reference' });
  const rename = renameHandlers({ 'front view': 'Front View' });
  const api = install(asset, {
    'files:list': listOf([file]),
    ...rename,
    'tags:rename': (request) => {
      api.set('assets:get', () => ({ ...asset, tags: [tagOf('Front')] }));
      return rename['tags:rename'](request);
    },
  });
  render(
    <TagsProvider>
      <Harness id={asset.id} />
    </TagsProvider>,
  );
  const row = await screen.findByRole('group', { name: 'Asset tags' });
  await screen.findByText('c1.png');
  const gets = callsOf(api, 'assets:get').length;
  const lists = callsOf(api, 'files:list').length;
  await renameThroughDialog(user, 'Front View', 'Front');
  expect(await within(row).findByRole('button', { name: 'Remove Front' })).toBeTruthy();
  expect(within(row).queryByRole('button', { name: 'Remove Front View' })).toBeNull();
  expect(callsOf(api, 'assets:get').length).toBeGreaterThan(gets);
  await waitFor(() => expect(callsOf(api, 'files:list').length).toBeGreaterThan(lists));
});

it('files tab: a rename from the Add tags dialog rewrites the shared tags before the reload answers', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const c1 = fileRecord({ originalName: 'c1.png', assetId: asset.id, role: 'reference', tags: [tagOf('Front View')] });
  const c2 = fileRecord({ originalName: 'c2.png', assetId: asset.id, role: 'reference', tags: [tagOf('Front View')] });
  const rename = renameHandlers({ 'front view': 'Front View' });
  const api = install(asset, {
    'files:list': listOf([c1, c2]),
    ...rename,
    'tags:rename': (request) => {
      api.set('files:list', () => deferred<IpcResponse<'files:list'>>().promise);
      return rename['tags:rename'](request);
    },
  });
  render(
    <TagsProvider>
      <Harness id={asset.id} />
    </TagsProvider>,
  );
  await screen.findByText('c1.png');
  await user.click(tile('c1.png'));
  await user.keyboard('{Shift>}');
  await user.click(tile('c2.png'));
  await user.keyboard('{/Shift}');
  expect(await screen.findByText('2 selected')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Add tags' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add tags' });
  const shared = within(dialog).getByRole('group', { name: 'Image tags' });
  expect(within(shared).getByRole('button', { name: 'Rename Front View' })).toBeTruthy();
  const lists = callsOf(api, 'files:list').length;
  await renameThroughDialog(user, 'Front View', 'Front');
  await waitFor(() => expect(callsOf(api, 'files:list').length).toBeGreaterThan(lists));
  expect(await within(shared).findByRole('button', { name: 'Remove Front' })).toBeTruthy();
  expect(within(shared).queryByRole('button', { name: 'Remove Front View' })).toBeNull();
});

it('files tab: the tag filter of the tab follows a rename', async () => {
  const user = userEvent.setup();
  const asset = assetDetail({ tags: [tagOf('Front View')] });
  const file = fileRecord({ originalName: 'c1.png', assetId: asset.id, role: 'reference' });
  const api = install(asset, { 'files:list': listOf([file]), ...renameHandlers({ 'front view': 'Front View' }) });
  render(
    <TagsProvider>
      <Harness id={asset.id} />
    </TagsProvider>,
  );
  await screen.findByText('c1.png');
  await user.type(screen.getByRole('combobox', { name: 'Tags' }), 'front view{Enter}');
  expect(await screen.findByRole('button', { name: 'Remove front view' })).toBeTruthy();
  await renameThroughDialog(user, 'Front View', 'Front');
  await waitFor(() =>
    expect((callsOf(api, 'files:list') as ListRequest[]).some((r) => r.tagNames?.join() === 'front')).toBe(true),
  );
  expect(screen.getByRole('button', { name: 'Remove front' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Remove front view' })).toBeNull();
});

it('files tab: after a rename no list request carries the old tag name', async () => {
  const user = userEvent.setup();
  const asset = assetDetail({ tags: [tagOf('Front View')] });
  const file = fileRecord({ originalName: 'c1.png', assetId: asset.id, role: 'reference' });
  const api = install(asset, { 'files:list': listOf([file]), ...renameHandlers({ 'front view': 'Front View' }) });
  render(
    <TagsProvider>
      <Harness id={asset.id} />
    </TagsProvider>,
  );
  await screen.findByText('c1.png');
  await user.type(screen.getByRole('combobox', { name: 'Tags' }), 'front view{Enter}');
  await waitFor(() =>
    expect((callsOf(api, 'files:list') as ListRequest[]).some((r) => r.tagNames?.join() === 'front view')).toBe(true),
  );
  const before = callsOf(api, 'files:list').length;
  await renameThroughDialog(user, 'Front View', 'Front');
  await waitFor(() =>
    expect((callsOf(api, 'files:list') as ListRequest[]).some((r) => r.tagNames?.join() === 'front')).toBe(true),
  );
  const after = (callsOf(api, 'files:list') as ListRequest[]).slice(before);
  expect(after.filter((r) => r.tagNames?.includes('front view'))).toEqual([]);
});

it('files tab: a rename reloads the list where it was, also with a filter on the renamed tag', async () => {
  const user = userEvent.setup();
  const asset = assetDetail({ tags: [tagOf('Front View')] });
  const files = Array.from({ length: 200 }, (_, i) =>
    fileRecord({ originalName: `File ${i}.png`, assetId: asset.id, role: 'reference' }),
  );
  const api = install(asset, { 'files:list': listOf(files), ...renameHandlers({ 'front view': 'Front View' }) });
  render(
    <TagsProvider>
      <Harness id={asset.id} />
    </TagsProvider>,
  );
  await screen.findByText('File 0.png');
  await user.type(screen.getByRole('combobox', { name: 'Tags' }), 'front view{Enter}');
  await screen.findByRole('button', { name: 'Remove front view' });
  const grid = await waitFor(() => {
    const current = screen.getByRole('listbox', { name: 'Files' });
    expect(within(current).getByText('File 0.png')).toBeTruthy();
    return current;
  });
  Object.defineProperty(grid, 'scrollTop', { configurable: true, value: 4800 });
  fireEvent.scroll(grid);
  await waitFor(() => expect((callsOf(api, 'files:list') as ListRequest[]).some((r) => r.offset === 60 && r.tagNames?.join() === 'front view')).toBe(true));

  await renameThroughDialog(user, 'Front View', 'Front');
  await waitFor(() => expect((callsOf(api, 'files:list') as ListRequest[]).some((r) => r.offset === 60 && r.tagNames?.join() === 'front')).toBe(true));
  // The reloaded view starts where the old one was, not at the top.
  await waitFor(() => expect(screen.getByRole('listbox', { name: 'Files' })).not.toBe(grid));
  expect(screen.queryByText('File 0.png')).toBeNull();
  expect(screen.getByText('File 100.png')).toBeTruthy();
});

function sourceOf(url: string) {
  return { id: nextId(), url, createdAt: NOW };
}

it('the header lists the sources; add, remove and open send their requests', async () => {
  const user = userEvent.setup();
  const oak = sourceOf('https://example.org/doors/oak-12');
  const asset = assetDetail({ sources: [oak] });
  const fake = fakeAssetSources(asset);
  const api = install(asset, fake.handlers);
  render(<Harness id={asset.id} />);
  const block = await screen.findByRole('group', { name: 'Sources' });
  expect(block.closest('header')).not.toBeNull();
  expect(within(block).getByRole('link', { name: oak.url })).toBeTruthy();

  await user.type(within(block).getByRole('textbox', { name: 'Add URL' }), 'https://textures.example.com/wood{Enter}');
  expect(await within(block).findByRole('link', { name: 'https://textures.example.com/wood' })).toBeTruthy();
  expect(callsOf(api, 'assets:addSource')).toEqual([{ assetId: asset.id, url: 'https://textures.example.com/wood' }]);
  await waitFor(() => expect((within(block).getByRole('textbox', { name: 'Add URL' }) as HTMLInputElement).value).toBe(''));

  await user.click(within(block).getByRole('link', { name: oak.url }));
  expect(callsOf(api, 'assets:openSource')).toEqual([{ assetId: asset.id, sourceId: oak.id }]);
  expect(fake.state.opened).toEqual([oak.id]);

  const oakRow = within(block).getByRole('link', { name: oak.url }).closest('li') as HTMLElement;
  await user.click(within(oakRow).getByRole('button', { name: 'Remove source' }));
  await waitFor(() => expect(within(block).queryByRole('link', { name: oak.url })).toBeNull());
  expect(callsOf(api, 'assets:removeSource')).toEqual([{ assetId: asset.id, sourceId: oak.id }]);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('adding a duplicate source shows the error in the header and keeps the text', async () => {
  const user = userEvent.setup();
  const asset = assetDetail({ sources: [sourceOf('https://example.org/')] });
  install(asset, fakeAssetSources(asset).handlers);
  render(<Harness id={asset.id} />);
  const block = await screen.findByRole('group', { name: 'Sources' });
  const field = within(block).getByRole('textbox', { name: 'Add URL' }) as HTMLInputElement;
  await user.type(field, 'https://example.org{Enter}');
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('This source already exists');
  expect(alert.closest('header')).not.toBeNull();
  await waitFor(() => expect(field.disabled).toBe(false));
  expect(field.value).toBe('https://example.org');
  expect(within(block).getAllByRole('link')).toHaveLength(1);
});

it('an address that is not a web address shows the fixed message in the header', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  install(asset, fakeAssetSources(asset).handlers);
  render(<Harness id={asset.id} />);
  const block = await screen.findByRole('group', { name: 'Sources' });
  const field = within(block).getByRole('textbox', { name: 'Add URL' }) as HTMLInputElement;
  await user.type(field, 'example.org{Enter}');
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('This is not a web address');
  expect(alert.closest('header')).not.toBeNull();
  await waitFor(() => expect(field.disabled).toBe(false));
  expect(field.value).toBe('example.org');
});

it('removing a source moves focus to the next source, else the previous one, else the input', async () => {
  const user = userEvent.setup();
  const [a, b, c] = [sourceOf('https://example.org/a'), sourceOf('https://example.org/b'), sourceOf('https://example.org/c')];
  const asset = assetDetail({ sources: [a!, b!, c!] });
  install(asset, fakeAssetSources(asset).handlers);
  render(<Harness id={asset.id} />);
  const block = await screen.findByRole('group', { name: 'Sources' });
  const removeOf = (url: string) =>
    within(within(block).getByRole('link', { name: url }).closest('li') as HTMLElement).getByRole('button', {
      name: 'Remove source',
    });

  await user.click(removeOf(a!.url));
  await waitFor(() => expect(within(block).queryByRole('link', { name: a!.url })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(removeOf(b!.url)));

  await user.click(removeOf(c!.url));
  await waitFor(() => expect(within(block).queryByRole('link', { name: c!.url })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(removeOf(b!.url)));

  await user.click(removeOf(b!.url));
  await waitFor(() => expect(within(block).queryByRole('link')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(within(block).getByRole('textbox', { name: 'Add URL' })));
});

it('a source that cannot be opened shows the error in the header', async () => {
  const user = userEvent.setup();
  const oak = sourceOf('https://example.org/');
  const asset = assetDetail({ sources: [oak] });
  install(asset, {
    ...fakeAssetSources(asset).handlers,
    'assets:openSource': () => {
      throw fakeError('invalid_operation', 'This source could not be opened');
    },
  });
  render(<Harness id={asset.id} />);
  await user.click(await screen.findByRole('link', { name: oak.url }));
  expect((await screen.findByRole('alert')).textContent).toBe('This source could not be opened');
});

it('during an import the Add URL input and the remove buttons are disabled, open stays usable', async () => {
  const user = userEvent.setup();
  const oak = sourceOf('https://example.org/');
  const asset = assetDetail({ sources: [oak] });
  const picked = deferred<string[]>();
  const fake = fakeAssetSources(asset);
  install(asset, { ...fake.handlers, 'dialog:pickFiles': () => picked.promise });
  render(<Harness id={asset.id} />);
  const block = await screen.findByRole('group', { name: 'Sources' });
  const field = within(block).getByRole('textbox', { name: 'Add URL' }) as HTMLInputElement;
  expect(field.disabled).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Import files' }));
  expect(field.disabled).toBe(true);
  expect((within(block).getByRole('button', { name: 'Remove source' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(within(block).getByRole('link', { name: oak.url }));
  expect(fake.state.opened).toEqual([oak.id]);
  picked.resolve([]);
  await waitFor(() => expect(field.disabled).toBe(false));
});

it('Import from URLs follows Import files and targets the asset with the selected role', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const api = install(asset, {
    'files:importUrls': () => ({ queued: 1, alreadyImported: 0, alreadyQueued: 0, invalid: [] }),
  });
  render(<Harness id={asset.id} />);
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Role for imported files' }), 'concept');
  const urlButton = screen.getByRole('button', { name: 'Import from URLs' });
  expect(urlButton.previousElementSibling?.textContent).toBe('Import files');
  await user.click(urlButton);
  const dialog = await screen.findByRole('dialog', { name: 'Import from URLs' });
  await user.click(within(dialog).getByRole('textbox', { name: 'URLs' }));
  await user.paste('https://a.test/x.png');
  await user.click(within(dialog).getByRole('button', { name: 'Import' }));
  expect(await within(dialog).findByText('Queued 1')).toBeTruthy();
  expect(callsOf(api, 'files:importUrls')).toEqual([
    { urls: ['https://a.test/x.png'], target: { assetId: asset.id, role: 'concept' }, skipDuplicates: true },
  ]);
});

it('Import from site follows Import from URLs, targets the asset with the selected role and reads the asset again', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const profile = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Shop',
    site: 'example.com',
    thumbnails: '//a',
    pagination: '',
    file: '',
    kinds: ['image' as const],
    minBytes: 0,
    urlContains: '',
    maxPages: 20,
    maxFiles: 1000,
  };
  const crawlId = '33333333-3333-4333-8333-333333333333';
  const api = install(asset, {
    'sites:list': () => ({ profiles: [profile] }),
    'sites:crawl': () => ({
      crawlId,
      files: ['https://example.com/a.png'],
      pages: 1,
      duplicates: 0,
      filtered: 0,
      disallowed: 0,
      invalid: 0,
      pageFailures: 0,
      truncated: null,
      cancelled: false,
      problems: [],
      problemsDropped: 0,
    }),
    'sites:crawlProgress': () => null,
    'sites:import': () => ({ queued: 1, alreadyImported: 0, alreadyQueued: 0, invalid: [] }),
  });
  render(<Harness id={asset.id} />);
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Role for imported files' }), 'concept');
  const siteButton = screen.getByRole('button', { name: 'Import from site' });
  expect(siteButton.previousElementSibling?.textContent).toBe('Import from URLs');
  await user.click(siteButton);
  const dialog = await screen.findByRole('dialog', { name: 'Import from site' });
  await waitFor(() => expect((within(dialog).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Shop'));
  await user.type(within(dialog).getByRole('textbox', { name: 'Gallery URL' }), 'https://example.com/g');
  await user.click(within(dialog).getByRole('button', { name: 'Test' }));
  await within(dialog).findByRole('list', { name: 'Found files' });
  const reads = callsOf(api, 'assets:get').length;
  await user.click(within(dialog).getByRole('button', { name: 'Import' }));
  expect(await within(dialog).findByText('Queued 1')).toBeTruthy();
  expect(callsOf(api, 'sites:import')).toEqual([{ crawlId, target: { assetId: asset.id, role: 'concept' } }]);
  await waitFor(() => expect(callsOf(api, 'assets:get').length).toBeGreaterThan(reads));
});

it('Import from URLs is disabled while files are imported', async () => {
  const user = userEvent.setup();
  const asset = assetDetail();
  const picked = deferred<string[]>();
  install(asset, { 'dialog:pickFiles': () => picked.promise });
  render(<Harness id={asset.id} />);
  await user.click(await screen.findByRole('button', { name: 'Import files' }));
  expect((screen.getByRole('button', { name: 'Import from URLs' }) as HTMLButtonElement).disabled).toBe(true);
  picked.resolve([]);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Import from URLs' }) as HTMLButtonElement).disabled).toBe(false));
});

it('a running import in the asset screen shows its progress, reloads the files while done changes and ends the title after a cancel', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const asset = assetDetail();
    const a = fileRecord({ originalName: 'a.png', assetId: asset.id, role: 'reference' });
    let files: FileRecord[] = [];
    const running = deferred<IpcResponse<'files:import'>>();
    let progress: IpcResponse<'files:importProgress'> = null;
    const api = install(asset, {
      'files:list': (request) => listOf(files)(request),
      'dialog:pickFiles': () => ['C:\\in\\a.png', 'C:\\in\\b.png'],
      'files:import': () => running.promise,
      'files:importProgress': () => progress,
      'files:cancelImport': () => ({ cancelling: true }),
    });
    render(<Harness id={asset.id} />);
    await user.click(await screen.findByRole('button', { name: 'Import files' }));
    await waitFor(() => expect(callsOf(api, 'files:import')).toHaveLength(1));
    expect(screen.getByText('Importing…')).toBeTruthy();

    progress = { done: 0, total: 2, currentBytes: 0, currentSize: null, cancelling: false };
    expect(await screen.findByText('0 of 2')).toBeTruthy();
    expect(screen.queryByText('Importing…')).toBeNull();

    files = [a];
    progress = { ...progress, done: 1 };
    expect(await screen.findByText('1 of 2')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(await screen.findByText('a.png')).toBeTruthy();
    expect(await screen.findByRole('tab', { name: 'Files 1' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(callsOf(api, 'files:cancelImport')).toEqual([{}]);
    progress = null;
    running.resolve([importResultOf('C:\\in\\a.png', { file: a })]);
    expect(await screen.findByText('1 imported, 0 failed, cancelled')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
