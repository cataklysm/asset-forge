import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { JOB_ERROR_MESSAGES, type FileRecord, type IpcRequest, type JobSummary, type VisionSettingsView } from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { NONE_ANALYSABLE } from '../../src/renderer/src/analysis';
import { ANALYSE_SELECTION_TITLE, ANALYSE_TITLE } from '../../src/renderer/src/labels';
import { OpenSettingsProvider } from '../../src/renderer/src/components/AnalysisDialogs';
import { JOB_POLL_MS, JobsProvider } from '../../src/renderer/src/jobs-context';
import { ProviderSettingsProvider } from '../../src/renderer/src/provider-context';
import { AnalysisPromptsProvider } from '../../src/renderer/src/analysis-prompts-context';
import { NO_FILE_FILTERS, type InboxListState } from '../../src/renderer/src/list-state';
import { InboxScreen } from '../../src/renderer/src/screens/InboxScreen';
import { TrashProvider } from '../../src/renderer/src/trash-context';
import { deferred, fakeError, installFakeApi, type FakeHandlers } from './fake-api';
import { assetSummary, fileRecord, NONE_SKIPPED, nonImageRecord, pageOf, tagOf } from './fixtures';

const INITIAL: InboxListState = { filters: NO_FILE_FILTERS, scrollOffset: 0 };
const OAK = assetSummary({ name: 'Oak' });

type ListRequest = IpcRequest<'files:list'>;

/** Serves the files that `current()` returns, page by page. */
function listOf(current: () => FileRecord[]) {
  return (request: ListRequest) => {
    const items = current();
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
  const element = within(screen.getByRole('listbox', { name: 'Files' })).getByText(name).closest<HTMLElement>('[data-index]');
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
  const f1 = fileRecord({ originalName: 'f1.png', status: 'failed', sha256: null, error: 'The checksum did not match' });
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
      items: r.fileIds.map((fileId) => ({ fileId, file: { ...(fileId === c1.id ? c1 : c2), assetId: OAK.id, role: r.role }, error: null })),
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
        { sourcePath: 'C:\\in\\a.png', file: a, error: null, duplicateOf: [] },
        { sourcePath: 'C:\\in\\b.png', file: b, error: null, duplicateOf: [a.id] },
        { sourcePath: 'C:\\in\\c.exe', file: null, error: 'This file type cannot be imported', duplicateOf: [] },
      ];
    },
  });
  const onBusyChange = vi.fn();
  render(<Harness onBusyChange={onBusyChange} />);
  await screen.findByText('Inbox is empty');
  await user.click(screen.getAllByRole('button', { name: 'Import files' })[0]!);
  expect(screen.getByText('Importing…')).toBeTruthy();
  expect(onBusyChange).toHaveBeenLastCalledWith(true);
  picked.resolve(['C:\\in\\a.png', 'C:\\in\\b.png', 'C:\\in\\c.exe']);

  const strip = await screen.findByRole('alert');
  expect(within(strip).getByText('2 imported, 1 failed, 1 duplicates')).toBeTruthy();
  expect(strip.textContent).toContain('c.exe');
  expect(strip.textContent).toContain('This file type cannot be imported');
  expect(strip.textContent).not.toContain('C:\\in');
  expect(callsOf(api, 'files:import')).toEqual([{ sourcePaths: ['C:\\in\\a.png', 'C:\\in\\b.png', 'C:\\in\\c.exe'] }]);
  expect(await screen.findByText('a.png')).toBeTruthy();
  await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: /Inbox/ }).textContent).toBe('Inbox2'));
  await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
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

const VISION: VisionSettingsView = {
  baseUrl: 'http://127.0.0.1:11500',
  timeoutSeconds: 120,
  taggingModel: 'vision-a',
  promptModel: 'vision-a',
  hasApiKey: false,
  fromEnvironment: false,
  canStoreKey: true,
};
const NO_JOBS: JobSummary = { queued: 0, running: 0, waiting: 0, failed: 0, cancelled: 0, succeeded: 0, changes: 0, paused: null };

/** The provider, job and analysis channels the dialogs use; `settings` decides whether a provider is configured. */
function analysisHandlers(settings: VisionSettingsView = VISION): FakeHandlers {
  return {
    'settings:getVision': () => settings,
    'settings:listVisionModels': () => ({ ok: true, models: [{ name: 'vision-a', vision: true }] }),
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
  install([proposed], analysisHandlers({ ...VISION, baseUrl: null, taggingModel: null, promptModel: null }));
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
  await waitFor(() => expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false));
  const target = { kind: 'files', fileIds: [c1.id, c2.id, doc.id] };
  expect(callsOf(api, 'analysis:preview')).toEqual([{ target, model: 'vision-a' }]);
  await user.click(screen.getByRole('button', { name: 'Start' }));
  const strip = await screen.findByRole('status');
  expect(within(strip).getByText('1 queued, 1 already queued')).toBeTruthy();
  expect(callsOf(api, 'analysis:enqueue')).toEqual([
    { target, model: 'vision-a', mode: 'apply', force: false, promptId: expect.any(String) },
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
  expect(callsOf(api, 'analysis:preview')[0]).toEqual({ target: { kind: 'files', fileIds: [c1.id, doc.id] }, model: 'vision-a' });
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
  expect(within(tile('proposed.png')).getByRole('img', { name: 'Tag proposal' }).title).toBe('Tag proposal waiting for review');
  expect(within(tile('plain.png')).queryByRole('img', { name: 'Tag proposal' })).toBeNull();

  const toggle = screen.getByRole('button', { name: 'Proposals' });
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  await user.click(toggle);
  await waitFor(() => expect(within(screen.getByRole('listbox', { name: 'Files' })).queryByText('plain.png')).toBeNull());
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
      proposal: { model: 'vision-a', promptName: null, createdAt: '2026-01-01T00:00:00.000Z', stale: false, tags: [{ name: 'oak', displayName: 'Oak' }] },
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
  install([c1], analysisHandlers({ ...VISION, baseUrl: null }));
  renderWithProvider();
  await screen.findByText('c1.png');
  const reason = JOB_ERROR_MESSAGES.provider_not_configured;
  await waitFor(() => expect((screen.getByRole('button', { name: 'Analyse all' }) as HTMLButtonElement).title).toBe(reason));
  expect((screen.getByRole('button', { name: 'Analyse all' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(tile('c1.png'));
  const analyse = screen.getByRole('button', { name: 'Analyse' }) as HTMLButtonElement;
  expect([analyse.disabled, analyse.title]).toEqual([true, reason]);
  await openMenu(user, 'c1.png');
  const item = screen.getByRole('menuitem', { name: 'Analyse' });
  expect(item.getAttribute('aria-disabled')).toBe('true');
  expect(item.title).toBe(reason);
});

const JOBS_IDLE: JobSummary = { queued: 1, running: 0, waiting: 0, failed: 0, cancelled: 0, succeeded: 0, changes: 1, paused: null };

/** The inbox under a job provider; `succeed()` makes the next poll report a finished job. */
function withJobs(files: FileRecord[]) {
  let summary = JOBS_IDLE;
  const api = install(files, { 'jobs:summary': () => summary });
  return {
    api,
    async succeed() {
      summary = { ...summary, queued: summary.queued - 1, succeeded: summary.succeeded + 1, changes: summary.changes + 1 };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
      });
    },
  };
}

it('a poll with risen succeeded reloads the inbox and keeps the scroll position', async () => {
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
    await waitFor(() => expect(callsOf(jobs.api, 'files:list')).toContainEqual({ limit: 60, offset: 60, scope: { kind: 'inbox' } }));

    // A poll without a result reloads nothing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    jobs.api.calls.length = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    expect(callsOf(jobs.api, 'files:list')).toEqual([]);

    await jobs.succeed();
    await waitFor(() => expect(callsOf(jobs.api, 'files:list')).toContainEqual({ limit: 60, offset: 60, scope: { kind: 'inbox' } }));
    // The title count reloads as well.
    expect(callsOf(jobs.api, 'files:list')).toContainEqual({ limit: 1, offset: 0, scope: { kind: 'inbox' } });
    // The reloaded view starts where the old one was, not at the top.
    await waitFor(() => expect(screen.getByRole('listbox', { name: 'Files' })).not.toBe(grid));
    expect(screen.queryByText('File 0.png')).toBeNull();
    expect(screen.getByText('File 100.png')).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

it('a poll with risen succeeded shows the fresh record in the open detail dialog', async () => {
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

    jobs.api.set('files:list', listOf(() => [{ ...c1, tags: [tagOf('Moss', 'ai')] }, c2]));
    await jobs.succeed();
    expect(await within(dialog).findByText('Moss')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'c1.png' })).toBe(dialog);
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
