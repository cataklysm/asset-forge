import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BACKUP_MESSAGES,
  LOCATION_IN_WORKSPACE_MESSAGE,
  type BackupAttempt,
  type BackupEntry,
} from '@assetforge/contracts';
import { expect, it } from 'vitest';
import { BackupSettings } from '../../src/renderer/src/components/BackupSettings';
import { backupStatus, deferred, fakeError, installFakeApi } from './fake-api';
import { nextId } from './fixtures';

const FOLDER = 'E:/backups/assetforge-backups/w1';

function channelCalls(api: ReturnType<typeof installFakeApi>, channel: string) {
  return api.calls.filter((entry) => entry.channel === channel).map((entry) => entry.request);
}

function section() {
  return screen.getByRole('region', { name: 'Backup' });
}

const FAILED: BackupAttempt = {
  at: '2026-11-28T08:00:00.000Z',
  ok: false,
  code: 'backup_no_space',
  message: BACKUP_MESSAGES.backup_no_space,
};

it('shows Workspace folder and disables Reset for the default place', async () => {
  installFakeApi({ 'backup:status': () => backupStatus({ count: 3, totalBytes: 3 * 1024 * 1024 }) });
  render(<BackupSettings />);
  expect(await screen.findByText('Workspace folder')).toBeTruthy();
  expect(within(section()).getByRole('button', { name: 'Reset' }).hasAttribute('disabled')).toBe(true);
  expect(within(section()).getByRole('button', { name: 'Change…' }).hasAttribute('disabled')).toBe(false);
  expect(within(section()).getByText('3 copies, 3.0 MiB')).toBeTruthy();
  expect(within(section()).getByText('None')).toBeTruthy();
});

it('a chosen place shows its path, Reset goes back to the default place', async () => {
  const user = userEvent.setup();
  const api = installFakeApi({
    'backup:status': () => backupStatus({ location: { kind: 'chosen', path: FOLDER } }),
    'backup:resetLocation': () => backupStatus(),
  });
  render(<BackupSettings />);
  expect((await screen.findByText(FOLDER)).getAttribute('title')).toBe(FOLDER);
  await user.click(within(section()).getByRole('button', { name: 'Reset' }));
  expect(await screen.findByText('Workspace folder')).toBeTruthy();
  expect(channelCalls(api, 'backup:resetLocation')).toEqual([{}]);
});

it('an unreachable place and a failed last attempt show their messages', async () => {
  installFakeApi({
    'backup:status': () => backupStatus({ location: { kind: 'chosen', path: FOLDER }, reachable: false, last: FAILED }),
  });
  render(<BackupSettings />);
  expect(await screen.findByText(BACKUP_MESSAGES.backup_location_unreachable)).toBeTruthy();
  expect(within(section()).getByText(BACKUP_MESSAGES.backup_no_space, { exact: false })).toBeTruthy();
});

it('Change cancelled keeps the view', async () => {
  const user = userEvent.setup();
  const api = installFakeApi({
    'backup:status': () => backupStatus({ count: 1, totalBytes: 1024 }),
    'backup:changeLocation': () => null,
  });
  render(<BackupSettings />);
  await screen.findByText('Workspace folder');
  await user.click(within(section()).getByRole('button', { name: 'Change…' }));
  await waitFor(() => expect(channelCalls(api, 'backup:changeLocation')).toEqual([{}]));
  expect(screen.getByText('Workspace folder')).toBeTruthy();
  expect(screen.getByText('1 copy, 1.0 KiB')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('Change shows the new place', async () => {
  const user = userEvent.setup();
  installFakeApi({
    'backup:changeLocation': () => backupStatus({ location: { kind: 'chosen', path: FOLDER } }),
  });
  render(<BackupSettings />);
  await screen.findByText('Workspace folder');
  await user.click(within(section()).getByRole('button', { name: 'Change…' }));
  expect(await screen.findByText(FOLDER)).toBeTruthy();
  expect(within(section()).getByRole('button', { name: 'Reset' }).hasAttribute('disabled')).toBe(false);
});

it('validation message shown on a refused folder', async () => {
  const user = userEvent.setup();
  installFakeApi({
    'backup:changeLocation': () => {
      throw fakeError('validation_failed', LOCATION_IN_WORKSPACE_MESSAGE);
    },
  });
  render(<BackupSettings />);
  await screen.findByText('Workspace folder');
  await user.click(within(section()).getByRole('button', { name: 'Change…' }));
  expect((await screen.findByRole('alert')).textContent).toBe(LOCATION_IN_WORKSPACE_MESSAGE);
  expect(screen.getByText('Workspace folder')).toBeTruthy();
});

it('Back up now disables while running', async () => {
  const user = userEvent.setup();
  const attempt = deferred<BackupAttempt>();
  let status = backupStatus();
  const api = installFakeApi({
    'backup:status': () => status,
    'backup:now': () => attempt.promise,
  });
  render(<BackupSettings />);
  await screen.findByText('Workspace folder');
  const button = within(section()).getByRole('button', { name: 'Back up now' });
  await user.click(button);
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true));
  expect(within(section()).getByRole('button', { name: 'Change…' }).hasAttribute('disabled')).toBe(true);

  const done: BackupAttempt = { at: '2026-11-28T09:00:00.000Z', ok: true, code: null, message: null };
  status = backupStatus({ last: done, count: 1, totalBytes: 2048 });
  attempt.resolve(done);
  expect(await screen.findByText('Succeeded', { exact: false })).toBeTruthy();
  expect(screen.getByText('1 copy, 2.0 KiB')).toBeTruthy();
  expect(button.hasAttribute('disabled')).toBe(false);
  expect(channelCalls(api, 'backup:status')).toHaveLength(2);
});

it('a backup the main process runs already keeps Back up now disabled', async () => {
  installFakeApi({ 'backup:status': () => backupStatus({ running: true }) });
  render(<BackupSettings />);
  await screen.findByText('Workspace folder');
  expect(within(section()).getByRole('button', { name: 'Back up now' }).hasAttribute('disabled')).toBe(true);
});

it('Delete of another lineage asks first', async () => {
  const user = userEvent.setup();
  const other: BackupEntry = {
    backupId: nextId(),
    createdAt: '2026-10-01T09:00:00.000Z',
    sizeBytes: 4096,
    appliedMigrations: 18,
    origin: 'regular',
    sameLineage: false,
  };
  const api = installFakeApi({
    'backup:status': () => backupStatus({ otherLineages: [other] }),
    'backup:delete': () => backupStatus(),
  });
  render(<BackupSettings />);
  const when = new Date(other.createdAt).toLocaleString();
  await user.click(await screen.findByRole('button', { name: `Delete backup of ${when}` }));
  const confirm = await screen.findByRole('dialog', { name: 'Delete this backup?' });
  expect(channelCalls(api, 'backup:delete')).toEqual([]);
  await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

  await waitFor(() => expect(screen.queryByRole('button', { name: `Delete backup of ${when}` })).toBeNull());
  expect(channelCalls(api, 'backup:delete')).toEqual([{ backupId: other.backupId }]);
});

it('a failed load shows its message with Retry', async () => {
  const user = userEvent.setup();
  let fail = true;
  installFakeApi({
    'backup:status': () => {
      if (fail) throw fakeError('internal_error');
      return backupStatus();
    },
  });
  render(<BackupSettings />);
  expect((await screen.findByRole('alert')).textContent).toBe('The backup settings could not be loaded');
  fail = false;
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Workspace folder')).toBeTruthy();
});
