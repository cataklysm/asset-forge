import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { JOB_ERROR_MESSAGES, type JobSummary, type PausedProvider } from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { call } from '../../src/renderer/src/api';
import { AppShell } from '../../src/renderer/src/components/AppShell';
import { JobsAppShell, WorkspaceShell } from '../../src/renderer/src/components/WorkspaceShell';
import { JOB_POLL_MS, JobsProvider, sameSummary } from '../../src/renderer/src/jobs-context';
import { ProviderSettingsProvider } from '../../src/renderer/src/provider-context';
import { deferred, fakeError, fakePrompts, installFakeApi, promptDetail, type FakeHandlers } from './fake-api';
import { assetSummary, fileRecord, pageOf, tagOf, trashedRecord } from './fixtures';
import { renameHandlers, renameThroughDialog } from './rename-flow';

type Section = 'assets' | 'projects' | 'prompts' | 'inbox' | 'trash' | 'jobs' | 'settings';

function shell(
  props: {
    section?: Section | null;
    busy?: boolean;
    trashCount?: number | null;
    onNavigate?(s: Section): void;
    onClose?(): void;
  },
  child = <p>content</p>,
) {
  return (
    <AppShell
      workspaceName="Studio"
      rootPath="D:/work/studio"
      section={props.section === undefined ? 'assets' : props.section}
      busy={props.busy ?? false}
      activeJobs={0}
      trashCount={props.trashCount}
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

const IDLE: JobSummary = { queued: 0, running: 0, waiting: 0, failed: 0, cancelled: 0, succeeded: 4, changes: 9, paused: [], pausedHosts: [] };

function workspaceShell(summary: () => JobSummary, onResume: () => void = () => {}, handlers: FakeHandlers = {}) {
  const api = installFakeApi({
    'jobs:summary': summary,
    'jobs:resume': () => {
      onResume();
      return {};
    },
    'jobs:waitingByProvider': () => [],
    'assets:list': () => ({ items: [], total: 0 }),
    'trash:summary': () => ({ count: 0 }),
    'assetTypes:list': () => [],
    'projects:list': () => ({ items: [], total: 0 }),
    ...handlers,
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

const LOCAL_ID = '00000000-0000-4000-8000-00000000a001';
const RUNPOD_ID = '00000000-0000-4000-8000-00000000b001';
const PAUSED_LOCAL: PausedProvider = { providerId: LOCAL_ID, providerName: 'Local Ollama', kind: 'ollama', reason: 'provider_unreachable' };
const PAUSED_RUNPOD: PausedProvider = { providerId: RUNPOD_ID, providerName: 'RunPod', kind: 'ollama', reason: 'provider_unauthorized' };

/** The app frame of the workspace shell inside its job and provider state, without the screens. */
function jobsShell(summary: () => JobSummary, handlers: FakeHandlers = {}) {
  const onNavigate = vi.fn();
  const api = installFakeApi({
    'jobs:summary': summary,
    'jobs:resume': () => ({}),
    'jobs:waitingByProvider': () => [
      { providerId: LOCAL_ID, providerName: 'Local Ollama', waiting: 12 },
      { providerId: RUNPOD_ID, providerName: 'RunPod', waiting: 3 },
    ],
    ...handlers,
  });
  render(
    <JobsProvider>
      <ProviderSettingsProvider>
        <JobsAppShell workspaceName="W" rootPath="root" section="assets" busy={false} onNavigate={onNavigate} onClose={() => {}}>
          <p>content</p>
        </JobsAppShell>
      </ProviderSettingsProvider>
    </JobsProvider>,
  );
  return { api, onNavigate };
}

it('one line per paused provider; Resume on the second resumes that provider only', async () => {
  const user = userEvent.setup();
  let summary: JobSummary = { ...IDLE, queued: 2, paused: [PAUSED_LOCAL, PAUSED_RUNPOD] };
  const { api } = jobsShell(() => summary, {
    'jobs:resume': ({ providerId }) => {
      summary = { ...summary, paused: summary.paused.filter((p) => p.providerId !== providerId), changes: summary.changes + 1 };
      return {};
    },
  });
  const banner = await screen.findByRole('alert');
  const local = within(banner).getByRole('group', { name: 'Local Ollama' });
  const runpod = within(banner).getByRole('group', { name: 'RunPod' });
  expect(local.textContent).toContain(JOB_ERROR_MESSAGES.provider_unreachable);
  expect(runpod.textContent).toContain(JOB_ERROR_MESSAGES.provider_unauthorized);
  await user.click(within(runpod).getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(within(screen.getByRole('alert')).queryByRole('group', { name: 'RunPod' })).toBeNull());
  expect(api.calls.filter((c) => c.channel === 'jobs:resume').map((c) => c.request)).toEqual([{ providerId: RUNPOD_ID }]);
  expect(within(screen.getByRole('alert')).getByRole('group', { name: 'Local Ollama' })).toBeTruthy();
});

it('Settings is offered only on the line paused for a settings reason', async () => {
  const user = userEvent.setup();
  const { onNavigate } = jobsShell(() => ({ ...IDLE, paused: [PAUSED_LOCAL, PAUSED_RUNPOD] }));
  const banner = await screen.findByRole('alert');
  expect(within(within(banner).getByRole('group', { name: 'Local Ollama' })).queryByRole('button', { name: 'Settings' })).toBeNull();
  await user.click(within(within(banner).getByRole('group', { name: 'RunPod' })).getByRole('button', { name: 'Settings' }));
  expect(onNavigate).toHaveBeenCalledWith('settings');
});

it('Move jobs on a line opens the move dialog with that provider as the fixed source', async () => {
  const user = userEvent.setup();
  jobsShell(() => ({ ...IDLE, paused: [PAUSED_LOCAL, PAUSED_RUNPOD] }));
  const banner = await screen.findByRole('alert');
  await user.click(within(within(banner).getByRole('group', { name: 'RunPod' })).getByRole('button', { name: 'Move jobs' }));
  const dialog = await screen.findByRole('dialog', { name: 'Move jobs' });
  expect(await within(dialog).findByText('3 waiting')).toBeTruthy();
  expect(within(dialog).getByText('RunPod')).toBeTruthy();
  expect(within(dialog).queryByRole('combobox', { name: 'From' })).toBeNull();
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog', { name: 'Move jobs' })).toBeNull();
});

it('the line of a paused Venice lane offers Resume and Settings but no Move jobs', async () => {
  const user = userEvent.setup();
  const VENICE_ID = '00000000-0000-4000-8000-00000000c001';
  const venice: PausedProvider = { providerId: VENICE_ID, providerName: 'Venice', kind: 'venice', reason: 'provider_unauthorized' };
  const { api, onNavigate } = jobsShell(() => ({ ...IDLE, paused: [venice, PAUSED_LOCAL] }));
  const banner = await screen.findByRole('alert');
  const line = within(banner).getByRole('group', { name: 'Venice' });
  expect(within(line).queryByRole('button', { name: 'Move jobs' })).toBeNull();
  expect(within(within(banner).getByRole('group', { name: 'Local Ollama' })).getByRole('button', { name: 'Move jobs' })).toBeTruthy();
  await user.click(within(line).getByRole('button', { name: 'Settings' }));
  expect(onNavigate).toHaveBeenCalledWith('settings');
  await user.click(within(line).getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(api.calls.some((c) => c.channel === 'jobs:resume')).toBe(true));
  expect(api.calls.find((c) => c.channel === 'jobs:resume')?.request).toEqual({ providerId: VENICE_ID });
});

it('the line of a paused OpenAI-compatible entry offers Move jobs, a Venice one does not', async () => {
  const VLLM_ID = '00000000-0000-4000-8000-00000000d001';
  const VENICE_ID = '00000000-0000-4000-8000-00000000c001';
  const vllm: PausedProvider = { providerId: VLLM_ID, providerName: 'vLLM', kind: 'openai', reason: 'provider_unreachable' };
  const venice: PausedProvider = { providerId: VENICE_ID, providerName: 'Venice', kind: 'venice', reason: 'provider_unreachable' };
  jobsShell(() => ({ ...IDLE, paused: [vllm, venice] }));
  const banner = await screen.findByRole('alert');
  expect(within(within(banner).getByRole('group', { name: 'vLLM' })).getByRole('button', { name: 'Move jobs' })).toBeTruthy();
  expect(within(within(banner).getByRole('group', { name: 'Venice' })).queryByRole('button', { name: 'Move jobs' })).toBeNull();
});

it('no paused provider shows no banner', async () => {
  const { api } = jobsShell(() => IDLE);
  await waitFor(() => expect(api.calls.some((c) => c.channel === 'jobs:summary')).toBe(true));
  await act(async () => {});
  expect(screen.queryByRole('alert')).toBeNull();
});

it('a paused line without a name shows Removed provider, and No provider for the jobs without one', () => {
  render(
    <AppShell
      workspaceName="Studio"
      rootPath="D:/work/studio"
      section="assets"
      busy={false}
      activeJobs={0}
      paused={[
        { providerId: LOCAL_ID, providerName: null, kind: 'ollama', reason: 'provider_not_configured' },
        { providerId: null, providerName: null, kind: 'ollama', reason: 'provider_not_configured' },
      ]}
      onNavigate={() => {}}
      onClose={() => {}}
    >
      <p>content</p>
    </AppShell>,
  );
  const banner = screen.getByRole('alert');
  expect(within(banner).getByRole('group', { name: 'Removed provider' }).textContent).toContain(
    JOB_ERROR_MESSAGES.provider_not_configured,
  );
  expect(within(banner).getByRole('group', { name: 'No provider' })).toBeTruthy();
});

it('the banner shows a failed resume in its line and keeps the pause', async () => {
  const user = userEvent.setup();
  const onResume = vi.fn((_providerId: string | null) => {
    throw fakeError('internal_error');
  });
  const onMove = vi.fn();
  render(
    <AppShell
      workspaceName="Studio"
      rootPath="D:/work/studio"
      section="assets"
      busy={false}
      activeJobs={0}
      paused={[PAUSED_LOCAL]}
      onResume={async (id) => onResume(id)}
      onMove={onMove}
      onNavigate={() => {}}
      onClose={() => {}}
    >
      <p>content</p>
    </AppShell>,
  );
  await user.click(screen.getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).not.toContain(JOB_ERROR_MESSAGES.provider_unreachable));
  expect(onResume).toHaveBeenCalledWith(LOCAL_ID);
  expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Move jobs' }));
  expect(onMove).toHaveBeenCalledWith(LOCAL_ID);
});

it('after the provider lines one line per paused host; Resume resumes that host and refreshes the jobs', async () => {
  const user = userEvent.setup();
  let summary: JobSummary = {
    ...IDLE,
    paused: [PAUSED_LOCAL],
    pausedHosts: [
      { host: 'cdn.example.com', reason: 'download_blocked' },
      { host: 'img.example.org:8443', reason: 'download_throttled' },
    ],
  };
  const { api } = jobsShell(() => summary, {
    'jobs:resumeHost': ({ host }) => {
      summary = { ...summary, pausedHosts: summary.pausedHosts.filter((h) => h.host !== host), changes: summary.changes + 1 };
      return {};
    },
  });
  const banner = await screen.findByRole('alert');
  const groups = within(banner).getAllByRole('group').map((g) => g.getAttribute('aria-label'));
  expect(groups).toEqual(['Local Ollama', 'cdn.example.com', 'img.example.org:8443']);
  const blocked = within(banner).getByRole('group', { name: 'cdn.example.com' });
  const throttled = within(banner).getByRole('group', { name: 'img.example.org:8443' });
  expect(blocked.textContent).toContain(JOB_ERROR_MESSAGES.download_blocked);
  expect(throttled.textContent).toContain(JOB_ERROR_MESSAGES.download_throttled);
  expect(within(throttled).getAllByRole('button').map((b) => b.textContent)).toEqual(['Resume']);
  await user.click(within(throttled).getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(within(screen.getByRole('alert')).queryByRole('group', { name: 'img.example.org:8443' })).toBeNull());
  expect(api.calls.filter((c) => c.channel === 'jobs:resumeHost').map((c) => c.request)).toEqual([{ host: 'img.example.org:8443' }]);
  expect(api.calls.some((c) => c.channel === 'jobs:resume')).toBe(false);
  expect(within(screen.getByRole('alert')).getByRole('group', { name: 'cdn.example.com' })).toBeTruthy();
});

it('a paused host alone shows the banner, and a failed resume shows in its line and keeps it', async () => {
  const user = userEvent.setup();
  const onResumeHost = vi.fn((_host: string) => {
    throw fakeError('internal_error');
  });
  render(
    <AppShell
      workspaceName="Studio"
      rootPath="D:/work/studio"
      section="assets"
      busy={false}
      activeJobs={0}
      pausedHosts={[{ host: 'cdn.example.com', reason: 'download_unreachable' }]}
      onResumeHost={async (host) => onResumeHost(host)}
      onNavigate={() => {}}
      onClose={() => {}}
    >
      <p>content</p>
    </AppShell>,
  );
  const line = within(screen.getByRole('alert')).getByRole('group', { name: 'cdn.example.com' });
  expect(line.textContent).toContain(JOB_ERROR_MESSAGES.download_unreachable);
  await user.click(within(line).getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(line.textContent).not.toContain(JOB_ERROR_MESSAGES.download_unreachable));
  expect(onResumeHost).toHaveBeenCalledWith('cdn.example.com');
  expect(line.textContent).toContain('cdn.example.com');
  expect(within(line).getByRole('button', { name: 'Resume' })).toBeTruthy();
});

it('offers Open site only for a browser check on the site of a profile; it sends the host only and is disabled while it runs', async () => {
  const user = userEvent.setup();
  const summary: JobSummary = {
    ...IDLE,
    pausedHosts: [
      { host: 'example.com', reason: 'download_browser_check' },
      { host: 'cdn.example.org', reason: 'download_browser_check' },
      { host: 'shop.example.net', reason: 'download_blocked' },
    ],
  };
  const opening = deferred<Record<string, never>>();
  const { api } = jobsShell(() => summary, {
    'sites:list': () => ({
      profiles: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          name: 'Shop',
          site: 'example.com',
          thumbnails: '//a',
          pagination: '',
          file: '',
          kinds: ['image'],
          minBytes: 0,
          urlContains: '',
          maxPages: 20,
          maxFiles: 1000,
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          name: 'Other shop',
          site: 'shop.example.net',
          thumbnails: '//a',
          pagination: '',
          file: '',
          kinds: ['image'],
          minBytes: 0,
          urlContains: '',
          maxPages: 20,
          maxFiles: 1000,
        },
      ],
    }),
    'sites:openCheck': () => opening.promise,
  });
  const banner = await screen.findByRole('alert');
  const site = within(banner).getByRole('group', { name: 'example.com' });
  expect(site.textContent).toContain(JOB_ERROR_MESSAGES.download_browser_check);
  const open = await within(site).findByRole('button', { name: 'Open site' });
  expect(within(site).getAllByRole('button').map((b) => b.textContent)).toEqual(['Open site', 'Resume']);
  expect(open.getAttribute('title')).toBe('Opens the site so you can pass its check; Resume then repeats the refused downloads');
  // No profile for that host, or another reason: Resume only.
  expect(within(within(banner).getByRole('group', { name: 'cdn.example.org' })).getAllByRole('button').map((b) => b.textContent)).toEqual([
    'Resume',
  ]);
  expect(within(within(banner).getByRole('group', { name: 'shop.example.net' })).getAllByRole('button').map((b) => b.textContent)).toEqual([
    'Resume',
  ]);

  await user.click(open);
  await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(true));
  expect(api.calls.filter((c) => c.channel === 'sites:openCheck').map((c) => c.request)).toEqual([{ host: 'example.com' }]);
  await act(async () => opening.resolve({}));
  await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
  expect(api.calls.some((c) => c.channel === 'jobs:resumeHost')).toBe(false);
});

it('a failed Open site shows in its line and keeps it', async () => {
  const user = userEvent.setup();
  const onOpenCheck = vi.fn((_host: string) => {
    throw fakeError('invalid_operation', 'Another login window is open');
  });
  render(
    <AppShell
      workspaceName="Studio"
      rootPath="D:/work/studio"
      section="assets"
      busy={false}
      activeJobs={0}
      pausedHosts={[{ host: 'example.com', reason: 'download_browser_check' }]}
      checkHosts={new Set(['example.com'])}
      onOpenCheck={async (host) => onOpenCheck(host)}
      onNavigate={() => {}}
      onClose={() => {}}
    >
      <p>content</p>
    </AppShell>,
  );
  const line = within(screen.getByRole('alert')).getByRole('group', { name: 'example.com' });
  await user.click(within(line).getByRole('button', { name: 'Open site' }));
  await waitFor(() => expect(line.textContent).toContain('Another login window is open'));
  expect(line.textContent).not.toContain(JOB_ERROR_MESSAGES.download_browser_check);
  expect(onOpenCheck).toHaveBeenCalledWith('example.com');
  expect(within(line).getByRole('button', { name: 'Open site' })).toBeTruthy();
});

it('sameSummary compares the pause list entry by entry', () => {
  expect(sameSummary({ ...IDLE, paused: [PAUSED_LOCAL] }, { ...IDLE, paused: [{ ...PAUSED_LOCAL }] })).toBe(true);
  expect(sameSummary({ ...IDLE, paused: [PAUSED_LOCAL] }, { ...IDLE, paused: [{ ...PAUSED_LOCAL, reason: 'provider_unauthorized' }] })).toBe(false);
  expect(sameSummary({ ...IDLE, paused: [PAUSED_LOCAL] }, { ...IDLE, paused: [{ ...PAUSED_LOCAL, providerName: 'Local' }] })).toBe(false);
  expect(sameSummary({ ...IDLE, paused: [PAUSED_LOCAL] }, { ...IDLE, paused: [PAUSED_LOCAL, PAUSED_RUNPOD] })).toBe(false);
  expect(sameSummary(IDLE, { ...IDLE, paused: [PAUSED_LOCAL] })).toBe(false);
  expect(sameSummary(IDLE, { ...IDLE, failed: 1 })).toBe(false);
  const host = { host: 'example.com', reason: 'download_blocked' } as const;
  expect(sameSummary({ ...IDLE, pausedHosts: [host] }, { ...IDLE, pausedHosts: [{ ...host }] })).toBe(true);
  expect(sameSummary({ ...IDLE, pausedHosts: [host] }, { ...IDLE, pausedHosts: [{ ...host, reason: 'download_throttled' }] })).toBe(false);
  expect(sameSummary(IDLE, { ...IDLE, pausedHosts: [host] })).toBe(false);
});

/** The inbox of the workspace shell with one image that has a tag proposal; the provider is not configured. */
async function inboxWithProposal(handlers: FakeHandlers = {}) {
  const user = userEvent.setup();
  const file = fileRecord({ originalName: 'fox.png', hasProposal: true });
  const api = workspaceShell(() => IDLE, () => {}, {
    'files:list': () => pageOf([file]),
    'tags:suggest': () => [],
    'analysis:getProposal': () => ({ proposal: null, job: null }),
    ...handlers,
  });
  await user.click(screen.getByRole('link', { name: /Inbox/ }));
  const listbox = await screen.findByRole('listbox', { name: 'Files' });
  const tile = within(listbox).getByText('fox.png').closest<HTMLElement>('[data-index]')!;
  return { user, api, tile };
}

it('Settings in a dialog closes it and the detail dialog beneath, then shows the settings screen', async () => {
  const { user, tile } = await inboxWithProposal();
  await user.click(tile);
  await user.keyboard('{Enter}');
  const detail = await screen.findByRole('dialog', { name: 'fox.png' });
  await user.click(within(detail).getByRole('button', { name: 'More' }));
  await user.click(screen.getByRole('menuitem', { name: 'Review tags' }));
  await waitFor(() => expect(screen.getAllByRole('dialog', { name: 'fox.png' })).toHaveLength(2));
  const [, result] = screen.getAllByRole('dialog', { name: 'fox.png' });
  await user.click(await within(result!).findByRole('button', { name: 'Settings' }));
  expect(await screen.findByRole('heading', { level: 2, name: 'Settings' })).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
});

it('while an import runs Settings in a dialog is disabled like the navigation and nothing closes', async () => {
  const pick = deferred<string[]>();
  const { user, tile } = await inboxWithProposal({ 'dialog:pickFiles': () => pick.promise });
  await user.click(screen.getByRole('button', { name: 'Import files' }));
  await waitFor(() => expect(screen.getByRole('link', { name: /Assets/ }).getAttribute('aria-disabled')).toBe('true'));
  await user.click(within(tile).getByRole('button', { name: 'File actions' }));
  await user.click(screen.getByRole('menuitem', { name: 'Review tags' }));
  const result = await screen.findByRole('dialog', { name: 'fox.png' });
  const settings = (await within(result).findByRole('button', { name: 'Settings' })) as HTMLButtonElement;
  expect(settings.disabled).toBe(true);
  expect(settings.title).toBe(screen.getByRole('link', { name: /Assets/ }).getAttribute('title'));
  await user.click(settings);
  expect(screen.getByRole('dialog', { name: 'fox.png' })).toBe(result);
  expect(screen.queryByRole('heading', { level: 2, name: 'Settings' })).toBeNull();
  await act(async () => pick.resolve([]));
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

it('Prompts follows Projects and Trash follows Inbox in the navigation', () => {
  render(shell({}));
  const names = within(screen.getByRole('navigation', { name: 'Main' }))
    .getAllByRole('link')
    .map((link) => link.textContent);
  expect(names).toEqual(['Assets', 'Projects', 'Prompts', 'Inbox', 'Trash', 'Jobs', 'Settings']);
});

it('the trash entry shows its count and names it "Trash, 3 files"', async () => {
  const user = userEvent.setup();
  const onNavigate = vi.fn();
  const { rerender } = render(shell({ trashCount: 3, onNavigate }));
  const entry = screen.getByRole('link', { name: 'Trash, 3 files' });
  expect(entry.textContent).toBe('Trash3');
  await user.click(entry);
  expect(onNavigate).toHaveBeenCalledWith('trash');
  rerender(shell({ trashCount: 1, onNavigate }));
  expect(screen.getByRole('link', { name: 'Trash, 1 file' })).toBeTruthy();
});

it('no badge for an empty trash', () => {
  const { rerender } = render(shell({ trashCount: 0 }));
  expect(screen.getByRole('link', { name: 'Trash' }).textContent).toBe('Trash');
  rerender(shell({ trashCount: null }));
  expect(screen.getByRole('link', { name: 'Trash' }).textContent).toBe('Trash');
});

it('navigating to Trash renders the trash screen', async () => {
  const user = userEvent.setup();
  const api = workspaceShell(() => IDLE, () => {}, {
    'trash:summary': () => ({ count: 1 }),
    'files:list': () => pageOf([trashedRecord({ originalName: 'gone.png' })]),
    'tags:suggest': () => [],
  });
  await user.click(await screen.findByRole('link', { name: 'Trash, 1 file' }));
  await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: /Trash/ }).textContent).toBe('Trash1'));
  expect(await screen.findByText('gone.png')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Trash, 1 file' }).getAttribute('aria-current')).toBe('page');
  const scopes = api.calls.filter((c) => c.channel === 'files:list').map((c) => (c.request as { scope: unknown }).scope);
  expect(scopes.length).toBeGreaterThan(0);
  expect(scopes.every((scope) => (scope as { kind: string }).kind === 'trash')).toBe(true);
});

it('the trash filters survive leaving and returning', async () => {
  const user = userEvent.setup();
  const api = workspaceShell(() => IDLE, () => {}, {
    'files:list': () => pageOf([]),
    'tags:suggest': () => [],
  });
  await user.click(screen.getByRole('link', { name: 'Trash' }));
  await user.type(await screen.findByRole('searchbox', { name: 'Search files' }), 'hero');
  await waitFor(() =>
    expect(api.calls.filter((c) => c.channel === 'files:list').at(-1)?.request).toMatchObject({
      scope: { kind: 'trash' },
      query: 'hero',
    }),
  );
  await user.click(screen.getByRole('link', { name: /Assets/ }));
  await screen.findByRole('heading', { level: 2, name: /Assets/ });
  await user.click(screen.getByRole('link', { name: 'Trash' }));
  expect(((await screen.findByRole('searchbox', { name: 'Search files' })) as HTMLInputElement).value).toBe('hero');
});

it('deleting a file in the inbox raises the count in the navigation', async () => {
  const user = userEvent.setup();
  const file = fileRecord({ originalName: 'fox.png' });
  let count = 0;
  let inbox = [file];
  workspaceShell(() => IDLE, () => {}, {
    'trash:summary': () => ({ count }),
    'files:list': () => pageOf(inbox),
    'tags:suggest': () => [],
    'files:trashMany': ({ fileIds }) => {
      count += fileIds.length;
      inbox = inbox.filter((f) => !fileIds.includes(f.id));
      return { items: fileIds.map((fileId) => ({ fileId, file: { ...file, deletedAt: '2026-01-02T00:00:00.000Z' }, error: null })) };
    },
  });
  await user.click(screen.getByRole('link', { name: /Inbox/ }));
  const listbox = await screen.findByRole('listbox', { name: 'Files' });
  const tile = within(listbox).getByText('fox.png').closest<HTMLElement>('[data-index]')!;
  expect(screen.getByRole('link', { name: 'Trash' }).textContent).toBe('Trash');
  await user.click(within(tile).getByRole('button', { name: 'File actions' }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  expect(await screen.findByRole('link', { name: 'Trash, 1 file' })).toBeTruthy();
});

it('a rename on the asset screen rewrites the gallery filter that is not mounted', async () => {
  const user = userEvent.setup();
  const summary = assetSummary({ name: 'Oak tree', tags: [tagOf('Front View')] });
  const { projectCount: _p, fileCount: _f, workflowProgress: _w, coverTags: _c, ...detail } = summary;
  const api = workspaceShell(() => IDLE, () => {}, {
    'assets:list': () => pageOf([summary]),
    'assets:get': () => ({ ...detail, coverIsChosen: false, sources: [] }),
    'assignments:listByAsset': () => [],
    'relations:list': () => [],
    'files:list': () => pageOf([]),
    'workflows:get': () => null,
    'workflowTemplates:list': () => [],
    'tags:suggest': () => [],
    ...renameHandlers({ 'front view': 'Front View' }),
  });
  await user.type(await screen.findByRole('combobox', { name: 'Tags' }), 'front view{Enter}');
  expect(await screen.findByRole('button', { name: 'Remove front view' })).toBeTruthy();
  const grid = await screen.findByRole('grid', { name: 'Assets' });
  await user.dblClick((await within(grid).findByText('Oak tree')).closest<HTMLElement>('[data-index]')!);
  await screen.findByRole('group', { name: 'Asset tags' });
  await renameThroughDialog(user, 'Front View', 'Front');
  await user.click(screen.getAllByRole('link', { name: 'Assets' })[0]!);
  expect(await screen.findByRole('button', { name: 'Remove front' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Remove front view' })).toBeNull();
  await waitFor(() =>
    expect(
      api.calls.some((c) => c.channel === 'assets:list' && (c.request as { tagNames?: string[] }).tagNames?.join() === 'front'),
    ).toBe(true),
  );
});

it('a dirty prompt draft asks before the main navigation leaves; cancel stays, discard leaves', async () => {
  const user = userEvent.setup();
  workspaceShell(() => IDLE, () => {}, { 'tags:suggest': () => [], ...fakePrompts([promptDetail({ title: 'Hero' })]).handlers });
  await user.click(screen.getByRole('link', { name: 'Prompts' }));
  expect(screen.getByRole('link', { name: 'Prompts' }).getAttribute('aria-current')).toBe('page');
  const listbox = await screen.findByRole('listbox', { name: 'Prompts' });
  await user.click(await within(listbox).findByText('Hero'));
  const editor = screen.getByRole('region', { name: 'Prompt' });
  const title = await within(editor).findByDisplayValue('Hero');
  await user.type(title, ' shot');

  await user.click(screen.getByRole('link', { name: 'Assets' }));
  const ask = await screen.findByRole('dialog', { name: 'Discard the unsaved changes?' });
  await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('link', { name: 'Prompts' }).getAttribute('aria-current')).toBe('page');
  expect(within(editor).getByDisplayValue('Hero shot')).toBeTruthy();

  await user.click(screen.getByRole('link', { name: 'Assets' }));
  await user.click(within(await screen.findByRole('dialog', { name: 'Discard the unsaved changes?' })).getByRole('button', { name: 'Discard' }));
  await waitFor(() => expect(screen.getByRole('link', { name: 'Assets' }).getAttribute('aria-current')).toBe('page'));
});
