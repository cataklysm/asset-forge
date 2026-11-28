import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BACKUP_MESSAGES,
  BACKUP_STALE_MESSAGE,
  DATABASE_MISSING_MESSAGE,
  type BackupEntry,
  type WorkspaceSummary,
} from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { RestoreDialog } from '../../src/renderer/src/screens/RestoreDialog';
import { WorkspaceScreen } from '../../src/renderer/src/screens/WorkspaceScreen';
import { deferred, fakeError, installFakeApi } from './fake-api';
import { nextId } from './fixtures';

const WORKSPACE: WorkspaceSummary = {
  id: nextId(),
  name: 'Studio',
  rootPath: 'D:/w/Studio',
  lastOpenedAt: '2026-11-01T00:00:00.000Z',
};

function backup(createdAt: string, p: Partial<BackupEntry> = {}): BackupEntry {
  return {
    backupId: nextId(),
    createdAt,
    sizeBytes: 4096,
    appliedMigrations: 21,
    origin: 'regular',
    sameLineage: true,
    ...p,
  };
}

const NEWEST = backup('2026-11-28T09:00:00.000Z');
const OLDER = backup('2026-11-27T09:00:00.000Z', { origin: 'pre_migration', sameLineage: false });

function channelCalls(api: ReturnType<typeof installFakeApi>, channel: string) {
  return api.calls.filter((entry) => entry.channel === channel).map((entry) => entry.request);
}

function restoreButton() {
  return within(screen.getByRole('dialog', { name: 'Restore backup' })).getByRole('button', { name: 'Restore' });
}

it('missing database on open shows the dialog with the newest preselected', async () => {
  const user = userEvent.setup();
  const api = installFakeApi({
    'workspace:list': () => [WORKSPACE],
    'workspace:open': () => {
      throw fakeError('workspace_database_missing', DATABASE_MISSING_MESSAGE);
    },
    'workspace:backups': () => ({ backups: [NEWEST, OLDER], unreachable: false }),
  });
  render(<WorkspaceScreen onOpened={() => {}} />);
  await user.click(await screen.findByRole('button', { name: 'Open workspace Studio' }));

  const dialog = await screen.findByRole('dialog', { name: 'Restore backup' });
  const radios = await within(dialog).findAllByRole('radio');
  expect(radios).toHaveLength(2);
  expect((radios[0] as HTMLInputElement).checked).toBe(true);
  expect((radios[1] as HTMLInputElement).checked).toBe(false);
  expect(channelCalls(api, 'workspace:backups')).toEqual([{ rootPath: WORKSPACE.rootPath }]);
  expect(within(dialog).getByRole('button', { name: 'Start empty' })).toBeTruthy();
  // The missing database is not shown as an error on the screen.
  expect(screen.queryByText(DATABASE_MISSING_MESSAGE)).toBeNull();
});

it('Restore without existing database needs no confirmation', async () => {
  const user = userEvent.setup();
  const onRestored = vi.fn();
  const api = installFakeApi({
    'workspace:backups': () => ({ backups: [NEWEST, OLDER], unreachable: false }),
    'workspace:restore': () => WORKSPACE,
  });
  render(
    <RestoreDialog
      open
      target={{ rootPath: WORKSPACE.rootPath }}
      rootPath={WORKSPACE.rootPath}
      databaseExists={false}
      onRestored={onRestored}
      onClose={() => {}}
    />,
  );
  const radios = await screen.findAllByRole('radio');
  await user.click(radios[1]!);
  await user.click(restoreButton());

  await waitFor(() => expect(onRestored).toHaveBeenCalledWith(WORKSPACE));
  expect(channelCalls(api, 'workspace:restore')).toEqual([{ rootPath: WORKSPACE.rootPath, backupId: OLDER.backupId }]);
  expect(screen.queryByRole('dialog', { name: 'Restore this backup?' })).toBeNull();
});

it('from the list Restore asks ConfirmDialog first', async () => {
  const user = userEvent.setup();
  const onOpened = vi.fn();
  const api = installFakeApi({
    'workspace:list': () => [WORKSPACE],
    'workspace:backups': () => ({ backups: [NEWEST], unreachable: false }),
    'workspace:restore': () => WORKSPACE,
  });
  render(<WorkspaceScreen onOpened={onOpened} />);
  await user.click(await screen.findByRole('button', { name: 'Actions for Studio' }));
  await user.click(screen.getByRole('menuitem', { name: 'Restore backup…' }));

  const dialog = await screen.findByRole('dialog', { name: 'Restore backup' });
  await within(dialog).findAllByRole('radio');
  expect(channelCalls(api, 'workspace:backups')).toEqual([{ id: WORKSPACE.id }]);
  expect(within(dialog).queryByRole('button', { name: 'Start empty' })).toBeNull();

  await user.click(restoreButton());
  const confirm = await screen.findByRole('dialog', { name: 'Restore this backup?' });
  expect(channelCalls(api, 'workspace:restore')).toEqual([]);
  await user.click(within(confirm).getByRole('button', { name: 'Restore' }));

  await waitFor(() => expect(onOpened).toHaveBeenCalledWith(WORKSPACE));
  expect(channelCalls(api, 'workspace:restore')).toEqual([{ rootPath: WORKSPACE.rootPath, backupId: NEWEST.backupId }]);
});

it('a cancelled confirmation restores nothing', async () => {
  const user = userEvent.setup();
  const api = installFakeApi({
    'workspace:backups': () => ({ backups: [NEWEST], unreachable: false }),
    'workspace:restore': () => WORKSPACE,
  });
  render(
    <RestoreDialog
      open
      target={{ id: WORKSPACE.id }}
      rootPath={WORKSPACE.rootPath}
      databaseExists
      onRestored={() => {}}
      onClose={() => {}}
    />,
  );
  await screen.findAllByRole('radio');
  await user.click(restoreButton());
  const confirm = await screen.findByRole('dialog', { name: 'Restore this backup?' });
  await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Restore this backup?' })).toBeNull());
  expect(channelCalls(api, 'workspace:restore')).toEqual([]);
});

it('Choose folder sends pickFolder and shows the new list', async () => {
  const user = userEvent.setup();
  const picked = backup('2026-10-01T09:00:00.000Z', { sizeBytes: 2048 });
  const api = installFakeApi({
    'workspace:backups': (request) =>
      request.pickFolder === true
        ? { backups: [picked], unreachable: false }
        : { backups: [NEWEST, OLDER], unreachable: false },
    'workspace:restore': () => WORKSPACE,
  });
  render(
    <RestoreDialog
      open
      target={{ rootPath: WORKSPACE.rootPath }}
      rootPath={WORKSPACE.rootPath}
      databaseExists={false}
      onRestored={() => {}}
      onClose={() => {}}
    />,
  );
  expect(await screen.findAllByRole('radio')).toHaveLength(2);
  await user.click(screen.getByRole('button', { name: 'Choose folder…' }));

  await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(1));
  expect((screen.getByRole('radio') as HTMLInputElement).checked).toBe(true);
  expect(channelCalls(api, 'workspace:backups')).toEqual([
    { rootPath: WORKSPACE.rootPath },
    { rootPath: WORKSPACE.rootPath, pickFolder: true },
  ]);
  await user.click(restoreButton());
  await waitFor(() =>
    expect(channelCalls(api, 'workspace:restore')).toEqual([
      { rootPath: WORKSPACE.rootPath, backupId: picked.backupId },
    ]),
  );
});

it('stale id reloads the list', async () => {
  const user = userEvent.setup();
  const fresh = backup('2026-11-28T10:00:00.000Z');
  let listing = [NEWEST];
  const api = installFakeApi({
    'workspace:backups': () => ({ backups: listing, unreachable: false }),
    'workspace:restore': () => {
      listing = [fresh];
      throw fakeError('invalid_operation', BACKUP_STALE_MESSAGE);
    },
  });
  render(
    <RestoreDialog
      open
      target={{ rootPath: WORKSPACE.rootPath }}
      rootPath={WORKSPACE.rootPath}
      databaseExists={false}
      onRestored={() => {}}
      onClose={() => {}}
    />,
  );
  await screen.findAllByRole('radio');
  await user.click(restoreButton());

  expect((await screen.findByRole('alert')).textContent).toBe(BACKUP_STALE_MESSAGE);
  expect(channelCalls(api, 'workspace:backups')).toHaveLength(2);
  await waitFor(() => expect(restoreButton().hasAttribute('disabled')).toBe(false));
  await user.click(restoreButton());
  await waitFor(() =>
    expect(channelCalls(api, 'workspace:restore').at(-1)).toEqual({
      rootPath: WORKSPACE.rootPath,
      backupId: fresh.backupId,
    }),
  );
});

it('another refusal shows its message and keeps the list', async () => {
  const user = userEvent.setup();
  const api = installFakeApi({
    'workspace:backups': () => ({ backups: [NEWEST], unreachable: false }),
    'workspace:restore': () => {
      throw fakeError('validation_failed', 'This backup is damaged');
    },
  });
  render(
    <RestoreDialog
      open
      target={{ rootPath: WORKSPACE.rootPath }}
      rootPath={WORKSPACE.rootPath}
      databaseExists={false}
      onRestored={() => {}}
      onClose={() => {}}
    />,
  );
  await screen.findAllByRole('radio');
  await user.click(restoreButton());
  expect((await screen.findByRole('alert')).textContent).toBe('This backup is damaged');
  expect(channelCalls(api, 'workspace:backups')).toHaveLength(1);
  expect(screen.getAllByRole('radio')).toHaveLength(1);
});

it('Start empty confirms and opens with startEmpty', async () => {
  const user = userEvent.setup();
  const onRestored = vi.fn();
  const api = installFakeApi({
    'workspace:backups': () => ({ backups: [], unreachable: false }),
    'workspace:open': () => WORKSPACE,
  });
  render(
    <RestoreDialog
      open
      target={{ rootPath: WORKSPACE.rootPath }}
      rootPath={WORKSPACE.rootPath}
      databaseExists={false}
      onRestored={onRestored}
      onClose={() => {}}
    />,
  );
  await screen.findByText('No backups');
  await user.click(screen.getByRole('button', { name: 'Start empty' }));
  const confirm = await screen.findByRole('dialog', { name: 'Start with an empty catalog?' });
  expect(channelCalls(api, 'workspace:open')).toEqual([]);
  await user.click(within(confirm).getByRole('button', { name: 'Start empty' }));

  await waitFor(() => expect(onRestored).toHaveBeenCalledWith(WORKSPACE));
  expect(channelCalls(api, 'workspace:open')).toEqual([{ rootPath: WORKSPACE.rootPath, startEmpty: true }]);
});

it('no backups disables Restore', async () => {
  installFakeApi({ 'workspace:backups': () => ({ backups: [], unreachable: false }) });
  render(
    <RestoreDialog
      open
      target={{ id: WORKSPACE.id }}
      rootPath={WORKSPACE.rootPath}
      databaseExists
      onRestored={() => {}}
      onClose={() => {}}
    />,
  );
  await screen.findByText('No backups');
  expect(restoreButton().hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Choose folder…' }).hasAttribute('disabled')).toBe(false);
});

it('an unreachable place shows the alert above the list and Choose folder stays usable', async () => {
  installFakeApi({ 'workspace:backups': () => ({ backups: [NEWEST], unreachable: true }) });
  render(
    <RestoreDialog
      open
      target={{ id: WORKSPACE.id }}
      rootPath={WORKSPACE.rootPath}
      databaseExists
      onRestored={() => {}}
      onClose={() => {}}
    />,
  );
  expect((await screen.findByRole('alert')).textContent).toBe(BACKUP_MESSAGES.backup_location_unreachable);
  await screen.findAllByRole('radio');
  expect(screen.getByRole('button', { name: 'Choose folder…' }).hasAttribute('disabled')).toBe(false);
});

it('while the list loads every button is disabled; a failed load shows its message', async () => {
  const loading = deferred<{ backups: BackupEntry[]; unreachable: boolean }>();
  installFakeApi({ 'workspace:backups': () => loading.promise });
  render(
    <RestoreDialog
      open
      target={{ rootPath: WORKSPACE.rootPath }}
      rootPath={WORKSPACE.rootPath}
      databaseExists={false}
      onRestored={() => {}}
      onClose={() => {}}
    />,
  );
  for (const name of ['Restore', 'Choose folder…', 'Start empty', 'Cancel'])
    expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
  loading.reject(fakeError('workspace_not_found', 'No workspace'));
  expect(await screen.findByRole('alert')).toBeTruthy();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(false));
});

it('Cancel closes the dialog', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  installFakeApi({ 'workspace:backups': () => ({ backups: [NEWEST], unreachable: false }) });
  render(
    <RestoreDialog
      open
      target={{ id: WORKSPACE.id }}
      rootPath={WORKSPACE.rootPath}
      databaseExists
      onRestored={() => {}}
      onClose={onClose}
    />,
  );
  await screen.findAllByRole('radio');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalled();
});

it('no explanatory text: only labels and tooltips', async () => {
  installFakeApi({ 'workspace:backups': () => ({ backups: [NEWEST, OLDER], unreachable: false }) });
  render(
    <RestoreDialog
      open
      target={{ id: WORKSPACE.id }}
      rootPath={WORKSPACE.rootPath}
      databaseExists
      onRestored={() => {}}
      onClose={() => {}}
    />,
  );
  await screen.findAllByRole('radio');
  const dialog = screen.getByRole('dialog', { name: 'Restore backup' });
  const clone = dialog.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll('.sr-only')) hidden.remove();
  const texts = [...clone.querySelectorAll('*')]
    .flatMap((element) => [...element.childNodes])
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent!.trim())
    .filter((text) => text !== '');
  const dates = [NEWEST, OLDER].map((entry) => new Date(entry.createdAt).toLocaleString());
  expect(texts).toEqual([
    'Restore backup',
    dates[0],
    '4.0 KiB',
    'm21',
    dates[1],
    '4.0 KiB',
    'm21',
    'Choose folder…',
    'Restore',
    'Cancel',
  ]);
  expect(within(dialog).getAllByTitle(/before the database was updated/)).toHaveLength(1);
  expect(within(dialog).getAllByTitle(/another database/)).toHaveLength(1);
});
