import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import {
  JOB_ERROR_MESSAGES,
  type Changes,
  type FileRecord,
  type IpcRequest,
  type IpcResponse,
  type JobSummary,
  type ProviderView,
} from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { NONE_ANALYSABLE } from '../../src/renderer/src/analysis';
import { ANALYSE_SELECTION_TITLE, ANALYSE_TITLE } from '../../src/renderer/src/labels';
import { OpenSettingsProvider } from '../../src/renderer/src/components/AnalysisDialogs';
import { JOB_POLL_MS, JobsProvider } from '../../src/renderer/src/jobs-context';
import { ProviderSettingsProvider } from '../../src/renderer/src/provider-context';
import { AnalysisPromptsProvider } from '../../src/renderer/src/analysis-prompts-context';
import { NO_FILE_FILTERS, type InboxListState } from '../../src/renderer/src/list-state';
import { InboxScreen } from '../../src/renderer/src/screens/InboxScreen';
import { TagsProvider } from '../../src/renderer/src/tags-context';
import { TrashProvider } from '../../src/renderer/src/trash-context';
import {
  deferred,
  fakeError,
  fakeProviders,
  importResultOf,
  installFakeApi,
  noChanges,
  providerView,
  type FakeHandlers,
} from './fake-api';
import { assetSummary, fileRecord, NONE_SKIPPED, nonImageRecord, pageOf, tagOf } from './fixtures';
import { renameHandlers, renameThroughDialog } from './rename-flow';

const INITIAL: InboxListState = { filters: NO_FILE_FILTERS, scrollOffset: 0 };
const OAK = assetSummary({ name: 'Oak' });

type ListRequest = IpcRequest<'files:list'>;

/** Serves the files that `current()` returns, page by page; with `ids` only those. */
function listOf(current: () => FileRecord[]) {
  return (request: ListRequest) => {
    const ids = request.ids;
    const items = ids === undefined ? current() : current().filter((f) => ids.includes(f.id));
    return pageOf(items.slice(request.offset, request.offset + request.limit), items.length);
  };
}

function install(files: FileRecord[], handlers: FakeHandlers = {}) {
  let items = files;
  const api = installFakeApi({
    'files:list': listOf(() => items),
    'tags:suggest': () => [],
    'assets:list': () => pageOf([OAK]),
    ...handlers,
  });
  return {
    ...api,
    setFiles(next: FileRecord[]) {
      items = next;
    },
  };
}

function callsOf(api: ReturnType<typeof install>, channel: string) {
  return api.calls.filter((c) => c.channel === channel).map((c) => c.request);
}

interface HarnessProps {
  initial?: InboxListState;
  onState?(s: InboxListState): void;
  onBusyChange?(busy: boolean): void;
}

function Harness(props: HarnessProps) {
  const [state, setState] = useState(props.initial ?? INITIAL);
  return (
    <div className="flex h-[800px] flex-col">
      <InboxScreen
        state={state}
        onStateChange={(next) => {
          props.onState?.(next);
          setState(next);
        }}
        onBusyChange={props.onBusyChange ?? (() => {})}
      />
    </div>
  );
}

function tile(name: string): HTMLElement {
  const element = within(screen.getByRole('listbox', { name: 'Files' }))
    .getByText(name)
    .closest<HTMLElement>('[data-index]');
  if (element === null) throw new Error(`no tile for ${name}`);
  return element;
}

function column(): HTMLElement {
  return screen.getByRole('complementary');
}

async function pickAsset(user: ReturnType<typeof userEvent.setup>) {
  const picker = within(column()).getByRole('combobox', { name: 'Search assets' });
  await user.click(picker);
  await within(column()).findByRole('option', { name: 'Oak' });
  await user.keyboard('{ArrowDown}{Enter}');
  expect((await within(column()).findByTitle('Target asset')).textContent).toBe('Oak');
}

function files() {
  const c1 = fileRecord({ originalName: 'c1.png' });
  const c2 = fileRecord({ originalName: 'c2.png' });
  const f1 = fileRecord({
    originalName: 'f1.png',
    status: 'failed',
    sha256: null,
    error: 'The checksum did not match',
  });
  return { c1, c2, f1 };
}

async function selectRange(user: ReturnType<typeof userEvent.setup>, first: string, last: string) {
  await screen.findByText(first);
  await user.click(tile(first));
  await user.keyboard('{Shift>}');
  await user.click(tile(last));
  await user.keyboard('{/Shift}');
}

it('failed files are excluded from the assign request and the count', async () => {
  const user = userEvent.setup();
  const { c1, c2, f1 } = files();
  const api = install([c1, c2, f1], {
    'files:assignMany': (r) => ({
      items: r.fileIds.map((fileId) => ({
        fileId,
        file: { ...(fileId === c1.id ? c1 : c2), assetId: OAK.id, role: r.role },
        error: null,
      })),
    }),
  });
  render(<Harness />);
  await selectRange(user, 'c1.png', 'f1.png');
  expect(await screen.findByText('3 selected')).toBeTruthy();

  const assign = within(column()).getByRole('button', { name: 'Assign 2 files' });
  expect((assign as HTMLButtonElement).disabled).toBe(true);
  // The failed import is marked in the list of names, with its error as tooltip.
  const names = within(column()).getByRole('list', { name: 'Selected files' });
  const failed = within(names).getByText('Failed');
  expect(failed.getAttribute('title')).toBe('The checksum did not match');

  await pickAsset(user);
  expect((assign as HTMLButtonElement).disabled).toBe(false);
  await user.click(assign);
  await waitFor(() =>
    expect(callsOf(api, 'files:assignMany')).toEqual([{ fileIds: [c1.id, c2.id], assetId: OAK.id, role: 'reference' }]),
  );
});

it('a partially failed assign lists the failure and drops the moved files', async () => {
  const user = userEvent.setup();
  const { c1, c2 } = files();
  const api = install([c1, c2], {
    'files:assignMany': () => {
      api.setFiles([c2]);
      return {
        items: [
          { fileId: c1.id, file: { ...c1, assetId: OAK.id, role: 'reference' }, error: null },
          { fileId: c2.id, file: null, error: { code: 'not_found', message: 'not_found' } },
        ],
      };
    },
  });
  render(<Harness />);
  await selectRange(user, 'c1.png', 'c2.png');
  await pickAsset(user);
  await user.selectOptions(within(column()).getByRole('combobox', { name: 'Role' }), 'concept');
  const before = callsOf(api, 'files:list').length;
  await user.click(within(column()).getByRole('button', { name: 'Assign 2 files' }));

  const strip = await within(column()).findByRole('alert');
  expect(strip.textContent).toContain('c2.png');
  expect(strip.textContent).toContain('This item no longer exists.');
  expect(callsOf(api, 'files:assignMany')).toEqual([{ fileIds: [c1.id, c2.id], assetId: OAK.id, role: 'concept' }]);
  await waitFor(() => expect(callsOf(api, 'files:list').length).toBeGreaterThan(before));
  await waitFor(() => expect(within(screen.getByRole('listbox', { name: 'Files' })).queryByText('c1.png')).toBeNull());
  expect(screen.getByText('1 selected')).toBeTruthy();
  const names = within(column()).getByRole('list', { name: 'Selected files' });
  expect(within(names).getByText('c2.png')).toBeTruthy();
  expect(within(names).queryByText('c1.png')).toBeNull();
  expect(within(names).getByText('Failed').getAttribute('title')).toBe('This item no longer exists.');
});

it('the assign failure strip goes once no failed file is selected any more', async () => {
  const user = userEvent.setup();
  const { c1, c2 } = files();
  const c3 = fileRecord({ originalName: 'c3.png' });
  const api = install([c1, c2, c3], {
    'files:assignMany': () => {
      api.setFiles([c2, c3]);
      return {
        items: [
          { fileId: c1.id, file: { ...c1, assetId: OAK.id, role: 'reference' }, error: null },
          { fileId: c2.id, file: null, error: { code: 'not_found', message: 'not_found' } },
        ],
      };
    },
  });
  render(<Harness />);
  await selectRange(user, 'c1.png', 'c2.png');
  await pickAsset(user);
  await user.click(within(column()).getByRole('button', { name: 'Assign 2 files' }));
  expect((await within(column()).findByRole('alert')).textContent).toContain('c2.png');
  await waitFor(() => expect(screen.getByText('1 selected')).toBeTruthy());

  await user.click(tile('c3.png'));
  await waitFor(() =>
    expect(within(within(column()).getByRole('list', { name: 'Selected files' })).getByText('c3.png')).toBeTruthy(),
  );
  expect(within(column()).queryByRole('alert')).toBeNull();
  // Selecting the failed file again does not bring the old strip back.
  await user.click(tile('c2.png'));
  await waitFor(() =>
    expect(within(within(column()).getByRole('list', { name: 'Selected files' })).getByText('c2.png')).toBeTruthy(),
  );
  expect(within(column()).queryByRole('alert')).toBeNull();
});

it('shared image tags show only tags every eligible file carries; removing one removes it from all', async () => {
  const user = userEvent.setup();
  const c1 = fileRecord({ originalName: 'c1.png', tags: [tagOf('oak'), tagOf('bark')] });
  const c2 = fileRecord({ originalName: 'c2.png', tags: [tagOf('bark')] });
  const f1 = fileRecord({ originalName: 'f1.png', status: 'failed', sha256: null, error: 'Broken' });
  const api = install([c1, c2, f1], {
    'files:removeTagMany': (r) => {
      const items = [c1, c2].map((f) => ({ ...f, tags: f.tags.filter((t) => t.name !== r.name) }));
      api.setFiles([...items, f1]);
      return { items };
    },
  });
  render(<Harness />);
  await selectRange(user, 'c1.png', 'f1.png');
  const row = within(column()).getByRole('group', { name: 'Shared image tags' });
  expect(within(row).getByRole('button', { name: 'Remove bark' })).toBeTruthy();
  expect(within(row).queryByRole('button', { name: 'Remove oak' })).toBeNull();

  await user.click(within(row).getByRole('button', { name: 'Remove bark' }));
  await waitFor(() => expect(within(row).queryByRole('button', { name: 'Remove bark' })).toBeNull());
  expect(callsOf(api, 'files:removeTagMany')).toEqual([{ fileIds: [c1.id, c2.id], name: 'bark' }]);
});

it('a late shared-tag answer does not bring back a cleared selection', async () => {
  const user = userEvent.setup();
  const c1 = fileRecord({ originalName: 'c1.png', tags: [tagOf('bark')] });
  const c2 = fileRecord({ originalName: 'c2.png', tags: [tagOf('bark')] });
  const answer = deferred<{ items: FileRecord[] }>();
  install([c1, c2], { 'files:removeTagMany': () => answer.promise });
  render(<Harness />);
  await selectRange(user, 'c1.png', 'c2.png');
  const row = within(column()).getByRole('group', { name: 'Shared image tags' });
  await user.click(within(row).getByRole('button', { name: 'Remove bark' }));
  await user.click(screen.getByRole('button', { name: 'Clear selection' }));
  expect(screen.queryByRole('complementary')).toBeNull();

  answer.resolve({ items: [c1, c2].map((f) => ({ ...f, tags: [] })) });
  await waitFor(() => expect(screen.getByText('c1.png')).toBeTruthy());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole('complementary')).toBeNull();
  expect(screen.queryByText('2 selected')).toBeNull();
});

it('Add tags in the selection bar focuses the shared tag input', async () => {
  const user = userEvent.setup();
  const { c1, c2 } = files();
  install([c1, c2]);
  render(<Harness />);
  await selectRange(user, 'c1.png', 'c2.png');
  await user.click(screen.getByRole('button', { name: 'Add tags' }));
  expect(document.activeElement).toBe(within(column()).getByRole('combobox', { name: 'Add image tag' }));
});

it('"n images" when every selected file is an image, else "n files"', async () => {
  const user = userEvent.setup();
  const a = fileRecord({ originalName: 'a.png' });
  const b = fileRecord({ originalName: 'b.png' });
  const m = fileRecord({ originalName: 'm.glb', kind: 'model', mimeType: 'model/gltf-binary', previewable: false });
  install([a, b, m]);
  render(<Harness />);
  expect(screen.queryByRole('complementary')).toBeNull();
  await selectRange(user, 'a.png', 'b.png');
  expect(within(column()).getByText('2 images')).toBeTruthy();
  await user.keyboard('{Control>}');
  await user.click(tile('m.glb'));
  await user.keyboard('{/Control}');
  expect(within(column()).getByText('3 files')).toBeTruthy();
  expect(within(column()).getByRole('heading', { name: 'Selection' })).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Clear selection' }));
  expect(screen.queryByRole('complementary')).toBeNull();
});

it('filters and scroll offset survive navigation; the selection does not', async () => {
  const user = userEvent.setup();
  const items = Array.from({ length: 200 }, (_, i) => fileRecord({ originalName: `File ${i}.png` }));
  const onState = vi.fn();
  const api = install(items);
  const { unmount } = render(<Harness onState={onState} />);
  await screen.findByText('File 0.png');
  await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: /Inbox/ }).textContent).toBe('Inbox200'));
  expect(callsOf(api, 'files:list')).toContainEqual({ limit: 1, offset: 0, scope: { kind: 'inbox' } });

  await user.type(screen.getByRole('searchbox', { name: 'Search files' }), 'file');
  await user.selectOptions(screen.getByRole('combobox', { name: 'File type' }), 'image');
  const expected = { limit: 60, offset: 0, scope: { kind: 'inbox' }, query: 'file', kind: 'image' };
  await waitFor(() => expect(callsOf(api, 'files:list').at(-1)).toEqual(expected));
  await user.click(await screen.findByText('File 1.png'));
  expect(screen.getByText('1 selected')).toBeTruthy();

  const grid = screen.getByRole('listbox', { name: 'Files' });
  Object.defineProperty(grid, 'scrollTop', { configurable: true, value: 4800 });
  fireEvent.scroll(grid);
  await waitFor(() => expect(callsOf(api, 'files:list')).toContainEqual({ ...expected, offset: 60 }));
  unmount();
  const saved = onState.mock.lastCall![0] as InboxListState;
  expect(saved).toEqual({ filters: { query: 'file', role: '', kind: 'image', tagNames: [] }, scrollOffset: 4800 });

  api.calls.length = 0;
  render(<Harness initial={saved} />);
  await waitFor(() => expect(callsOf(api, 'files:list')).toContainEqual({ ...expected, offset: 60 }));
  expect((screen.getByRole('searchbox', { name: 'Search files' }) as HTMLInputElement).value).toBe('file');
  expect(screen.queryByText('1 selected')).toBeNull();
  expect(screen.queryByRole('complementary')).toBeNull();
});

it('empty inbox and no-result states', async () => {
  const user = userEvent.setup();
  const api = install([], { 'dialog:pickFiles': () => [] });
  render(<Harness />);
  expect(await screen.findByText('Inbox is empty')).toBeTruthy();
  const buttons = screen.getAllByRole('button', { name: 'Import files' });
  expect(buttons).toHaveLength(2);
  await user.click(buttons[1]!);
  await waitFor(() => expect(callsOf(api, 'dialog:pickFiles')).toHaveLength(1));

  await user.selectOptions(screen.getByRole('combobox', { name: 'File type' }), 'model');
  expect(await screen.findByText('No matching files')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Import files' })).toHaveLength(1);
});

it('import results list imported, failed and duplicates', async () => {
  const user = userEvent.setup();
  const picked = deferred<string[]>();
  const a = fileRecord({ originalName: 'a.png' });
  const b = fileRecord({ originalName: 'b.png' });
  const api = install([], {
    'dialog:pickFiles': () => picked.promise,
    'files:import': () => {
      api.setFiles([a, b]);
      return [
        { sourcePath: 'C:\\in\\a.png', entryName: null, file: a, error: null, duplicateOf: [] },
        { sourcePath: 'C:\\in\\b.png', entryName: null, file: b, error: null, duplicateOf: [a.id] },
        {
          sourcePath: 'C:\\in\\c.exe',
          entryName: null,
          file: null,
          error: 'This file type cannot be imported',
          duplicateOf: [],
        },
      ];
    },
  });
  const onBusyChange = vi.fn();
  render(<Harness onBusyChange={onBusyChange} />);
  await screen.findByText('Inbox is empty');
  await user.click(screen.getAllByRole('button', { name: 'Import files' })[0]!);
  // The file picker is open: busy, but nothing is imported yet.
  expect(screen.queryByText('Importing…')).toBeNull();
  expect(onBusyChange).toHaveBeenLastCalledWith(true);
  picked.resolve(['C:\\in\\a.png', 'C:\\in\\b.png', 'C:\\in\\c.exe']);

  const strip = await screen.findByRole('alert');
  expect(within(strip).getByText('2 imported, 1 failed, 1 duplicates')).toBeTruthy();
  expect(strip.textContent).toContain('c.exe');
  expect(strip.textContent).toContain('This file type cannot be imported');
  expect(strip.textContent).not.toContain('C:\\in');
  // No ZIP was picked: no dialog, nothing to unpack.
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(callsOf(api, 'files:import')).toEqual([
    { sourcePaths: ['C:\\in\\a.png', 'C:\\in\\b.png', 'C:\\in\\c.exe'], unpackArchives: false },
  ]);
  expect(await screen.findByText('a.png')).toBeTruthy();
  await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: /Inbox/ }).textContent).toBe('Inbox2'));
  await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
});

it('a picked ZIP asks first; Unpack sends unpackArchives true and the strip counts entries', async () => {
  const user = userEvent.setup();
  const d = fileRecord({ originalName: 'd.png' });
  const e = fileRecord({ originalName: 'e.png' });
  const api = install([], {
    'dialog:pickFiles': () => ['C:\\in\\pack.zip', 'C:\\in\\f.png'],
    'files:import': () => [
      importResultOf('C:\\in\\pack.zip', { entryName: 'd.png', file: d }),
      importResultOf('C:\\in\\pack.zip', { entryName: 'a.exe', error: 'This file type cannot be imported' }),
      importResultOf('C:\\in\\f.png', { file: e, duplicateOf: [d.id] }),
    ],
  });
  render(<Harness />);
  await screen.findByText('Inbox is empty');
  await user.click(screen.getAllByRole('button', { name: 'Import files' })[0]!);
  const dialog = await screen.findByRole('dialog', { name: 'ZIP archive' });
  expect(within(dialog).getByText('pack.zip')).toBeTruthy();
  expect(callsOf(api, 'files:import')).toEqual([]);
  await user.click(within(dialog).getByRole('button', { name: 'Unpack' }));

  const strip = await screen.findByRole('alert');
  expect(within(strip).getByText('2 imported, 1 failed, 1 duplicates')).toBeTruthy();
  expect(strip.textContent).toContain('a.exe (pack.zip)');
  expect(strip.textContent).not.toContain('C:\\in');
  expect(callsOf(api, 'files:import')).toEqual([
    { sourcePaths: ['C:\\in\\pack.zip', 'C:\\in\\f.png'], unpackArchives: true },
  ]);
});

it('Import as file sends unpackArchives false; an archive-level failure is named by the archive', async () => {
  const user = userEvent.setup();
  const api = install([], {
    'dialog:pickFiles': () => ['C:\\in\\a.zip', 'C:\\in\\pack.zip'],
    'files:import': () => [
      importResultOf('C:\\in\\a.zip', { file: fileRecord({ originalName: 'a.zip', kind: 'other' }) }),
      importResultOf('C:\\in\\pack.zip', { error: 'This file is not a readable ZIP archive' }),
    ],
  });
  render(<Harness />);
  await screen.findByText('Inbox is empty');
  await user.click(screen.getAllByRole('button', { name: 'Import files' })[0]!);
  const dialog = await screen.findByRole('dialog', { name: 'ZIP archive' });
  expect(within(dialog).getByText('2 archives')).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Import as file' }));

  const strip = await screen.findByRole('alert');
  expect(within(strip).getByText('1 imported, 1 failed, 0 duplicates')).toBeTruthy();
  expect(within(strip).getByText('pack.zip')).toBeTruthy();
  expect(callsOf(api, 'files:import')).toEqual([
    { sourcePaths: ['C:\\in\\a.zip', 'C:\\in\\pack.zip'], unpackArchives: false },
  ]);
});

it.each([
  [
    'Cancel',
    async (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) =>
      user.click(within(dialog).getByRole('button', { name: 'Cancel' })),
  ],
  ['Esc', async (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}')],
])('%s in the ZIP dialog imports nothing and enables the import button again', async (_name, dismiss) => {
  const user = userEvent.setup();
  const api = install([], { 'dialog:pickFiles': () => ['C:\\in\\pack.zip'], 'files:import': () => [] });
  const onBusyChange = vi.fn();
  render(<Harness onBusyChange={onBusyChange} />);
  await screen.findByText('Inbox is empty');
  const button = screen.getAllByRole('button', { name: 'Import files' })[0] as HTMLButtonElement;
  await user.click(button);
  const dialog = await screen.findByRole('dialog', { name: 'ZIP archive' });
  expect(button.disabled).toBe(true);
  await dismiss(user, dialog);

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() =>
    expect((screen.getAllByRole('button', { name: 'Import files' })[0] as HTMLButtonElement).disabled).toBe(false),
  );
  expect(screen.queryByText('Importing…')).toBeNull();
  expect(onBusyChange).toHaveBeenLastCalledWith(false);
  expect(callsOf(api, 'files:import')).toEqual([]);
  expect(screen.queryByRole('alert')).toBeNull();

  // A new import starts the choice again.
  await user.click(screen.getAllByRole('button', { name: 'Import files' })[0]!);
  expect(await screen.findByRole('dialog', { name: 'ZIP archive' })).toBeTruthy();
});

async function assignInDialog(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.click(within(dialog).getByRole('button', { name: 'Assign' }));
  await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Role' }), 'texture');
  await user.click(within(dialog).getByRole('combobox', { name: 'Search assets' }));
  await within(dialog).findByRole('option', { name: 'Oak' });
  await user.keyboard('{ArrowDown}{Enter}');
}

it('assigning in the detail dialog moves on to the following file; assigning the last one closes it', async () => {
  const user = userEvent.setup();
  const { c1, c2 } = files();
  let remaining = [c1, c2];
  const api = install(remaining, {
    'files:assign': (r) => {
      const file = remaining.find((f) => f.id === r.fileId)!;
      remaining = remaining.filter((f) => f.id !== r.fileId);
      api.setFiles(remaining);
      return { ...file, assetId: r.assetId, role: r.role };
    },
  });
  render(<Harness />);
  await screen.findByText('c1.png');
  await user.click(tile('c1.png'));
  await user.keyboard('{Enter}');
  const first = await screen.findByRole('dialog', { name: 'c1.png' });
  expect(within(first).getByText('1 / 2')).toBeTruthy();
  await assignInDialog(user, first);

  const second = await screen.findByRole('dialog', { name: 'c2.png' });
  expect(within(second).getByText('1 / 1')).toBeTruthy();
  expect(callsOf(api, 'files:assign')).toEqual([{ fileId: c1.id, assetId: OAK.id, role: 'texture' }]);
  await waitFor(() => expect(within(screen.getByRole('listbox', { name: 'Files' })).queryByText('c1.png')).toBeNull());
  expect(screen.queryByText('1 selected')).toBeNull();

  await assignInDialog(user, second);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(callsOf(api, 'files:assign')).toHaveLength(2);
  await screen.findByText('Inbox is empty');
});

const VISION: ProviderView = providerView();
const NO_JOBS: JobSummary = {
  queued: 0,
  running: 0,
  waiting: 0,
  failed: 0,
  cancelled: 0,
  succeeded: 0,
  changes: 0,
  paused: [],
  pausedHosts: [],
};

/** The provider, job and analysis channels the dialogs use; `entry` null means no provider is configured. */
function analysisHandlers(entry: ProviderView | null = VISION): FakeHandlers {
  return {
    ...(entry === null
      ? fakeProviders().handlers
      : fakeProviders(
          { providers: [entry], lastUsedId: entry.id },
          { [entry.id]: { ok: true, models: [{ name: 'vision-a', vision: true }] } },
        ).handlers),
    'jobs:summary': () => NO_JOBS,
    'analysis:getProposal': () => ({ proposal: null, job: null }),
    'analysis:preview': () => ({ analysable: 2, alreadyAnalysed: 0, alreadyQueued: 0, notAnalysable: 0 }),
    'analysis:enqueue': () => ({ enqueued: 1, skipped: { ...NONE_SKIPPED, alreadyQueued: 1 } }),
  };
}

/** The inbox inside the job and provider contexts, as the workspace shell mounts it. */
function renderWithProvider() {
  return render(
    <JobsProvider>
      <ProviderSettingsProvider>
        <AnalysisPromptsProvider>
          <Harness />
        </AnalysisPromptsProvider>
      </ProviderSettingsProvider>
    </JobsProvider>,
  );
}

it('Settings in the result dialog closes it and the detail dialog beneath before the settings open', async () => {
  const user = userEvent.setup();
  const proposed = fileRecord({ originalName: 'proposed.png', hasProposal: true });
  install([proposed], analysisHandlers(null));
  // The screen stays mounted: only the dialogs' own closing can remove them.
  const onOpenSettings = vi.fn();
  render(
    <JobsProvider>
      <ProviderSettingsProvider>
        <AnalysisPromptsProvider>
          <OpenSettingsProvider onOpenSettings={onOpenSettings}>
            <Harness />
          </OpenSettingsProvider>
        </AnalysisPromptsProvider>
      </ProviderSettingsProvider>
    </JobsProvider>,
  );
  await screen.findByText('proposed.png');
  await user.click(tile('proposed.png'));
  await user.keyboard('{Enter}');
  const detail = await screen.findByRole('dialog', { name: 'proposed.png' });
  await user.click(within(detail).getByRole('button', { name: 'More' }));
  await user.click(screen.getByRole('menuitem', { name: 'Review tags' }));
  await waitFor(() => expect(screen.getAllByRole('dialog', { name: 'proposed.png' })).toHaveLength(2));
  const [, result] = screen.getAllByRole('dialog', { name: 'proposed.png' });
  await user.click(await within(result!).findByRole('button', { name: 'Settings' }));
  expect(onOpenSettings).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(within(tile(name)).getByRole('button', { name: 'File actions' }));
}

it('the tile menu Analyse opens the result dialog of the image; other files get no Analyse', async () => {
  const user = userEvent.setup();
  const { c1 } = files();
  const blend = nonImageRecord('tree.blend');
  const api = install([c1, blend], analysisHandlers());
  renderWithProvider();
  await screen.findByText('tree.blend');
  await openMenu(user, 'tree.blend');
  expect(screen.queryByRole('menuitem', { name: 'Analyse' })).toBeNull();
  await user.keyboard('{Escape}');
  await openMenu(user, 'c1.png');
  await user.click(screen.getByRole('menuitem', { name: 'Analyse' }));
  const dialog = await screen.findByRole('dialog', { name: 'c1.png' });
  expect(within(dialog).getByRole('combobox', { name: 'Tagging model' })).toBeTruthy();
  expect(callsOf(api, 'analysis:getProposal')).toEqual([{ fileId: c1.id }]);
  expect(callsOf(api, 'analysis:enqueue')).toEqual([]);
});

it('the detail dialog Analyse opens the result dialog above it', async () => {
  const user = userEvent.setup();
  const { c1 } = files();
  const api = install([c1], analysisHandlers());
  renderWithProvider();
  await screen.findByText('c1.png');
  await user.click(tile('c1.png'));
  await user.keyboard('{Enter}');
  const detail = await screen.findByRole('dialog', { name: 'c1.png' });
  await user.click(within(detail).getByRole('button', { name: 'More' }));
  await user.click(screen.getByRole('menuitem', { name: 'Analyse' }));
  await waitFor(() => expect(screen.getAllByRole('dialog', { name: 'c1.png' })).toHaveLength(2));
  expect(callsOf(api, 'analysis:getProposal')).toEqual([{ fileId: c1.id }]);
});

it('Analyse on several selected files opens the start dialog for all of them; Start shows the counts in the strip', async () => {
  const user = userEvent.setup();
  const { c1, c2 } = files();
  const doc = nonImageRecord('notes.pdf');
  const api = install([c1, c2, doc], analysisHandlers());
  renderWithProvider();
  await selectRange(user, 'c1.png', 'notes.pdf');
  expect(screen.queryByRole('button', { name: 'Image to prompt' })).toBeNull();
  const analyse = screen.getByRole('button', { name: 'Analyse' });
  expect(analyse.title).toBe(ANALYSE_SELECTION_TITLE);
  await user.click(analyse);
  await screen.findByRole('dialog', { name: 'Analyse' });
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false),
  );
  const target = { kind: 'files', fileIds: [c1.id, c2.id, doc.id] };
  expect(callsOf(api, 'analysis:preview')).toEqual([{ target, model: 'vision-a', providerId: VISION.id }]);
  await user.click(screen.getByRole('button', { name: 'Start' }));
  const strip = await screen.findByRole('status');
  expect(within(strip).getByText('1 queued, 1 already queued')).toBeTruthy();
  expect(callsOf(api, 'analysis:enqueue')).toEqual([
    { target, model: 'vision-a', providerId: VISION.id, mode: 'apply', force: false, promptId: expect.any(String) },
  ]);
  expect(screen.getByText('3 selected')).toBeTruthy();
});

it('one image among several selected files opens the start dialog, not the single-image dialog', async () => {
  const user = userEvent.setup();
  const { c1 } = files();
  const doc = nonImageRecord('notes.pdf');
  const api = install([c1, doc], analysisHandlers());
  renderWithProvider();
  await selectRange(user, 'c1.png', 'notes.pdf');
  await user.click(screen.getByRole('button', { name: 'Analyse' }));
  await screen.findByRole('dialog', { name: 'Analyse' });
  expect(screen.queryByRole('dialog', { name: 'c1.png' })).toBeNull();
  await waitFor(() => expect(callsOf(api, 'analysis:preview')).toHaveLength(1));
  expect(callsOf(api, 'analysis:preview')[0]).toEqual({
    target: { kind: 'files', fileIds: [c1.id, doc.id] },
    model: 'vision-a',
    providerId: VISION.id,
  });
  expect(callsOf(api, 'analysis:getProposal')).toEqual([]);
});

it('a single selected image keeps the single-image title and opens the result dialog', async () => {
  const user = userEvent.setup();
  const { c1 } = files();
  const api = install([c1], analysisHandlers());
  renderWithProvider();
  await screen.findByText('c1.png');
  await user.click(tile('c1.png'));
  const analyse = screen.getByRole('button', { name: 'Analyse' });
  expect(analyse.title).toBe(ANALYSE_TITLE);
  await user.click(analyse);
  await screen.findByRole('dialog', { name: 'c1.png' });
  expect(callsOf(api, 'analysis:getProposal')).toEqual([{ fileId: c1.id }]);
});

it('Analyse is disabled for a selection without images; one image adds Image to prompt, a proposal Review tags', async () => {
  const user = userEvent.setup();
  const proposed = fileRecord({ originalName: 'proposed.png', hasProposal: true });
  const doc = nonImageRecord('notes.pdf');
  const api = install([doc, proposed], analysisHandlers());
  renderWithProvider();
  await screen.findByText('notes.pdf');
  await user.click(tile('notes.pdf'));
  const analyse = screen.getByRole('button', { name: 'Analyse' }) as HTMLButtonElement;
  expect(analyse.disabled).toBe(true);
  expect(analyse.title).toBe(NONE_ANALYSABLE);
  expect(screen.queryByRole('button', { name: 'Image to prompt' })).toBeNull();

  await user.click(tile('proposed.png'));
  expect(analyse.disabled).toBe(false);
  expect(screen.getByRole('button', { name: 'Image to prompt' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Review tags' }));
  await screen.findByRole('dialog', { name: 'proposed.png' });
  expect(callsOf(api, 'analysis:getProposal')).toEqual([{ fileId: proposed.id }]);
});

it('Image to prompt in the selection bar opens the prompt dialog', async () => {
  const user = userEvent.setup();
  const { c1 } = files();
  install([c1], analysisHandlers());
  renderWithProvider();
  await screen.findByText('c1.png');
  await user.click(tile('c1.png'));
  await user.click(screen.getByRole('button', { name: 'Image to prompt' }));
  expect(await screen.findByRole('dialog', { name: 'Image to prompt' })).toBeTruthy();
});

it('Analyse all sends the current filters of the inbox as a file filter target', async () => {
  const user = userEvent.setup();
  const { c1 } = files();
  const api = install([c1], analysisHandlers());
  render(
    <JobsProvider>
      <ProviderSettingsProvider>
        <AnalysisPromptsProvider>
          <Harness initial={{ filters: { ...NO_FILE_FILTERS, tagNames: ['oak'], kind: 'image' }, scrollOffset: 0 }} />
        </AnalysisPromptsProvider>
      </ProviderSettingsProvider>
    </JobsProvider>,
  );
  await screen.findByText('c1.png');
  await user.click(screen.getByRole('button', { name: 'Analyse all' }));
  await screen.findByRole('dialog', { name: 'Analyse' });
  await waitFor(() => expect(callsOf(api, 'analysis:preview')).toHaveLength(1));
  expect(callsOf(api, 'analysis:preview')[0]).toEqual({
    target: { kind: 'fileFilter', filter: { scope: { kind: 'inbox' }, tagNames: ['oak'], kind: 'image' } },
    model: 'vision-a',
    providerId: VISION.id,
  });
});

it('the proposal filter lists only files with a proposal, marks them and blocks Analyse all', async () => {
  const user = userEvent.setup();
  const plain = fileRecord({ originalName: 'plain.png' });
  const proposed = fileRecord({ originalName: 'proposed.png', hasProposal: true });
  const api = install([plain, proposed], {
    ...analysisHandlers(),
    'files:list': (request: ListRequest) => {
      const items = request.hasProposal === true ? [proposed] : [plain, proposed];
      return pageOf(items.slice(request.offset, request.offset + request.limit), items.length);
    },
  });
  renderWithProvider();
  await screen.findByText('plain.png');
  expect(within(tile('proposed.png')).getByRole('img', { name: 'Tag proposal' }).title).toBe(
    'Tag proposal waiting for review',
  );
  expect(within(tile('plain.png')).queryByRole('img', { name: 'Tag proposal' })).toBeNull();

  const toggle = screen.getByRole('button', { name: 'Proposals' });
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  await user.click(toggle);
  await waitFor(() =>
    expect(within(screen.getByRole('listbox', { name: 'Files' })).queryByText('plain.png')).toBeNull(),
  );
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect(callsOf(api, 'files:list').some((r) => (r as ListRequest).hasProposal === true)).toBe(true);
  const all = screen.getByRole('button', { name: 'Analyse all' }) as HTMLButtonElement;
  expect(all.disabled).toBe(true);
  expect(all.title).toBe('Turn off the proposal filter to analyse all');
});

it('the detail dialog and the table row mark a file with a proposal', async () => {
  const user = userEvent.setup();
  const plain = fileRecord({ originalName: 'plain.png' });
  const proposed = fileRecord({ originalName: 'proposed.png', hasProposal: true });
  install([plain, proposed], analysisHandlers());
  renderWithProvider();
  await screen.findByText('plain.png');
  await openMenu(user, 'proposed.png');
  await user.click(screen.getByRole('menuitem', { name: 'Details' }));
  const detail = await screen.findByRole('dialog', { name: 'proposed.png' });
  expect(within(detail).getAllByRole('img', { name: 'Tag proposal' }).length).toBeGreaterThan(0);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  await user.click(screen.getByRole('button', { name: 'Show as table' }));
  const row = (await screen.findByText('proposed.png')).closest<HTMLElement>('[role="row"]');
  const plainRow = screen.getByText('plain.png').closest<HTMLElement>('[role="row"]');
  expect(row).not.toBeNull();
  expect(within(row!).getByRole('img', { name: 'Tag proposal' }).title).toBe('Tag proposal waiting for review');
  expect(within(plainRow!).queryByRole('img', { name: 'Tag proposal' })).toBeNull();
});

it('Review tags in the menu opens the proposal; accepting it reloads the list', async () => {
  const user = userEvent.setup();
  const proposed = fileRecord({ originalName: 'proposed.png', hasProposal: true });
  const api = install([proposed], {
    ...analysisHandlers(),
    'analysis:getProposal': () => ({
      proposal: {
        model: 'vision-a',
        promptName: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        stale: false,
        tags: [{ name: 'oak', displayName: 'Oak' }],
      },
      job: null,
    }),
    'analysis:acceptProposal': () => ({}),
  });
  renderWithProvider();
  await screen.findByText('proposed.png');
  await openMenu(user, 'proposed.png');
  await user.click(screen.getByRole('menuitem', { name: 'Review tags' }));
  const dialog = await screen.findByRole('dialog', { name: 'proposed.png' });
  const lists = callsOf(api, 'files:list').length;
  await user.click(await within(dialog).findByRole('button', { name: 'Accept' }));
  await waitFor(() => expect(callsOf(api, 'analysis:acceptProposal')).toHaveLength(1));
  await waitFor(() => expect(callsOf(api, 'files:list').length).toBeGreaterThan(lists));
});

it('without a configured provider the analysis entries are disabled with the reason', async () => {
  const user = userEvent.setup();
  const { c1 } = files();
  install([c1], analysisHandlers(null));
  renderWithProvider();
  await screen.findByText('c1.png');
  const reason = JOB_ERROR_MESSAGES.provider_not_configured;
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Analyse all' }) as HTMLButtonElement).title).toBe(reason),
  );
  expect((screen.getByRole('button', { name: 'Analyse all' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(tile('c1.png'));
  const analyse = screen.getByRole('button', { name: 'Analyse' }) as HTMLButtonElement;
  expect([analyse.disabled, analyse.title]).toEqual([true, reason]);
  await openMenu(user, 'c1.png');
  const item = screen.getByRole('menuitem', { name: 'Analyse' });
  expect(item.getAttribute('aria-disabled')).toBe('true');
  expect(item.title).toBe(reason);
});

const JOBS_IDLE: JobSummary = {
  queued: 1,
  running: 0,
  waiting: 0,
  failed: 0,
  cancelled: 0,
  succeeded: 0,
  changes: 1,
  paused: [],
  pausedHosts: [],
};

/** The inbox under a job provider; `change(p)` makes the next poll move and answer `p` from `changes:since`. */
function withJobs(files: FileRecord[]) {
  let summary = JOBS_IDLE;
  let changes = noChanges();
  const api = install(files, { 'jobs:summary': () => summary, 'changes:since': () => changes });
  return {
    api,
    async change(p: Partial<Changes>) {
      summary = { ...summary, changes: summary.changes + 1 };
      changes = noChanges(p);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
      });
      changes = noChanges();
    },
  };
}

it('a file a job added to the inbox refreshes the list and the count in place, keeping the scroll position', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const items = Array.from({ length: 200 }, (_, i) => fileRecord({ originalName: `File ${i}.png` }));
    const jobs = withJobs(items);
    render(
      <JobsProvider>
        <Harness />
      </JobsProvider>,
    );
    await screen.findByText('File 0.png');
    const grid = screen.getByRole('listbox', { name: 'Files' });
    Object.defineProperty(grid, 'scrollTop', { configurable: true, value: 4800 });
    fireEvent.scroll(grid);
    await waitFor(() =>
      expect(callsOf(jobs.api, 'files:list')).toContainEqual({ limit: 60, offset: 60, scope: { kind: 'inbox' } }),
    );

    // A poll without a change reloads nothing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    jobs.api.calls.length = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    expect(callsOf(jobs.api, 'files:list')).toEqual([]);

    // A file added to an asset is not the inbox's business.
    await jobs.change({ added: [{ assetId: OAK.id }], jobIds: ['00000000-0000-4000-8000-000000000001'] });
    expect(callsOf(jobs.api, 'files:list')).toEqual([]);

    await jobs.change({ added: [{ assetId: null }] });
    await waitFor(() =>
      expect(callsOf(jobs.api, 'files:list')).toContainEqual({ limit: 60, offset: 60, scope: { kind: 'inbox' } }),
    );
    // The title count reloads as well.
    expect(callsOf(jobs.api, 'files:list')).toContainEqual({ limit: 1, offset: 0, scope: { kind: 'inbox' } });
    // Refreshed in place: the same view, still where it was, without placeholders.
    expect(screen.getByRole('listbox', { name: 'Files' })).toBe(grid);
    expect(grid.scrollTop).toBe(4800);
    expect(screen.queryByText('File 0.png')).toBeNull();
    expect(screen.getByText('File 100.png')).toBeTruthy();
    expect(grid.querySelector('[aria-busy="true"]')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('a changed record of the feed reaches the open detail dialog', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const c1 = fileRecord({ originalName: 'c1.png' });
    const c2 = fileRecord({ originalName: 'c2.png' });
    const jobs = withJobs([c1, c2]);
    render(
      <JobsProvider>
        <Harness />
      </JobsProvider>,
    );
    await screen.findByText('c1.png');
    await user.click(tile('c1.png'));
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'c1.png' });
    expect(within(dialog).queryByText('Moss')).toBeNull();

    jobs.api.set(
      'files:list',
      listOf(() => [{ ...c1, tags: [tagOf('Moss', 'ai')] }, c2]),
    );
    jobs.api.calls.length = 0;
    await jobs.change({ fileIds: [c1.id] });
    expect(await within(dialog).findByText('Moss')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'c1.png' })).toBe(dialog);
    // One read of the changed record; the count is not read again.
    expect(callsOf(jobs.api, 'files:list')).toEqual([{ scope: { kind: 'inbox' }, ids: [c1.id], offset: 0, limit: 1 }]);
  } finally {
    vi.useRealTimers();
  }
});

/** The inbox whose `files:trashMany` removes the requested files from the served list. */
function installTrashable(initial: FileRecord[], handlers: FakeHandlers = {}) {
  let items = initial;
  const api = install(initial, handlers);
  api.set('files:trashMany', (r) => {
    items = items.filter((f) => !r.fileIds.includes(f.id));
    api.setFiles(items);
    return { items: r.fileIds.map((fileId) => ({ fileId, file: null, error: null })) };
  });
  return api;
}

it('the selection bar offers Delete', async () => {
  const user = userEvent.setup();
  const { c1, c2, f1 } = files();
  const api = installTrashable([c1, c2, f1]);
  render(<Harness />);
  await selectRange(user, 'c2.png', 'f1.png');
  const bar = screen.getByText('2 selected').parentElement!;
  const button = within(bar).getByRole('button', { name: 'Delete' });
  expect(button.getAttribute('title')).toBe('Moves the files to the trash');
  const labels = within(bar)
    .getAllByRole('button')
    .map((b) => b.textContent);
  expect(labels.slice(-2)).toEqual(['Delete', 'Clear selection']);
  await user.click(button);
  // The failed file is sent too.
  expect(callsOf(api, 'files:trashMany')).toEqual([{ fileIds: [c2.id, f1.id] }]);
  await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull());
  await waitFor(() => expect(within(screen.getByRole('listbox', { name: 'Files' })).queryByText('c2.png')).toBeNull());
  expect(screen.getByText('c1.png')).toBeTruthy();
});

it('deleting a failed file from its menu removes it', async () => {
  const user = userEvent.setup();
  const { c1, f1 } = files();
  const api = installTrashable([c1, f1]);
  render(<Harness />);
  await screen.findByText('f1.png');
  await user.click(within(tile('f1.png')).getByRole('button', { name: 'File actions' }));
  expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Details', 'Delete']);
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  await waitFor(() => expect(screen.queryByText('f1.png')).toBeNull());
  expect(callsOf(api, 'files:trashMany')).toEqual([{ fileIds: [f1.id] }]);
});

it.each([
  ['succeeds', false],
  ['fails', true],
])('the selection Delete is disabled while a single delete runs and enabled once it %s', async (_, failing) => {
  const user = userEvent.setup();
  const { c1, c2, f1 } = files();
  const api = install([c1, c2, f1]);
  const pending = deferred<{ items: { fileId: string; file: null; error: null }[] }>();
  api.set('files:trashMany', () => pending.promise);
  render(<Harness />);
  await selectRange(user, 'c1.png', 'c2.png');
  const selectionDelete = () =>
    within(screen.getByText('2 selected').parentElement!).getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
  expect(selectionDelete().disabled).toBe(false);
  await user.click(within(tile('f1.png')).getByRole('button', { name: 'File actions' }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  await waitFor(() => expect(selectionDelete().disabled).toBe(true));
  expect(callsOf(api, 'files:trashMany')).toEqual([{ fileIds: [f1.id] }]);
  await act(async () =>
    failing
      ? pending.reject(new Error('boom'))
      : pending.resolve({ items: [{ fileId: f1.id, file: null, error: null }] }),
  );
  await waitFor(() => expect(selectionDelete().disabled).toBe(false));
  expect(callsOf(api, 'files:trashMany')).toEqual([{ fileIds: [f1.id] }]);
});

it('the tile menu Delete is disabled while the selection Delete runs', async () => {
  const user = userEvent.setup();
  const { c1, c2, f1 } = files();
  const api = install([c1, c2, f1]);
  const pending = deferred<{ items: { fileId: string; file: null; error: null }[] }>();
  api.set('files:trashMany', () => pending.promise);
  render(<Harness />);
  await selectRange(user, 'c1.png', 'c2.png');
  const bar = screen.getByText('2 selected').parentElement!;
  await user.click(within(bar).getByRole('button', { name: 'Delete' }));
  await user.click(within(tile('f1.png')).getByRole('button', { name: 'File actions' }));
  expect(screen.getByRole('menuitem', { name: 'Delete' }).getAttribute('aria-disabled')).toBe('true');
  await user.keyboard('{Escape}');
  await act(async () =>
    pending.resolve({
      items: [
        { fileId: c1.id, file: null, error: null },
        { fileId: c2.id, file: null, error: null },
      ],
    }),
  );
  await user.click(within(tile('f1.png')).getByRole('button', { name: 'File actions' }));
  expect(screen.getByRole('menuitem', { name: 'Delete' }).getAttribute('aria-disabled')).toBeNull();
});

it('the Delete key deletes the selection', async () => {
  const user = userEvent.setup();
  const { c1, c2, f1 } = files();
  const api = installTrashable([c1, c2, f1], { 'trash:summary': () => ({ count: 0 }) });
  render(
    <TrashProvider>
      <Harness />
    </TrashProvider>,
  );
  await selectRange(user, 'c1.png', 'c2.png');
  await waitFor(() => expect(callsOf(api, 'trash:summary')).toHaveLength(1));
  await user.keyboard('{Delete}');
  await waitFor(() => expect(callsOf(api, 'files:trashMany')).toEqual([{ fileIds: [c1.id, c2.id] }]));
  await waitFor(() => expect(screen.queryByText('c1.png')).toBeNull());
  expect(screen.queryByText('c2.png')).toBeNull();
  // The trash count is loaded again after the delete.
  await waitFor(() => expect(callsOf(api, 'trash:summary')).toHaveLength(2));
});

it('a fully successful delete clears the strip of an earlier partly failed one', async () => {
  const user = userEvent.setup();
  const { c1, c2 } = files();
  const api = installTrashable([c1, c2]);
  let locked = true;
  let items = [c1, c2];
  api.set('files:trashMany', (r) => {
    const failing = locked ? [c2.id] : [];
    items = items.filter((f) => !r.fileIds.includes(f.id) || failing.includes(f.id));
    api.setFiles(items);
    return {
      items: r.fileIds.map((fileId) =>
        failing.includes(fileId)
          ? { fileId, file: null, error: { code: 'invalid_operation' as const, message: 'The file is locked' } }
          : { fileId, file: null, error: null },
      ),
    };
  });
  render(<Harness />);
  await selectRange(user, 'c1.png', 'c2.png');
  const bar = () => screen.getByText(/selected$/).parentElement!;
  await user.click(within(bar()).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByText('1 deleted, 1 failed')).toBeTruthy();
  await waitFor(() => expect(screen.getByText('1 selected')).toBeTruthy());

  locked = false;
  await user.click(within(bar()).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.queryByText('1 selected')).toBeNull());
  expect(screen.queryByText('1 deleted, 1 failed')).toBeNull();
});

it('the inbox count reloads after a delete', async () => {
  const user = userEvent.setup();
  const { c1, c2 } = files();
  installTrashable([c1, c2]);
  render(<Harness />);
  const title = () => screen.getByRole('heading', { level: 2, name: /Inbox/ }).textContent;
  await waitFor(() => expect(title()).toBe('Inbox2'));
  await screen.findByText('c1.png');
  await user.click(within(tile('c1.png')).getByRole('button', { name: 'File actions' }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  await waitFor(() => expect(title()).toBe('Inbox1'));
});

it('a merge rewrites the selection at once, also a selected file outside the loaded pages', async () => {
  const user = userEvent.setup();
  const f1 = fileRecord({ originalName: 'f1.png', tags: [tagOf('Front View', 'ai'), tagOf('Front')] });
  const f2 = fileRecord({ originalName: 'f2.png', tags: [tagOf('Front View')] });
  const rename = renameHandlers({ 'front view': 'Front View', front: 'Front' });
  let held: Promise<IpcResponse<'files:list'>> | null = null;
  const api = install([f1, f2], {
    ...rename,
    'files:list': (request) => {
      if (held !== null) return held;
      const items = [f1, f2].filter((f) => request.query === undefined || f.originalName.startsWith(request.query));
      return pageOf(items.slice(request.offset, request.offset + request.limit), items.length);
    },
    'tags:rename': (request) => {
      held = deferred<IpcResponse<'files:list'>>().promise;
      return rename['tags:rename'](request);
    },
  });
  render(
    <TagsProvider>
      <Harness />
    </TagsProvider>,
  );
  await selectRange(user, 'f1.png', 'f2.png');
  expect(await screen.findByText('2 selected')).toBeTruthy();
  // f2 leaves the loaded pages and stays selected.
  await user.type(screen.getByRole('searchbox', { name: 'Search files' }), 'f1');
  await waitFor(() => expect(within(screen.getByRole('listbox', { name: 'Files' })).queryByText('f2.png')).toBeNull());
  expect(screen.getByText('2 selected')).toBeTruthy();
  const row = within(column()).getByRole('group', { name: 'Shared image tags' });
  expect(
    within(row)
      .getAllByRole('button', { name: /^Remove/ })
      .map((b) => b.getAttribute('aria-label')),
  ).toEqual(['Remove AI tag Front View']);

  const before = callsOf(api, 'files:list').length;
  await renameThroughDialog(user, 'Front View', 'front');
  expect(callsOf(api, 'tags:rename')).toEqual([{ from: 'front view', to: 'front', merge: true }]);
  // The list reload is requested and still unanswered; the selection already shows the merge.
  await waitFor(() => expect(callsOf(api, 'files:list').length).toBeGreaterThan(before));
  await waitFor(() =>
    expect(
      within(row)
        .getAllByRole('button', { name: /^Remove/ })
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Remove Front']),
  );
});

it('Import from URLs follows Import files, is disabled while importing and sends no target', async () => {
  const user = userEvent.setup();
  const picked = deferred<string[]>();
  const api = install([], {
    'dialog:pickFiles': () => picked.promise,
    'files:importUrls': () => ({ queued: 1, alreadyImported: 0, alreadyQueued: 0, invalid: [] }),
  });
  render(<Harness />);
  await screen.findByText('Inbox is empty');
  const urlButton = screen.getByRole('button', { name: 'Import from URLs' }) as HTMLButtonElement;
  expect(urlButton.previousElementSibling?.textContent).toBe('Import files');
  expect(urlButton.className).toBe(screen.getAllByRole('button', { name: 'Import files' })[0]!.className);

  await user.click(screen.getAllByRole('button', { name: 'Import files' })[0]!);
  expect(urlButton.disabled).toBe(true);
  picked.resolve([]);
  await waitFor(() => expect(urlButton.disabled).toBe(false));

  await user.click(urlButton);
  const dialog = await screen.findByRole('dialog', { name: 'Import from URLs' });
  await user.click(within(dialog).getByRole('textbox', { name: 'URLs' }));
  await user.paste('https://a.test/x.png');
  await user.click(within(dialog).getByRole('button', { name: 'Import' }));
  expect(await within(dialog).findByText('Queued 1')).toBeTruthy();
  expect(callsOf(api, 'files:importUrls')).toEqual([{ urls: ['https://a.test/x.png'], skipDuplicates: true }]);
  await user.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('Import from site follows Import from URLs, is disabled while importing and imports without a target', async () => {
  const user = userEvent.setup();
  const picked = deferred<string[]>();
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
  const api = install([], {
    'dialog:pickFiles': () => picked.promise,
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
  render(<Harness />);
  await screen.findByText('Inbox is empty');
  const siteButton = screen.getByRole('button', { name: 'Import from site' }) as HTMLButtonElement;
  expect(siteButton.previousElementSibling?.textContent).toBe('Import from URLs');
  expect(siteButton.className).toBe(screen.getAllByRole('button', { name: 'Import files' })[0]!.className);

  await user.click(screen.getAllByRole('button', { name: 'Import files' })[0]!);
  expect(siteButton.disabled).toBe(true);
  picked.resolve([]);
  await waitFor(() => expect(siteButton.disabled).toBe(false));

  await user.click(siteButton);
  const dialog = await screen.findByRole('dialog', { name: 'Import from site' });
  await waitFor(() =>
    expect((within(dialog).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Shop'),
  );
  await user.type(within(dialog).getByRole('textbox', { name: 'Gallery URL' }), 'https://example.com/g');
  await user.click(within(dialog).getByRole('button', { name: 'Test' }));
  await within(dialog).findByRole('list', { name: 'Found files' });
  await user.click(within(dialog).getByRole('button', { name: 'Import' }));
  expect(await within(dialog).findByText('Queued 1')).toBeTruthy();
  expect(callsOf(api, 'sites:import')).toEqual([{ crawlId, target: null }]);
  await user.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('a running import shows its progress, reloads the list while done changes and keeps selection and scroll; a cancel ends the title', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const items = Array.from({ length: 200 }, (_, i) => fileRecord({ originalName: `File ${i}.png` }));
    const a = fileRecord({ originalName: 'a.png' });
    const running = deferred<IpcResponse<'files:import'>>();
    let progress: IpcResponse<'files:importProgress'> = null;
    const api = install(items, {
      'dialog:pickFiles': () => ['C:\\in\\a.png', 'C:\\in\\b.png'],
      'files:import': () => running.promise,
      'files:importProgress': () => progress,
      'files:cancelImport': () => {
        if (progress !== null) progress = { ...progress, cancelling: true };
        return { cancelling: true };
      },
    });
    render(<Harness />);
    await user.click(await screen.findByText('File 0.png'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    const grid = screen.getByRole('listbox', { name: 'Files' });
    Object.defineProperty(grid, 'scrollTop', { configurable: true, value: 4800 });
    fireEvent.scroll(grid);
    await waitFor(() =>
      expect(callsOf(api, 'files:list')).toContainEqual({ limit: 60, offset: 60, scope: { kind: 'inbox' } }),
    );

    await user.click(screen.getAllByRole('button', { name: 'Import files' })[0]!);
    // No progress known yet: the plain busy text.
    await waitFor(() => expect(callsOf(api, 'files:import')).toHaveLength(1));
    expect(screen.getByText('Importing…')).toBeTruthy();

    progress = { done: 0, total: 2, currentBytes: 5, currentSize: 10, cancelling: false };
    expect(await screen.findByText('0 of 2')).toBeTruthy();
    expect(screen.queryByText('Importing…')).toBeNull();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');

    // done moves: the list reloads where it was, the selection stays.
    api.calls.length = 0;
    api.setFiles([a, ...items]);
    progress = { done: 1, total: 2, currentBytes: 0, currentSize: null, cancelling: false };
    expect(await screen.findByText('1 of 2')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await waitFor(() =>
      expect(callsOf(api, 'files:list')).toContainEqual({ limit: 60, offset: 60, scope: { kind: 'inbox' } }),
    );
    await waitFor(() => expect(screen.getByRole('listbox', { name: 'Files' })).not.toBe(grid));
    const list = within(screen.getByRole('listbox', { name: 'Files' }));
    expect(list.queryByText('File 0.png')).toBeNull();
    expect(list.getByText('File 100.png')).toBeTruthy();
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(screen.getByText('1 of 2')).toBeTruthy();

    // done unchanged: no further reload.
    api.calls.length = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(callsOf(api, 'files:list').filter((r) => (r as ListRequest).limit === 60)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(callsOf(api, 'files:cancelImport')).toEqual([{}]);
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true),
    );

    progress = null;
    running.resolve([importResultOf('C:\\in\\a.png', { file: a })]);
    expect(await screen.findByText('1 imported, 0 failed, 0 duplicates, cancelled')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText('Importing…')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('the next import after a cancelled one has no cancelled title', async () => {
  const user = userEvent.setup();
  const a = fileRecord({ originalName: 'a.png' });
  const running = deferred<IpcResponse<'files:import'>>();
  let first = true;
  const api = install([], {
    'dialog:pickFiles': () => ['C:\\in\\a.png'],
    'files:import': () => (first ? running.promise : [importResultOf('C:\\in\\a.png', { file: a })]),
    'files:importProgress': () => ({ done: 0, total: 1, currentBytes: 0, currentSize: null, cancelling: false }),
    'files:cancelImport': () => ({ cancelling: true }),
  });
  render(<Harness />);
  await screen.findByText('Inbox is empty');
  await user.click(screen.getAllByRole('button', { name: 'Import files' })[0]!);
  await user.click(await screen.findByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(callsOf(api, 'files:cancelImport')).toHaveLength(1));
  first = false;
  running.resolve([]);
  expect(await screen.findByText('0 imported, 0 failed, 0 duplicates, cancelled')).toBeTruthy();

  await user.click(screen.getAllByRole('button', { name: 'Import files' })[0]!);
  expect(await screen.findByText('1 imported, 0 failed, 0 duplicates')).toBeTruthy();
});
