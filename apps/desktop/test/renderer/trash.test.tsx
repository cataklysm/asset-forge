import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { FileRecord, IpcRequest } from '@assetforge/contracts';
import { expect, it } from 'vitest';
import { NO_FILE_FILTERS } from '../../src/renderer/src/list-state';
import { TrashScreen, type TrashListState } from '../../src/renderer/src/screens/TrashScreen';
import { TrashProvider } from '../../src/renderer/src/trash-context';
import { installFakeApi, type FakeHandlers } from './fake-api';
import { nextId, pageOf, tagOf, trashedRecord } from './fixtures';

const INITIAL: TrashListState = { filters: NO_FILE_FILTERS, scrollOffset: 0 };

type ListRequest = IpcRequest<'files:list'>;

function files() {
  return {
    hero: trashedRecord({
      originalName: 'hero.png',
      trashedAssetId: nextId(),
      trashedAssetName: 'Hero',
      trashedRole: 'texture',
      tags: [tagOf('Bark')],
    }),
    loose: trashedRecord({ originalName: 'loose.png' }),
    third: trashedRecord({ originalName: 'third.png' }),
  };
}

/**
 * The trash whose restore, purge and empty remove the files from the served list. `failing` names
 * files whose items answer with an error instead.
 */
function install(initial: FileRecord[], options: { failing?: string[]; handlers?: FakeHandlers } = {}) {
  let items = initial;
  const failing = new Set(options.failing ?? []);
  const batch = (r: { fileIds: string[] }) => {
    const done = r.fileIds.filter((id) => !failing.has(id));
    items = items.filter((f) => !done.includes(f.id));
    return {
      items: r.fileIds.map((fileId) =>
        failing.has(fileId)
          ? { fileId, file: null, error: { code: 'invalid_operation' as const, message: 'The file is locked' } }
          : { fileId, file: null, error: null },
      ),
    };
  };
  const api = installFakeApi({
    'files:list': (r: ListRequest) => pageOf(items.slice(r.offset, r.offset + r.limit), items.length),
    'tags:suggest': () => [],
    'files:restoreMany': batch,
    'files:purgeMany': batch,
    'trash:empty': () => {
      const purged = items.length;
      items = [];
      return { purged, failed: 0 };
    },
    ...options.handlers,
  });
  return api;
}

function callsOf(api: ReturnType<typeof install>, channel: string) {
  return api.calls.filter((c) => c.channel === channel).map((c) => c.request);
}

function Harness(props: { onState?(s: TrashListState): void }) {
  const [state, setState] = useState(INITIAL);
  return (
    <div className="flex h-[800px] flex-col">
      <TrashScreen
        state={state}
        onStateChange={(next) => {
          props.onState?.(next);
          setState(next);
        }}
      />
    </div>
  );
}

function tile(name: string): HTMLElement {
  const element = within(screen.getByRole('listbox', { name: 'Files' })).getByText(name).closest<HTMLElement>('[data-index]');
  if (element === null) throw new Error(`no tile for ${name}`);
  return element;
}

const title = () => screen.getByRole('heading', { level: 2, name: /Trash/ }).textContent;

async function selectTwo(user: ReturnType<typeof userEvent.setup>, first: string, last: string) {
  await screen.findByText(first);
  await user.click(tile(first));
  fireEvent.click(tile(last), { shiftKey: true });
  await screen.findByText('2 selected');
}

function bar(): HTMLElement {
  return screen.getByText('2 selected').parentElement!;
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await screen.findByText(name);
  await user.click(within(tile(name)).getByRole('button', { name: 'File actions' }));
}

it('lists the trash with its count', async () => {
  const { hero, loose } = files();
  const api = install([hero, loose]);
  render(<Harness />);
  await waitFor(() => expect(title()).toBe('Trash2'));
  expect(screen.getByText('hero.png')).toBeTruthy();
  expect(screen.getByText('loose.png')).toBeTruthy();
  const requests = callsOf(api, 'files:list') as ListRequest[];
  expect(requests.every((r) => r.scope.kind === 'trash')).toBe(true);
});

it('Restore from the menu calls files:restoreMany without asking and reloads', async () => {
  const user = userEvent.setup();
  const { hero, loose } = files();
  const api = install([hero, loose]);
  render(<Harness />);
  await openMenu(user, 'hero.png');
  expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Details', 'Restore', 'Delete permanently']);
  await user.click(screen.getByRole('menuitem', { name: 'Restore' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(callsOf(api, 'files:restoreMany')).toEqual([{ fileIds: [hero.id] }]);
  await waitFor(() => expect(screen.queryByText('hero.png')).toBeNull());
  await waitFor(() => expect(title()).toBe('Trash1'));
});

it('Restore for a selection', async () => {
  const user = userEvent.setup();
  const { hero, loose, third } = files();
  const api = install([hero, loose, third]);
  render(<Harness />);
  await selectTwo(user, 'hero.png', 'loose.png');
  const restore = within(bar()).getByRole('button', { name: 'Restore' });
  expect(restore.getAttribute('title')).toBe('Puts the files back where they were');
  await user.click(restore);
  expect(callsOf(api, 'files:restoreMany')).toEqual([{ fileIds: [hero.id, loose.id] }]);
  await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull());
  await waitFor(() => expect(screen.queryByText('hero.png')).toBeNull());
  expect(screen.queryByText('loose.png')).toBeNull();
  expect(screen.getByText('third.png')).toBeTruthy();
});

it('Delete permanently asks with the number of files and purges on confirm', async () => {
  const user = userEvent.setup();
  const { hero, loose, third } = files();
  const api = install([hero, loose, third]);
  render(<Harness />);
  await selectTwo(user, 'hero.png', 'loose.png');
  const purge = within(bar()).getByRole('button', { name: 'Delete permanently' });
  expect(purge.getAttribute('title')).toBe('Removes the files from disk; asks first');
  await user.click(purge);
  const dialog = await screen.findByRole('dialog', { name: 'Delete 2 files permanently?' });
  expect(callsOf(api, 'files:purgeMany')).toEqual([]);
  await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
  await waitFor(() => expect(callsOf(api, 'files:purgeMany')).toEqual([{ fileIds: [hero.id, loose.id] }]));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(screen.queryByText('hero.png')).toBeNull());
  expect(screen.queryByText('2 selected')).toBeNull();
});

it('cancelling the confirmation sends nothing', async () => {
  const user = userEvent.setup();
  const { hero, loose } = files();
  const api = install([hero, loose]);
  render(<Harness />);
  await openMenu(user, 'hero.png');
  await user.click(screen.getByRole('menuitem', { name: 'Delete permanently' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete 1 file permanently?' });
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(callsOf(api, 'files:purgeMany')).toEqual([]);
  expect(screen.getByText('hero.png')).toBeTruthy();
});

it('Empty trash asks with the total and calls trash:empty', async () => {
  const user = userEvent.setup();
  const { hero, loose, third } = files();
  const api = install([hero, loose, third]);
  render(<Harness />);
  await waitFor(() => expect(title()).toBe('Trash3'));
  const empty = screen.getByRole('button', { name: 'Empty trash' });
  expect(empty.getAttribute('title')).toBe('Removes every file in the trash from disk; asks first');
  await user.click(empty);
  const dialog = await screen.findByRole('dialog', { name: 'Delete 3 files permanently?' });
  expect(callsOf(api, 'trash:empty')).toEqual([]);
  await user.click(within(dialog).getByRole('button', { name: 'Empty trash' }));
  await waitFor(() => expect(callsOf(api, 'trash:empty')).toEqual([{}]));
  expect(await screen.findByText('Trash is empty')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('Empty trash reports failures by count only', async () => {
  const user = userEvent.setup();
  const { hero, loose } = files();
  install([hero, loose], { handlers: { 'trash:empty': () => ({ purged: 1, failed: 1 }) } });
  render(<Harness />);
  await waitFor(() => expect(title()).toBe('Trash2'));
  await user.click(screen.getByRole('button', { name: 'Empty trash' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete 2 files permanently?' });
  await user.click(within(dialog).getByRole('button', { name: 'Empty trash' }));
  expect(await screen.findByText('1 deleted, 1 failed')).toBeTruthy();
});

it('Empty trash is disabled for an empty trash', async () => {
  install([]);
  render(<Harness />);
  expect(await screen.findByText('Trash is empty')).toBeTruthy();
  await waitFor(() => expect(title()).toBe('Trash0'));
  expect((screen.getByRole('button', { name: 'Empty trash' }) as HTMLButtonElement).disabled).toBe(true);
});

it('a partly failing purge shows "1 deleted, 1 failed"', async () => {
  const user = userEvent.setup();
  const { hero, loose } = files();
  install([hero, loose], { failing: [loose.id] });
  render(<Harness />);
  await selectTwo(user, 'hero.png', 'loose.png');
  await user.click(within(bar()).getByRole('button', { name: 'Delete permanently' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete 2 files permanently?' });
  await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
  expect(await screen.findByText('1 deleted, 1 failed')).toBeTruthy();
  expect(screen.getByText(/The file is locked/)).toBeTruthy();
  // The failed file stays selected.
  expect(await screen.findByText('1 selected')).toBeTruthy();
});

it('the Delete key on a selection opens the confirmation', async () => {
  const user = userEvent.setup();
  const { hero, loose } = files();
  const api = install([hero, loose]);
  render(<Harness />);
  await selectTwo(user, 'hero.png', 'loose.png');
  await user.keyboard('{Delete}');
  expect(await screen.findByRole('dialog', { name: 'Delete 2 files permanently?' })).toBeTruthy();
  expect(callsOf(api, 'files:purgeMany')).toEqual([]);
});

it('the trash count is refreshed after restore and after purge', async () => {
  const user = userEvent.setup();
  const { hero, loose } = files();
  const api = install([hero, loose], { handlers: { 'trash:summary': () => ({ count: 0 }) } });
  render(
    <TrashProvider>
      <Harness />
    </TrashProvider>,
  );
  await waitFor(() => expect(callsOf(api, 'trash:summary')).toHaveLength(1));
  await openMenu(user, 'hero.png');
  await user.click(screen.getByRole('menuitem', { name: 'Restore' }));
  await waitFor(() => expect(callsOf(api, 'trash:summary')).toHaveLength(2));
  await waitFor(() => expect(screen.queryByText('hero.png')).toBeNull());

  await openMenu(user, 'loose.png');
  await user.click(screen.getByRole('menuitem', { name: 'Delete permanently' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete 1 file permanently?' });
  await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
  await waitFor(() => expect(callsOf(api, 'trash:summary')).toHaveLength(3));
});

it('searching the trash sends the query with scope trash', async () => {
  const user = userEvent.setup();
  const { hero, loose } = files();
  const api = install([hero, loose]);
  render(<Harness />);
  await screen.findByText('hero.png');
  await user.type(screen.getByRole('searchbox', { name: 'Search files' }), 'hero');
  await waitFor(() =>
    expect((callsOf(api, 'files:list') as ListRequest[]).some((r) => r.query === 'hero' && r.scope.kind === 'trash')).toBe(true),
  );
});

it('the detail dialog offers Restore and moves on to the next file', async () => {
  const user = userEvent.setup();
  const { hero, loose } = files();
  const api = install([hero, loose]);
  render(<Harness />);
  await screen.findByText('hero.png');
  await user.click(tile('hero.png'));
  await user.keyboard('{Enter}');
  const dialog = await screen.findByRole('dialog', { name: 'hero.png' });
  await user.click(within(dialog).getByRole('button', { name: 'More' }));
  expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Restore', 'Delete permanently']);
  await user.click(screen.getByRole('menuitem', { name: 'Restore' }));
  expect(await screen.findByRole('dialog', { name: 'loose.png' })).toBeTruthy();
  expect(callsOf(api, 'files:restoreMany')).toEqual([{ fileIds: [hero.id] }]);
});
