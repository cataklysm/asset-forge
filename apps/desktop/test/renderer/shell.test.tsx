import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { JOB_ERROR_MESSAGES, type JobSummary } from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { call } from '../../src/renderer/src/api';
import { AppShell } from '../../src/renderer/src/components/AppShell';
import { WorkspaceShell } from '../../src/renderer/src/components/WorkspaceShell';
import { JOB_POLL_MS, sameSummary } from '../../src/renderer/src/jobs-context';
import { fakeError, installFakeApi } from './fake-api';

type Section = 'assets' | 'projects' | 'inbox' | 'jobs' | 'settings';

function shell(
  props: { section?: Section | null; busy?: boolean; onNavigate?(s: Section): void; onClose?(): void },
  child = <p>content</p>,
) {
  return (
    <AppShell
      workspaceName="Studio"
      rootPath="D:/work/studio"
      section={props.section === undefined ? 'assets' : props.section}
      busy={props.busy ?? false}
      activeJobs={0}
      onNavigate={props.onNavigate ?? (() => {})}
      onClose={props.onClose ?? (() => {})}
    >
      {child}
    </AppShell>
  );
}

it('shows the name, the path with a title and Workspaces closes', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(shell({ onClose }));
  expect(screen.getByRole('heading', { name: 'Studio' })).toBeTruthy();
  expect(screen.getByTitle('D:/work/studio').textContent).toBe('D:/work/studio');
  await user.click(screen.getByRole('button', { name: /Workspaces/ }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('the active section is marked and nav is disabled while busy', async () => {
  const user = userEvent.setup();
  const onNavigate = vi.fn();
  const onClose = vi.fn();
  const { rerender } = render(shell({ section: 'projects', onNavigate, onClose }));
  expect(screen.getByRole('link', { name: /Projects/ }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('link', { name: /Assets/ }).getAttribute('aria-current')).toBeNull();
  await user.click(screen.getByRole('link', { name: /Inbox/ }));
  expect(onNavigate).toHaveBeenCalledWith('inbox');

  onNavigate.mockClear();
  rerender(shell({ section: 'projects', busy: true, onNavigate, onClose }));
  const assets = screen.getByRole('link', { name: /Assets/ });
  expect(assets.getAttribute('aria-disabled')).toBe('true');
  expect(assets.getAttribute('title')).toBe('Import in progress');
  await user.click(assets);
  await user.click(screen.getByRole('button', { name: /Workspaces/ }));
  expect(onNavigate).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /Workspaces/ }).getAttribute('aria-disabled')).toBe('true');
});

it('a storage_unreachable failure shows the banner and Retry remounts the page', async () => {
  const user = userEvent.setup();
  let attempts = 0;
  installFakeApi({
    'assets:list': () => {
      attempts += 1;
      if (attempts === 1) throw fakeError('storage_unreachable');
      return { items: [], total: 0 };
    },
  });
  let mounts = 0;
  function Child() {
    useEffect(() => {
      mounts += 1;
      void call('assets:list', { limit: 1, offset: 0 }).catch(() => {});
    }, []);
    return <p>child</p>;
  }
  render(shell({}, <Child />));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('cannot be reached');
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(mounts).toBe(2));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('Ctrl+F focuses the page search field', async () => {
  const user = userEvent.setup();
  render(shell({}, <input aria-label="Search" data-search-field="" />));
  await user.keyboard('{Control>}f{/Control}');
  expect(document.activeElement).toBe(screen.getByLabelText('Search'));
});

const IDLE: JobSummary = { queued: 0, running: 0, waiting: 0, failed: 0, cancelled: 0, succeeded: 4, changes: 9, paused: null };

function workspaceShell(summary: () => JobSummary, onResume: () => void = () => {}) {
  const api = installFakeApi({
    'jobs:summary': summary,
    'jobs:resume': () => {
      onResume();
      return {};
    },
    'assets:list': () => ({ items: [], total: 0 }),
    'assetTypes:list': () => [],
    'projects:list': () => ({ items: [], total: 0 }),
    'settings:getVision': () => ({
      baseUrl: null,
      timeoutSeconds: 120,
      taggingModel: null,
      promptModel: null,
      hasApiKey: false,
      fromEnvironment: false,
      canStoreKey: true,
    }),
  });
  render(
    <WorkspaceShell
      workspace={{ id: '00000000-0000-4000-8000-00000000f001', name: 'W', rootPath: 'root', lastOpenedAt: '2026-01-01T00:00:00.000Z' }}
      onClosed={() => {}}
    />,
  );
  return api;
}

it('the Jobs entry shows no number while idle and the active count otherwise', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let summary = IDLE;
    const api = workspaceShell(() => summary);
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'jobs:summary')).toBe(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('link', { name: 'Jobs' }).textContent).toBe('Jobs');

    summary = { ...IDLE, queued: 2, running: 1, changes: 10 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    const busy = await screen.findByRole('link', { name: 'Jobs, 3 active' });
    expect(busy.textContent).toBe('Jobs3');
    expect(screen.queryByRole('link', { name: 'Jobs' })).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('a paused queue shows the reason; Resume calls jobs:resume and the banner goes', async () => {
  const user = userEvent.setup();
  let summary: JobSummary = { ...IDLE, queued: 2, paused: { reason: 'provider_unreachable' } };
  const api = workspaceShell(
    () => summary,
    () => {
      summary = { ...summary, paused: null, changes: summary.changes + 1 };
    },
  );
  const banner = await screen.findByRole('alert');
  expect(banner.textContent).toContain(JOB_ERROR_MESSAGES.provider_unreachable);
  expect(within(banner).queryByRole('button', { name: 'Settings' })).toBeNull();
  await user.click(within(banner).getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(api.calls.filter((c) => c.channel === 'jobs:resume')).toHaveLength(1);
});

it.each(['provider_unauthorized', 'provider_not_configured'] as const)(
  'a queue paused by %s offers Settings',
  async (reason) => {
    const user = userEvent.setup();
    workspaceShell(() => ({ ...IDLE, paused: { reason } }));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain(JOB_ERROR_MESSAGES[reason]);
    await user.click(within(banner).getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Settings' })).toBeTruthy();
  },
);

it('the banner shows a failed resume and keeps the pause', async () => {
  const user = userEvent.setup();
  const onResume = vi.fn(() => {
    throw fakeError('internal_error');
  });
  render(
    <AppShell
      workspaceName="Studio"
      rootPath="D:/work/studio"
      section="assets"
      busy={false}
      activeJobs={0}
      paused="provider_unreachable"
      onResume={async () => onResume()}
      onNavigate={() => {}}
      onClose={() => {}}
    >
      <p>content</p>
    </AppShell>,
  );
  await user.click(screen.getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).not.toContain(JOB_ERROR_MESSAGES.provider_unreachable));
  expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
});

it('sameSummary tells a changed pause reason apart', () => {
  expect(sameSummary({ ...IDLE, paused: { reason: 'provider_unreachable' } }, { ...IDLE, paused: { reason: 'provider_unreachable' } })).toBe(true);
  expect(sameSummary({ ...IDLE, paused: { reason: 'provider_unreachable' } }, { ...IDLE, paused: { reason: 'provider_unauthorized' } })).toBe(false);
  expect(sameSummary(IDLE, { ...IDLE, paused: { reason: 'provider_unreachable' } })).toBe(false);
  expect(sameSummary(IDLE, { ...IDLE, failed: 1 })).toBe(false);
});

it('choosing Jobs shows the Jobs page', async () => {
  const user = userEvent.setup();
  workspaceShell(() => IDLE);
  await user.click(screen.getByRole('link', { name: /Jobs/ }));
  expect(await screen.findByRole('heading', { level: 2, name: 'Jobs' })).toBeTruthy();
  expect(screen.getByRole('link', { name: /Jobs/ }).getAttribute('aria-current')).toBe('page');
});

it('choosing Settings shows the Settings page, also without a configured provider', async () => {
  const user = userEvent.setup();
  workspaceShell(() => IDLE);
  await user.click(screen.getByRole('link', { name: 'Settings' }));
  expect(await screen.findByRole('heading', { level: 2, name: 'Settings' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
  expect((screen.getByLabelText('Base URL') as HTMLInputElement).value).toBe('');
});
