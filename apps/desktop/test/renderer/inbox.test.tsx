import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { FileRecord, IpcRequest } from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { NONE_ANALYSABLE } from '../../src/renderer/src/analysis';
import { NO_FILE_FILTERS, type InboxListState } from '../../src/renderer/src/list-state';
import { InboxScreen } from '../../src/renderer/src/screens/InboxScreen';
import { deferred, fakeError, installFakeApi, type FakeHandlers } from './fake-api';
import { assetSummary, fileRecord, nonImageRecord, pageOf, tagOf } from './fixtures';
import { act } from '@testing-library/react';
import type { JobSummary } from '@assetforge/contracts';
import { JOB_POLL_MS, JobsProvider } from '../../src/renderer/src/jobs-context';

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

it('the tile menu analyses a complete image and shows the outcome', async () => {
  const user = userEvent.setup();
  const { c1 } = files();
  const blend = nonImageRecord('tree.blend');
  const api = install([c1, blend], { 'analysis:enqueue': (r) => ({ enqueued: r.fileIds.length, skipped: [] }) });
  render(<Harness />);
  await screen.findByText('tree.blend');
  await user.click(within(tile('tree.blend')).getByRole('button', { name: 'File actions' }));
  expect(screen.queryByRole('menuitem', { name: 'Analyse' })).toBeNull();
  await user.keyboard('{Escape}');
  await user.click(within(tile('c1.png')).getByRole('button', { name: 'File actions' }));
  await user.click(screen.getByRole('menuitem', { name: 'Analyse' }));
  expect((await screen.findByRole('status')).textContent).toContain('1 queued, 0 skipped');
  expect(callsOf(api, 'analysis:enqueue')).toEqual([{ fileIds: [c1.id] }]);
});

it('the detail dialog analyses the shown image', async () => {
  const user = userEvent.setup();
  const { c1 } = files();
  const api = install([c1], { 'analysis:enqueue': (r) => ({ enqueued: r.fileIds.length, skipped: [] }) });
  render(<Harness />);
  await screen.findByText('c1.png');
  await user.click(tile('c1.png'));
  await user.keyboard('{Enter}');
  const dialog = await screen.findByRole('dialog', { name: 'c1.png' });
  await user.click(within(dialog).getByRole('button', { name: 'More' }));
  await user.click(screen.getByRole('menuitem', { name: 'Analyse' }));
  await waitFor(() => expect(callsOf(api, 'analysis:enqueue')).toEqual([{ fileIds: [c1.id] }]));
});

it('Analyse in the selection bar sends only the images and lists the skipped ones; the selection is kept', async () => {
  const user = userEvent.setup();
  const { c1, c2 } = files();
  const doc = nonImageRecord('notes.pdf');
  const api = install([c1, c2, doc], {
    'analysis:enqueue': () => ({ enqueued: 1, skipped: [{ fileId: c2.id, reason: 'already_queued' }] }),
  });
  render(<Harness />);
  await selectRange(user, 'c1.png', 'notes.pdf');
  await user.click(screen.getByRole('button', { name: 'Analyse' }));
  const strip = await screen.findByRole('alert');
  expect(within(strip).getByText('1 queued, 1 skipped')).toBeTruthy();
  expect(strip.textContent).toContain('c2.png: Already queued');
  expect(callsOf(api, 'analysis:enqueue')).toEqual([{ fileIds: [c1.id, c2.id] }]);
  expect(screen.getByText('3 selected')).toBeTruthy();
});

it('Analyse is disabled for a selection without images, and a rejected call shows the alert', async () => {
  const user = userEvent.setup();
  const { c1 } = files();
  const doc = nonImageRecord('notes.pdf');
  install([doc, c1], {
    'analysis:enqueue': () => {
      throw fakeError('not_found');
    },
  });
  render(<Harness />);
  await screen.findByText('notes.pdf');
  await user.click(tile('notes.pdf'));
  const analyse = screen.getByRole('button', { name: 'Analyse' }) as HTMLButtonElement;
  expect(analyse.disabled).toBe(true);
  expect(analyse.title).toBe(NONE_ANALYSABLE);

  await user.click(tile('c1.png'));
  expect(analyse.disabled).toBe(false);
  await user.click(analyse);
  expect((await screen.findByRole('alert')).textContent).toBe('This item no longer exists.');
  expect(screen.getByText('1 selected')).toBeTruthy();
});

const JOBS_IDLE: JobSummary = { queued: 1, running: 0, waiting: 0, failed: 0, cancelled: 0, succeeded: 0, changes: 1 };

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
