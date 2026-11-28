import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BACKUP_MESSAGES, type BackupState, type JobSummary } from '@assetforge/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceShell } from '../../src/renderer/src/components/WorkspaceShell';
import { BACKUP_STATE_POLL_MS } from '../../src/renderer/src/hooks/useBackupState';
import { fakeError, installFakeApi } from './fake-api';

const WORKSPACE_ID = '00000000-0000-4000-8000-00000000f001';
const LINE = `The last backup failed: ${BACKUP_MESSAGES.backup_no_space}`;

const IDLE: JobSummary = {
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

const FAILED: BackupState = {
  workspaceId: WORKSPACE_ID,
  running: false,
  last: {
    at: '2026-11-28T08:00:00.000Z',
    ok: false,
    code: 'backup_no_space',
    message: BACKUP_MESSAGES.backup_no_space,
  },
};

const SUCCEEDED: BackupState = {
  workspaceId: WORKSPACE_ID,
  running: false,
  last: { at: '2026-11-28T09:00:00.000Z', ok: true, code: null, message: null },
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function openShell(state: () => BackupState) {
  const api = installFakeApi({
    'backup:state': state,
    'jobs:summary': () => IDLE,
    'assets:list': () => ({ items: [], total: 0 }),
    'trash:summary': () => ({ count: 0 }),
    'assetTypes:list': () => [],
    'projects:list': () => ({ items: [], total: 0 }),
  });
  const view = render(
    <WorkspaceShell
      workspace={{ id: WORKSPACE_ID, name: 'W', rootPath: 'root', lastOpenedAt: '2026-01-01T00:00:00.000Z' }}
      onClosed={() => {}}
    />,
  );
  return { calls: api.calls, unmount: view.unmount };
}

async function nextPoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(BACKUP_STATE_POLL_MS);
  });
}

it('failed last attempt shows the line with Settings that navigates', async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  openShell(() => FAILED);
  const line = await screen.findByText(LINE);
  const banner = line.closest('[role="alert"]') as HTMLElement;
  await user.click(within(banner).getByRole('button', { name: 'Settings' }));
  expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
  const backup = screen.getByRole('heading', { name: 'Backup' });
  await waitFor(() => expect(document.activeElement).toBe(backup));

  // On Settings already, Settings in the line brings the section into view again.
  (document.activeElement as HTMLElement).blur();
  await user.click(within(banner).getByRole('button', { name: 'Settings' }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Backup' })));
});

it('the main navigation to Settings leaves the focus alone', async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  openShell(() => FAILED);
  await screen.findByText(LINE);
  const nav = screen.getByRole('navigation');
  await user.click(within(nav).getByRole('link', { name: 'Settings' }));
  expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
  expect(document.activeElement).not.toBe(screen.getByRole('heading', { name: 'Backup' }));
});

it('an unmount while the first request runs asks nothing more', async () => {
  let resolveFirst: (state: BackupState) => void = () => {};
  const first = new Promise<BackupState>((resolve) => {
    resolveFirst = resolve;
  });
  const api = installFakeApi({ 'backup:state': () => first, 'jobs:summary': () => IDLE });
  const view = render(
    <WorkspaceShell
      workspace={{ id: WORKSPACE_ID, name: 'W', rootPath: 'root', lastOpenedAt: '2026-01-01T00:00:00.000Z' }}
      onClosed={() => {}}
    />,
  );
  const stateCalls = () => api.calls.filter((entry) => entry.channel === 'backup:state').length;
  await waitFor(() => expect(stateCalls()).toBe(1));
  view.unmount();
  resolveFirst(FAILED);
  await nextPoll();
  await nextPoll();
  expect(stateCalls()).toBe(1);
});

it('an unmount while polling asks nothing more', async () => {
  const api = openShell(() => FAILED);
  await screen.findByText(LINE);
  await nextPoll();
  const stateCalls = () => api.calls.filter((entry) => entry.channel === 'backup:state').length;
  const before = stateCalls();
  expect(before).toBeGreaterThanOrEqual(2);
  api.unmount();
  await nextPoll();
  await nextPoll();
  expect(stateCalls()).toBe(before);
});

it('a later success hides it', async () => {
  let state = FAILED;
  openShell(() => state);
  await screen.findByText(LINE);
  state = SUCCEEDED;
  await nextPoll();
  await waitFor(() => expect(screen.queryByText(LINE)).toBeNull());
});

it('a failed poll keeps the line', async () => {
  let fail = false;
  const api = openShell(() => {
    if (fail) throw fakeError('internal_error');
    return FAILED;
  });
  await screen.findByText(LINE);
  fail = true;
  await nextPoll();
  await nextPoll();
  expect(api.calls.filter((entry) => entry.channel === 'backup:state').length).toBeGreaterThanOrEqual(3);
  expect(screen.getByText(LINE)).toBeTruthy();
});

it('an attempt of another workspace or a success shows no line', async () => {
  let state: BackupState = { ...FAILED, workspaceId: '00000000-0000-4000-8000-00000000f002' };
  const api = openShell(() => state);
  await waitFor(() => expect(api.calls.some((entry) => entry.channel === 'backup:state')).toBe(true));
  await nextPoll();
  expect(screen.queryByText(/The last backup failed/)).toBeNull();
  state = SUCCEEDED;
  await nextPoll();
  expect(screen.queryByText(/The last backup failed/)).toBeNull();
});
