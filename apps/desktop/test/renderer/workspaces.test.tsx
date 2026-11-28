import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkspaceSummary } from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { WorkspaceScreen } from '../../src/renderer/src/screens/WorkspaceScreen';
import { deferred, fakeError, installFakeApi } from './fake-api';
import { nextId } from './fixtures';

function workspace(name: string, lastOpenedAt: string): WorkspaceSummary {
  return { id: nextId(), name, rootPath: `D:/w/${name}`, lastOpenedAt };
}

const OLD = workspace('Old', '2026-01-01T00:00:00.000Z');
const NEW = workspace('Newer', '2026-03-01T00:00:00.000Z');

it('workspaces are sorted by last opened, newest first, and the row menu removes', async () => {
  const user = userEvent.setup();
  let list = [OLD, NEW];
  const api = installFakeApi({
    'workspace:list': () => list,
    'workspace:remove': () => {
      list = [OLD];
      return { removed: true, folderTrashed: false };
    },
  });
  render(<WorkspaceScreen onOpened={() => {}} />);
  await screen.findByText('Newer');
  const rows = screen.getAllByRole('row');
  expect(within(rows[1]!).getByText('Newer')).toBeTruthy();
  expect(within(rows[2]!).getByText('Old')).toBeTruthy();
  expect(screen.getByText('2 workspaces')).toBeTruthy();

  await user.click(within(rows[1]!).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
  expect(api.calls.find((c) => c.channel === 'workspace:remove')?.request).toEqual({ id: NEW.id });
  await waitFor(() => expect(screen.queryByText('Newer')).toBeNull());
  expect(screen.getByText('1 workspace')).toBeTruthy();
});

it('after a removal the focus moves to the neighbour row, and to New workspace when none is left', async () => {
  const user = userEvent.setup();
  const third = workspace('Third', '2026-02-01T00:00:00.000Z');
  let list = [OLD, NEW, third];
  installFakeApi({
    'workspace:list': () => list,
    'workspace:remove': (request) => {
      list = list.filter((entry) => entry.id !== (request as { id: string }).id);
      return { removed: true, folderTrashed: false };
    },
  });
  render(<WorkspaceScreen onOpened={() => {}} />);
  await screen.findByText('Newer');

  await user.click(screen.getByRole('button', { name: 'Actions for Third' }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open workspace Old' })));

  await user.click(screen.getByRole('button', { name: 'Actions for Old' }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open workspace Newer' })),
  );

  await user.click(screen.getByRole('button', { name: 'Actions for Newer' }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New workspace' })));
});

it('a declined removal leaves the focus alone', async () => {
  const user = userEvent.setup();
  installFakeApi({
    'workspace:list': () => [OLD, NEW],
    'workspace:remove': () => ({ removed: false, folderTrashed: false }),
  });
  render(<WorkspaceScreen onOpened={() => {}} />);
  await screen.findByText('Newer');
  const menu = screen.getByRole('button', { name: 'Actions for Newer' });
  await user.click(menu);
  await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Open workspace Old' }).hasAttribute('disabled')).toBe(false),
  );
  expect(document.activeElement).toBe(menu);
});

it('the start screen has one top-level heading', async () => {
  installFakeApi({ 'workspace:list': () => [] });
  render(<WorkspaceScreen onOpened={() => {}} />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('AssetForge');
  await screen.findByRole('button', { name: 'New workspace' });
});

it('shows skeleton rows while loading', () => {
  const pending = deferred<WorkspaceSummary[]>();
  installFakeApi({ 'workspace:list': () => pending.promise });
  render(<WorkspaceScreen onOpened={() => {}} />);
  expect(document.querySelectorAll('[data-skeleton]').length).toBeGreaterThan(0);
});

it('Open opens the workspace by its path', async () => {
  const user = userEvent.setup();
  const onOpened = vi.fn();
  const api = installFakeApi({ 'workspace:list': () => [OLD], 'workspace:open': () => OLD });
  render(<WorkspaceScreen onOpened={onOpened} />);
  await user.click(await screen.findByRole('button', { name: 'Open workspace Old' }));
  expect(api.calls.find((c) => c.channel === 'workspace:open')?.request).toEqual({ rootPath: OLD.rootPath });
  expect(onOpened).toHaveBeenCalledWith(OLD);
});

it('New workspace opens a dialog; Enter without a location opens the folder picker', async () => {
  const user = userEvent.setup();
  const api = installFakeApi({ 'workspace:list': () => [], 'dialog:pickDirectory': () => 'D:/parent' });
  render(<WorkspaceScreen onOpened={() => {}} />);
  const trigger = await screen.findByRole('button', { name: 'New workspace' });
  await user.click(trigger);
  const dialog = document.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  const name = within(dialog).getByRole('textbox', { name: 'Workspace name' });
  expect(document.activeElement).toBe(name);
  await user.type(name, 'Fresh{Enter}');
  await waitFor(() => expect(api.calls.some((c) => c.channel === 'dialog:pickDirectory')).toBe(true));
  expect(await within(dialog).findByRole('button', { name: 'Change location' })).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(dialog.open).toBe(false);
  expect(document.activeElement).toBe(trigger);
});

it('the resolved path is re-resolved before create', async () => {
  const user = userEvent.setup();
  const created = workspace('Fresh', '2026-04-01T00:00:00.000Z');
  const api = installFakeApi({
    'workspace:list': () => [],
    'dialog:pickDirectory': () => 'D:/parent',
    'workspace:resolveCreatePath': () => 'D:/parent/Fresh',
    'workspace:create': () => created,
  });
  const onOpened = vi.fn();
  render(<WorkspaceScreen onOpened={onOpened} />);
  await user.click(await screen.findByRole('button', { name: 'New workspace' }));
  const dialog = document.querySelector('dialog')!;
  await user.type(within(dialog).getByRole('textbox', { name: 'Workspace name' }), 'Fresh');
  await user.click(within(dialog).getByRole('button', { name: 'Choose location' }));
  expect((await within(dialog).findByTitle('Folder the workspace will be created in')).textContent).toBe(
    'D:/parent/Fresh',
  );
  await user.click(within(dialog).getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(onOpened).toHaveBeenCalledWith(created));
  const channels = api.calls.map((c) => c.channel);
  expect(channels.filter((c) => c === 'workspace:resolveCreatePath')).toHaveLength(2);
  expect(channels.at(-1)).toBe('workspace:create');
  expect(api.calls.at(-1)?.request).toEqual({ name: 'Fresh', rootPath: 'D:/parent/Fresh' });
});

it('Open folder picks a folder and opens it', async () => {
  const user = userEvent.setup();
  const api = installFakeApi({
    'workspace:list': () => [],
    'dialog:pickDirectory': () => 'D:/existing',
    'workspace:open': () => OLD,
  });
  const onOpened = vi.fn();
  render(<WorkspaceScreen onOpened={onOpened} />);
  await user.click(await screen.findByRole('button', { name: 'Open folder' }));
  await waitFor(() => expect(onOpened).toHaveBeenCalledWith(OLD));
  expect(api.calls.find((c) => c.channel === 'workspace:open')?.request).toEqual({ rootPath: 'D:/existing' });
});

it('an empty list shows the table header and both page actions, no prose', async () => {
  installFakeApi({ 'workspace:list': () => [] });
  render(<WorkspaceScreen onOpened={() => {}} />);
  await screen.findByRole('button', { name: 'New workspace' });
  await waitFor(() => expect(document.querySelectorAll('[data-skeleton]')).toHaveLength(0));
  expect(screen.getByRole('button', { name: 'Open folder' })).toBeTruthy();
  expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
    'Name',
    'Location',
    'Last opened',
    '',
  ]);
  expect(screen.queryByText(/No workspaces/)).toBeNull();
});

it('a failed open shows the mapped message and the row stays', async () => {
  const user = userEvent.setup();
  installFakeApi({
    'workspace:list': () => [OLD],
    'workspace:open': () => {
      throw fakeError('storage_unreachable');
    },
  });
  render(<WorkspaceScreen onOpened={() => {}} />);
  await user.click(await screen.findByRole('button', { name: 'Open workspace Old' }));
  expect((await screen.findByRole('alert')).textContent).toContain('cannot be reached');
  expect(screen.getByText('Old')).toBeTruthy();
});
