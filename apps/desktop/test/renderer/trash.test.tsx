import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { FileRecord, IpcRequest } from '@assetforge/contracts';
import { expect, it } from 'vitest';
import { NO_FILE_FILTERS } from '../../src/renderer/src/list-state';
import { TrashScreen, type TrashListState } from '../../src/renderer/src/screens/TrashScreen';
import { TagsProvider } from '../../src/renderer/src/tags-context';
import { TrashProvider } from '../../src/renderer/src/trash-context';
import { deferred, fakeError, installFakeApi, type FakeHandlers } from './fake-api';
import { nextId, pageOf, tagOf, trashedRecord } from './fixtures';
import { renameHandlers, renameThroughDialog, RenameTrigger } from './rename-flow';

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
  const element = within(screen.getByRole('listbox', { name: 'Files' }))
    .getByText(name)
    .closest<HTMLElement>('[data-index]');
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

it('a trashed file with a tag proposal shows no proposal marker in the grid, the table or the dialog', async () => {
  const user = userEvent.setup();
  const proposed = trashedRecord({ originalName: 'proposed.png', hasProposal: true });
  install([proposed]);
  render(<Harness />);
  await screen.findByText('proposed.png');
  expect(document.querySelector('[data-proposal-marker]')).toBeNull();
  await user.click(tile('proposed.png'));
  await user.keyboard('{Enter}');
  await screen.findByRole('dialog', { name: 'proposed.png' });
  expect(document.querySelector('[data-proposal-marker]')).toBeNull();
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Show as table' }));
  await screen.findByText('proposed.png');
  expect(document.querySelector('[data-proposal-marker]')).toBeNull();
});

it('Restore from the menu calls files:restoreMany without asking and reloads', async () => {
  const user = userEvent.setup();
  const { hero, loose } = files();
  const api = install([hero, loose]);
  render(<Harness />);
  await openMenu(user, 'hero.png');
  expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
    'Details',
    'Restore',
    'Delete permanently',
  ]);
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

it('the Empty trash confirmation follows a count reload that answers while it is open', async () => {
  const user = userEvent.setup();
  const { hero, loose, third } = files();
  let items = [hero, loose, third];
  const held = deferred<void>();
  let holdCount = false;
  install(items, {
    handlers: {
      'files:list': async (r: ListRequest) => {
        // The title's count read after the restore is held back.
        if (holdCount && r.limit === 1) await held.promise;
        return pageOf(items.slice(r.offset, r.offset + r.limit), items.length);
      },
      'files:restoreMany': (r) => {
        items = items.filter((f) => !r.fileIds.includes(f.id));
        return { items: r.fileIds.map((fileId) => ({ fileId, file: null, error: null })) };
      },
    },
  });
  render(<Harness />);
  await waitFor(() => expect(title()).toBe('Trash3'));
  holdCount = true;
  await openMenu(user, 'hero.png');
  await user.click(screen.getByRole('menuitem', { name: 'Restore' }));
  await waitFor(() => expect(screen.queryByText('hero.png')).toBeNull());
  await user.click(screen.getByRole('button', { name: 'Empty trash' }));
  expect(await screen.findByRole('dialog', { name: 'Delete 3 files permanently?' })).toBeTruthy();
  await act(async () => held.resolve());
  expect(await screen.findByRole('dialog', { name: 'Delete 2 files permanently?' })).toBeTruthy();
});

it('the Empty trash confirmation closes when a count reload finds the trash empty', async () => {
  const user = userEvent.setup();
  const { hero } = files();
  let items = [hero];
  const held = deferred<void>();
  let holdCount = false;
  const api = install(items, {
    handlers: {
      'files:list': async (r: ListRequest) => {
        // The title's count read after the restore is held back.
        if (holdCount && r.limit === 1) await held.promise;
        return pageOf(items.slice(r.offset, r.offset + r.limit), items.length);
      },
      'files:restoreMany': (r) => {
        items = items.filter((f) => !r.fileIds.includes(f.id));
        return { items: r.fileIds.map((fileId) => ({ fileId, file: null, error: null })) };
      },
    },
  });
  render(<Harness />);
  await waitFor(() => expect(title()).toBe('Trash1'));
  holdCount = true;
  await openMenu(user, 'hero.png');
  await user.click(screen.getByRole('menuitem', { name: 'Restore' }));
  await waitFor(() => expect(screen.queryByText('hero.png')).toBeNull());
  await user.click(screen.getByRole('button', { name: 'Empty trash' }));
  expect(await screen.findByRole('dialog', { name: 'Delete 1 file permanently?' })).toBeTruthy();
  await act(async () => held.resolve());
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.calls.filter((entry) => entry.channel === 'trash:empty')).toHaveLength(0);
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
    expect(
      (callsOf(api, 'files:list') as ListRequest[]).some((r) => r.query === 'hero' && r.scope.kind === 'trash'),
    ).toBe(true),
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

/** Opens hero.png in the viewer and confirms Delete permanently from its menu. */
async function purgeInDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await screen.findByText('hero.png');
  await user.click(tile('hero.png'));
  await user.keyboard('{Enter}');
  const dialog = await screen.findByRole('dialog', { name: 'hero.png' });
  await user.click(within(dialog).getByRole('button', { name: 'More' }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete permanently' }));
  const confirm = await screen.findByRole('dialog', { name: 'Delete 1 file permanently?' });
  await user.click(within(confirm).getByRole('button', { name: 'Delete permanently' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete 1 file permanently?' })).toBeNull());
  return dialog;
}

it('a failing Delete permanently from the detail dialog shows the message in the dialog', async () => {
  const user = userEvent.setup();
  const { hero, loose } = files();
  install([hero, loose], { failing: [hero.id] });
  render(<Harness />);
  const dialog = await purgeInDialog(user);
  expect((await within(dialog).findByRole('alert')).textContent).toContain('The file is locked');
  expect(screen.getByRole('dialog', { name: 'hero.png' })).toBe(dialog);
});

it('a rejected purge call from the detail dialog shows the message in the dialog', async () => {
  const user = userEvent.setup();
  const { hero, loose } = files();
  install([hero, loose], {
    handlers: {
      'files:purgeMany': () => {
        throw fakeError('storage_unreachable');
      },
    },
  });
  render(<Harness />);
  const dialog = await purgeInDialog(user);
  expect((await within(dialog).findByRole('alert')).textContent).toContain('cannot be reached');
});

it('a tag rename reloads the trash list', async () => {
  const user = userEvent.setup();
  const { hero, loose } = files();
  const rename = renameHandlers({ bark: 'Bark' });
  const api = install([hero, loose], {
    handlers: {
      ...rename,
      'tags:rename': (request) => {
        api.set('files:list', (r: ListRequest) =>
          pageOf([{ ...hero, tags: [tagOf('Moss')] }, loose].slice(r.offset, r.offset + r.limit), 2),
        );
        return rename['tags:rename'](request);
      },
    },
  });
  render(
    <TagsProvider>
      <RenameTrigger tag={{ name: 'bark', displayName: 'Bark' }} />
      <Harness />
    </TagsProvider>,
  );
  await screen.findByText('hero.png');
  expect(await within(tile('hero.png')).findByText('Bark')).toBeTruthy();
  await renameThroughDialog(user, 'Bark', 'Moss');
  expect(await within(tile('hero.png')).findByText('Moss')).toBeTruthy();
  expect(within(tile('hero.png')).queryByText('Bark')).toBeNull();
});
