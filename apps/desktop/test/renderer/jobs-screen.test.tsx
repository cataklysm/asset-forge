import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ANALYZE_FILE_JOB,
  FILE_DOWNLOAD_JOB,
  IMAGE_GENERATE_JOB,
  type Changes,
  type IpcRequest,
  type JobSummary,
  type JobView,
} from '@assetforge/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { formatDateTime } from '../../src/renderer/src/format';
import { JOB_POLL_MS, JobsProvider } from '../../src/renderer/src/jobs-context';
import { ProviderSettingsProvider } from '../../src/renderer/src/provider-context';
import { JobsScreen } from '../../src/renderer/src/screens/JobsScreen';
import {
  deferred,
  fakeError,
  fakeProviders,
  installFakeApi,
  noChanges,
  providerView,
  type FakeHandlers,
} from './fake-api';
import { nextId, pageOf } from './fixtures';

afterEach(() => {
  vi.useRealTimers();
});

const CREATED = '2026-01-01T10:00:00.000Z';
const RUN_AFTER = '2026-01-01T10:05:00.000Z';

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

function job(p: Partial<JobView> = {}): JobView {
  return {
    id: nextId(),
    type: ANALYZE_FILE_JOB,
    status: 'queued',
    attempt: 0,
    fileId: nextId(),
    fileName: 'rock.png',
    errorCode: null,
    errorMessage: null,
    createdAt: CREATED,
    startedAt: null,
    finishedAt: null,
    runAfter: null,
    providerId: null,
    providerName: null,
    model: null,
    url: null,
    host: null,
    result: null,
    ...p,
  };
}

type ListRequest = IpcRequest<'jobs:list'>;

function listOf(items: JobView[]) {
  return (request: ListRequest) => {
    const matching = items.filter(
      (j) =>
        (request.ids === undefined || request.ids.includes(j.id)) &&
        (request.status === undefined || j.status === request.status) &&
        (request.providerId === undefined || j.providerId === request.providerId),
    );
    return pageOf(matching.slice(request.offset, request.offset + request.limit), matching.length);
  };
}

function install(handlers: FakeHandlers, summary: JobSummary = IDLE) {
  return installFakeApi({
    'jobs:summary': () => summary,
    'jobs:list': listOf([]),
    ...handlers,
  });
}

function renderScreen() {
  return render(
    <JobsProvider>
      <ProviderSettingsProvider>
        <JobsScreen />
      </ProviderSettingsProvider>
    </JobsProvider>,
  );
}

const listCalls = (api: ReturnType<typeof installFakeApi>) => api.calls.filter((c) => c.channel === 'jobs:list');

function rowOf(name: string): HTMLElement {
  const cell = screen.getAllByRole('gridcell').find((c) => c.textContent === name);
  if (cell === undefined) throw new Error(`no row with ${name}`);
  return cell.closest<HTMLElement>('[role="row"]')!;
}

it('shows the seven columns of a running, a retrying and a failed job', async () => {
  const running = job({ status: 'running', attempt: 1, fileName: 'running.png' });
  const retrying = job({ status: 'retry_wait', attempt: 2, fileName: 'retrying.png', runAfter: RUN_AFTER });
  const failed = job({
    status: 'failed',
    attempt: 3,
    fileName: null,
    type: 'other.kind',
    errorCode: 'provider_unreachable',
    errorMessage: 'The provider could not be reached',
  });
  install({ 'jobs:list': listOf([running, retrying, failed]) }, { ...IDLE, running: 1, waiting: 1, failed: 1 });
  renderScreen();

  expect(await screen.findByText('running.png')).toBeTruthy();
  expect(screen.getByRole('heading', { level: 2, name: /Jobs/ })).toBeTruthy();
  await waitFor(() => expect(screen.getByTitle('Jobs in this workspace').textContent).toBe('3'));
  expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
    'Job',
    'File',
    'Provider',
    'Status',
    'Attempt',
    'Created',
    'Error',
    '',
  ]);

  const cells = (row: HTMLElement) =>
    within(row)
      .getAllByRole('gridcell')
      .map((c) => c.textContent);
  expect(cells(rowOf('running.png'))).toEqual([
    'Analysis',
    'running.png',
    'No provider',
    'Running',
    '1 / 3',
    formatDateTime(CREATED),
    '',
    '',
  ]);
  expect(cells(rowOf('retrying.png'))).toEqual([
    'Analysis',
    'retrying.png',
    'No provider',
    'Retrying',
    '2 / 3',
    formatDateTime(CREATED),
    '',
    '',
  ]);
  expect(within(rowOf('retrying.png')).getByText('Retrying').closest('[title]')?.getAttribute('title')).toBe(
    `Next try at ${formatDateTime(RUN_AFTER)}`,
  );
  expect(cells(rowOf('other.kind'))).toEqual([
    'other.kind',
    '—',
    '—',
    'Failed',
    '3 / 3',
    formatDateTime(CREATED),
    'The provider could not be reached',
    '',
  ]);
});

it('a generation job is labelled Generation', async () => {
  install({ 'jobs:list': listOf([job({ type: IMAGE_GENERATE_JOB, fileName: 'oak.png' })]) });
  renderScreen();
  await screen.findByText('oak.png');
  expect(within(rowOf('oak.png')).getAllByRole('gridcell')[0]!.textContent).toBe('Generation');
});

it('a download job without a file shows the shortened URL, the full one in the tooltip, and the host', async () => {
  const url = 'https://cdn.example.com:8443/packs/2026/rock%20moss.png?sig=abc';
  install({
    'jobs:list': listOf([
      job({ type: FILE_DOWNLOAD_JOB, fileId: null, fileName: null, url, host: 'cdn.example.com:8443' }),
    ]),
  });
  renderScreen();
  const cell = await screen.findByText('cdn.example.com:8443/rock moss.png');
  expect(cell.getAttribute('title')).toBe(url);
  const cells = within(cell.closest<HTMLElement>('[role="row"]')!).getAllByRole('gridcell');
  expect(cells[0]!.textContent).toBe('Download');
  expect(cells[2]!.textContent).toBe('cdn.example.com:8443');
  expect(cells[3]!.textContent).toBe('Queued');
});

it('a download job with a file shows the file name; an already present one says so in its status', async () => {
  install({
    'jobs:list': listOf([
      job({
        type: FILE_DOWNLOAD_JOB,
        status: 'succeeded',
        attempt: 1,
        fileName: 'rock.png',
        url: 'https://example.com/rock.png',
        host: 'example.com',
        result: 'already_present',
      }),
      job({
        type: FILE_DOWNLOAD_JOB,
        status: 'succeeded',
        attempt: 1,
        fileName: 'moss.png',
        url: 'https://example.com/moss.png',
        host: 'example.com',
      }),
    ]),
  });
  renderScreen();
  await screen.findByText('rock.png');
  const cells = (name: string) =>
    within(rowOf(name))
      .getAllByRole('gridcell')
      .map((c) => c.textContent);
  expect(cells('rock.png').slice(0, 4)).toEqual(['Download', 'rock.png', 'example.com', 'Already present']);
  expect(cells('moss.png').slice(0, 4)).toEqual(['Download', 'moss.png', 'example.com', 'Done']);
});

it.each([
  ['filtered_kind', 'Filtered: kind'],
  ['filtered_size', 'Filtered: below minimum size'],
  ['filtered', 'Filtered'],
] as const)('a download the site profile left out (%s) says why in its status', async (result, text) => {
  install({
    'jobs:list': listOf([
      job({
        type: FILE_DOWNLOAD_JOB,
        status: 'succeeded',
        attempt: 1,
        fileId: null,
        fileName: null,
        url: 'https://example.com/small.png',
        host: 'example.com',
        result,
      }),
    ]),
  });
  renderScreen();
  const cell = await screen.findByText('example.com/small.png');
  const cells = within(cell.closest<HTMLElement>('[role="row"]')!)
    .getAllByRole('gridcell')
    .map((c) => c.textContent);
  expect(cells.slice(0, 4)).toEqual(['Download', 'example.com/small.png', 'example.com', text]);
});

it('the shortened URL is at most 60 characters, and an address that does not parse is cut to 60', async () => {
  const long = `https://example.com/${'a'.repeat(80)}.png`;
  const broken = `not a url ${'b'.repeat(80)}`;
  install({
    'jobs:list': listOf([
      job({ type: FILE_DOWNLOAD_JOB, fileName: null, url: long, host: 'example.com' }),
      job({ type: FILE_DOWNLOAD_JOB, fileName: null, url: broken, host: null }),
    ]),
  });
  renderScreen();
  const shortLong = `example.com/${'a'.repeat(80)}.png`.slice(0, 60);
  const longCell = await screen.findByText(shortLong);
  expect(longCell.getAttribute('title')).toBe(long);
  const brokenCell = screen.getByText(broken.slice(0, 60));
  expect(brokenCell.getAttribute('title')).toBe(broken);
  expect(within(brokenCell.closest<HTMLElement>('[role="row"]')!).getAllByRole('gridcell')[2]!.textContent).toBe('—');
});

it('the status filter asks for that status and offers All plus the seven labels', async () => {
  const user = userEvent.setup();
  const failed = job({ status: 'failed', fileName: 'failed.png', errorMessage: 'x' });
  const api = install({ 'jobs:list': listOf([job({ fileName: 'queued.png' }), failed]) });
  renderScreen();
  await screen.findByText('queued.png');

  const select = screen.getByRole('combobox', { name: 'Status' });
  expect(
    within(select)
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual(['All', 'Queued', 'Running', 'Retrying', 'Waiting', 'Done', 'Failed', 'Cancelled']);
  await user.selectOptions(select, 'Failed');
  await waitFor(() => expect(screen.queryByText('queued.png')).toBeNull());
  expect(screen.getByText('failed.png')).toBeTruthy();
  const last = listCalls(api).at(-1)!.request as ListRequest;
  expect(last.status).toBe('failed');
  expect(last.offset).toBe(0);
});

it('Cancel job exists only on active rows and cancels that job', async () => {
  const user = userEvent.setup();
  const jobs = [
    job({ status: 'queued', fileName: 'queued.png' }),
    job({ status: 'running', fileName: 'running.png' }),
    job({ status: 'retry_wait', fileName: 'retry.png', runAfter: RUN_AFTER }),
    job({ status: 'waiting_remote', fileName: 'remote.png' }),
    job({ status: 'succeeded', fileName: 'done.png' }),
    job({ status: 'failed', fileName: 'failed.png' }),
    job({ status: 'cancelled', fileName: 'cancelled.png' }),
  ];
  const cancelled: string[] = [];
  const api = install({
    'jobs:list': listOf(jobs),
    'jobs:cancel': ({ jobId }) => {
      cancelled.push(jobId);
      return {};
    },
  });
  renderScreen();
  await screen.findByText('queued.png');

  for (const name of ['queued.png', 'running.png', 'retry.png', 'remote.png'])
    expect(within(rowOf(name)).getByRole('button', { name: 'Cancel job' }).getAttribute('title')).toBe('Cancel job');
  for (const name of ['done.png', 'failed.png', 'cancelled.png'])
    expect(within(rowOf(name)).queryByRole('button', { name: 'Cancel job' })).toBeNull();

  const before = listCalls(api).length;
  await user.click(within(rowOf('running.png')).getByRole('button', { name: 'Cancel job' }));
  expect(cancelled).toEqual([jobs[1]!.id]);
  await waitFor(() => expect(listCalls(api).length).toBeGreaterThan(before));
});

it('Retry job exists only on failed and cancelled rows and retries that job', async () => {
  const user = userEvent.setup();
  const jobs = [
    job({ status: 'queued', fileName: 'queued.png' }),
    job({ status: 'running', fileName: 'running.png' }),
    job({ status: 'retry_wait', fileName: 'retry.png' }),
    job({ status: 'waiting_remote', fileName: 'remote.png' }),
    job({ status: 'succeeded', fileName: 'done.png' }),
    job({ status: 'failed', fileName: 'failed.png' }),
    job({ status: 'cancelled', fileName: 'cancelled.png' }),
  ];
  const retried: string[] = [];
  const api = install({
    'jobs:list': listOf(jobs),
    'jobs:retry': ({ jobId }) => {
      retried.push(jobId);
      return {};
    },
  });
  renderScreen();
  await screen.findByText('queued.png');

  for (const name of ['failed.png', 'cancelled.png'])
    expect(within(rowOf(name)).getByRole('button', { name: 'Retry job' }).getAttribute('title')).toBe('Retry job');
  for (const name of ['queued.png', 'running.png', 'retry.png', 'remote.png', 'done.png'])
    expect(within(rowOf(name)).queryByRole('button', { name: 'Retry job' })).toBeNull();

  const before = listCalls(api).length;
  await user.click(within(rowOf('cancelled.png')).getByRole('button', { name: 'Retry job' }));
  expect(retried).toEqual([jobs[6]!.id]);
  await waitFor(() => expect(listCalls(api).length).toBeGreaterThan(before));
});

it('the page actions are disabled for an all-zero summary', async () => {
  install({ 'jobs:list': listOf([job()]) });
  renderScreen();
  await screen.findByText('rock.png');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel all' })).toBeTruthy());
  for (const name of ['Cancel all', 'Retry failed', 'Clear finished'])
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
});

it.each([
  [{ queued: 1 }, 'Cancel all'],
  [{ running: 1 }, 'Cancel all'],
  [{ waiting: 1 }, 'Cancel all'],
  [{ failed: 1 }, 'Retry failed'],
  [{ cancelled: 1 }, 'Retry failed'],
  [{ succeeded: 1 }, 'Clear finished'],
] as const)('%o enables %s and only the actions it counts for', async (counts, name) => {
  install({ 'jobs:list': listOf([job()]) }, { ...IDLE, ...counts });
  renderScreen();
  await waitFor(() => expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false));
  const finished = 'failed' in counts || 'cancelled' in counts;
  const expected: Record<string, boolean> = {
    'Cancel all': name === 'Cancel all',
    'Retry failed': name === 'Retry failed',
    // Failed and cancelled jobs are finished too.
    'Clear finished': name === 'Clear finished' || finished,
  };
  for (const [button, enabled] of Object.entries(expected))
    expect((screen.getByRole('button', { name: button }) as HTMLButtonElement).disabled).toBe(!enabled);
});

it.each([
  ['Cancel all', 'jobs:cancelAll', { cancelled: 1 }],
  ['Retry failed', 'jobs:retryFailed', { retried: 1 }],
  ['Clear finished', 'jobs:clearFinished', { removed: 1 }],
] as const)('%s calls %s, polls the summary and reloads the list', async (name, channel, answer) => {
  const user = userEvent.setup();
  const api = install(
    { 'jobs:list': listOf([job()]), [channel]: () => answer },
    { ...IDLE, queued: 1, failed: 1, succeeded: 1 },
  );
  renderScreen();
  await screen.findByText('rock.png');
  const button = screen.getByRole('button', { name }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  const lists = listCalls(api).length;
  const summaries = api.calls.filter((c) => c.channel === 'jobs:summary').length;
  await user.click(button);
  expect(api.calls.filter((c) => c.channel === channel)).toHaveLength(1);
  await waitFor(() => expect(listCalls(api).length).toBeGreaterThan(lists));
  expect(api.calls.filter((c) => c.channel === 'jobs:summary').length).toBeGreaterThan(summaries);
});

it('a page button that lost the focus while its action ran gets it back', async () => {
  const user = userEvent.setup();
  const pending = deferred<{ cancelled: number }>();
  install(
    { 'jobs:list': listOf([job()]), 'jobs:cancelAll': () => pending.promise },
    { ...IDLE, queued: 1, failed: 1, succeeded: 1 },
  );
  renderScreen();
  await screen.findByText('rock.png');
  const button = screen.getByRole('button', { name: 'Cancel all' }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  button.focus();
  await user.keyboard('{Enter}');
  expect(button.disabled).toBe(true);
  // A browser drops the focus of a disabled button to the body; jsdom does not, so it is done here.
  button.blur();
  expect(document.activeElement).toBe(document.body);
  await act(async () => {
    pending.resolve({ cancelled: 1 });
    await pending.promise;
  });
  await waitFor(() => expect(button.disabled).toBe(false));
  expect(document.activeElement).toBe(button);
});

it('a page button the owner left after its focus came back is not focused again by a later poll', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const pending = deferred<{ cancelled: number }>();
  let summary: JobSummary = { ...IDLE, queued: 1, failed: 1, succeeded: 1, changes: 1 };
  const api = install({ 'jobs:list': listOf([job()]), 'jobs:cancelAll': () => pending.promise });
  api.set('jobs:summary', () => summary);
  renderScreen();
  await screen.findByText('rock.png');
  const button = screen.getByRole('button', { name: 'Cancel all' }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  button.focus();
  await user.keyboard('{Enter}');
  button.blur();
  await act(async () => {
    pending.resolve({ cancelled: 1 });
    await pending.promise;
  });
  await waitFor(() => expect(document.activeElement).toBe(button));
  button.blur();
  expect(document.activeElement).toBe(document.body);
  summary = { ...IDLE, queued: 1, changes: 2 };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
  });
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Clear finished' }) as HTMLButtonElement).disabled).toBe(true),
  );
  expect(document.activeElement).toBe(document.body);
});

it('a page button that the summary after its action disables hands the focus to the first enabled page button', async () => {
  const user = userEvent.setup();
  let summary: JobSummary = { ...IDLE, failed: 1, changes: 1 };
  const api = install({
    'jobs:list': listOf([job({ status: 'failed', fileName: 'failed.png' })]),
    'jobs:retryFailed': () => {
      summary = { ...IDLE, queued: 1, changes: 2 };
      return { retried: 1 };
    },
  });
  api.set('jobs:summary', () => summary);
  renderScreen();
  await screen.findByText('failed.png');
  const button = screen.getByRole('button', { name: 'Retry failed' }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  button.focus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(button.disabled).toBe(true));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move jobs' })));
});

it('a rejected retry shows the alert above the table', async () => {
  const user = userEvent.setup();
  install({
    'jobs:list': listOf([job({ status: 'failed', fileName: 'failed.png' })]),
    'jobs:retry': () => {
      throw fakeError('invalid_operation');
    },
  });
  renderScreen();
  await screen.findByText('failed.png');
  await user.click(screen.getByRole('button', { name: 'Retry job' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('invalid_operation');
  expect(
    alert.compareDocumentPosition(screen.getByRole('grid', { name: 'Jobs' })) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it('a rejected action still polls the summary and reloads the list', async () => {
  const user = userEvent.setup();
  const api = install(
    {
      'jobs:list': listOf([job()]),
      'jobs:cancelAll': () => {
        throw fakeError('invalid_operation');
      },
    },
    { ...IDLE, queued: 1 },
  );
  renderScreen();
  await screen.findByText('rock.png');
  const button = screen.getByRole('button', { name: 'Cancel all' }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  const lists = listCalls(api).length;
  const summaries = api.calls.filter((c) => c.channel === 'jobs:summary').length;
  await user.click(button);
  expect(await screen.findByRole('alert')).toBeTruthy();
  await waitFor(() => expect(listCalls(api).length).toBeGreaterThan(lists));
  expect(api.calls.filter((c) => c.channel === 'jobs:summary').length).toBeGreaterThan(summaries);
});

/** 200 queued jobs named `job <n>.png`, newest first as the list answers them. */
const manyJobs = () => Array.from({ length: 200 }, (_, i) => job({ fileName: `job ${i}.png` }));

it('a reload after an action keeps the scroll position of the table', async () => {
  const user = userEvent.setup();
  const api = install(
    { 'jobs:list': listOf(manyJobs()), 'jobs:cancelAll': () => ({ cancelled: 0 }) },
    {
      ...IDLE,
      queued: 200,
    },
  );
  renderScreen();
  await screen.findByText('job 0.png');
  const grid = screen.getByRole('grid', { name: 'Jobs' });
  // Row 100 of 48 px at the top.
  Object.defineProperty(grid, 'scrollTop', { configurable: true, value: 4800 });
  fireEvent.scroll(grid);
  await screen.findByText('job 100.png');
  const button = screen.getByRole('button', { name: 'Cancel all' }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  api.calls.length = 0;
  await user.click(button);
  await waitFor(() => expect(listCalls(api).map((c) => (c.request as ListRequest).offset)).toContain(60));
  expect(await screen.findByText('job 100.png')).toBeTruthy();
  expect(screen.queryByText('job 0.png')).toBeNull();
});

it('a status change starts the table at the top again', async () => {
  const user = userEvent.setup();
  const api = install({ 'jobs:list': listOf(manyJobs()) });
  renderScreen();
  await screen.findByText('job 0.png');
  const grid = screen.getByRole('grid', { name: 'Jobs' });
  Object.defineProperty(grid, 'scrollTop', { configurable: true, value: 4800 });
  fireEvent.scroll(grid);
  await screen.findByText('job 100.png');
  api.calls.length = 0;
  await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Queued');
  await waitFor(() => expect(listCalls(api).length).toBeGreaterThan(0));
  expect(await screen.findByText('job 0.png')).toBeTruthy();
  expect((listCalls(api)[0]!.request as ListRequest).offset).toBe(0);
  expect(screen.queryByText('job 100.png')).toBeNull();
});

it('a second click while an action runs sends nothing and the page actions wait for it', async () => {
  const user = userEvent.setup();
  const pending = deferred<Record<string, never>>();
  let retries = 0;
  const api = install(
    {
      'jobs:list': listOf([job({ status: 'failed', fileName: 'failed.png' })]),
      'jobs:retry': () => {
        retries += 1;
        if (retries === 1) return pending.promise;
        throw fakeError('invalid_operation');
      },
    },
    { ...IDLE, queued: 1, failed: 1, succeeded: 1 },
  );
  renderScreen();
  await screen.findByText('failed.png');
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Cancel all' }) as HTMLButtonElement).disabled).toBe(false),
  );

  const retry = screen.getByRole('button', { name: 'Retry job' });
  await user.click(retry);
  await user.click(retry);
  for (const name of ['Cancel all', 'Retry failed', 'Clear finished'])
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);

  const lists = listCalls(api).length;
  await act(async () => {
    pending.resolve({});
    await pending.promise;
  });
  await waitFor(() => expect(listCalls(api).length).toBeGreaterThan(lists));
  expect(api.calls.filter((c) => c.channel === 'jobs:retry')).toHaveLength(1);
  expect(screen.queryByRole('alert')).toBeNull();
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Cancel all' }) as HTMLButtonElement).disabled).toBe(false),
  );
});

/** The screen under a job provider whose next poll moves and answers `p` from `changes:since` (see `change`). */
function withFeed(initial: JobView[], status?: JobSummary) {
  let summary: JobSummary = status ?? { ...IDLE, queued: 1, changes: 1 };
  let jobs = initial;
  let changes = noChanges();
  const api = installFakeApi({
    'jobs:summary': () => summary,
    'jobs:list': (request) => listOf(jobs)(request),
    'changes:since': () => changes,
  });
  return {
    api,
    setJobs(next: JobView[]) {
      jobs = next;
    },
    async change(p: Partial<Changes>) {
      summary = { ...summary, changes: summary.changes + 1 };
      changes = noChanges(p);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
      });
      changes = noChanges();
    },
  };
}

it('a changed job of the feed patches its row with one read of its id, in the same table', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const first = job({ fileName: 'first.png' });
  const other = job({ fileName: 'other.png' });
  const feed = withFeed([first, other]);
  renderScreen();
  await screen.findByText('first.png');
  const grid = screen.getByRole('grid', { name: 'Jobs' });
  expect(within(rowOf('first.png')).getByText('Queued')).toBeTruthy();

  feed.setJobs([{ ...first, status: 'running', attempt: 1 }, other]);
  feed.api.calls.length = 0;
  await feed.change({ jobIds: [first.id] });
  await waitFor(() => expect(within(rowOf('first.png')).getByText('Running')).toBeTruthy());
  expect(listCalls(feed.api).map((c) => c.request)).toEqual([{ ids: [first.id], offset: 0, limit: 1 }]);
  expect(screen.getByRole('grid', { name: 'Jobs' })).toBe(grid);

  // A job that is not loaded is not read.
  feed.api.calls.length = 0;
  await feed.change({ jobIds: [nextId()] });
  expect(listCalls(feed.api)).toEqual([]);
});

it('jobs changed in bulk (and a reset) refetch the visible page in place, keeping the rows meanwhile', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const first = job({ fileName: 'first.png' });
  const feed = withFeed([first]);
  renderScreen();
  await screen.findByText('first.png');
  const grid = screen.getByRole('grid', { name: 'Jobs' });

  const page = deferred<{ items: JobView[]; total: number }>();
  const second = job({ fileName: 'second.png' });
  feed.api.set('jobs:list', () => page.promise);
  feed.api.calls.length = 0;
  await feed.change({ jobs: true });
  expect(listCalls(feed.api).map((c) => c.request)).toEqual([{ offset: 0, limit: 60 }]);
  // The old rows stay until the answer arrives.
  expect(screen.getByText('first.png')).toBeTruthy();
  expect(grid.querySelector('[aria-busy="true"]')).toBeNull();
  await act(async () => page.resolve(pageOf([second, first], 2)));
  expect(await screen.findByText('second.png')).toBeTruthy();
  expect(screen.getByText('first.png')).toBeTruthy();
  expect(screen.getByRole('grid', { name: 'Jobs' })).toBe(grid);

  const third = job({ fileName: 'third.png' });
  feed.api.set('jobs:list', listOf([third, second, first]));
  await feed.change({ reset: true });
  expect(await screen.findByText('third.png')).toBeTruthy();
  expect(screen.getByRole('grid', { name: 'Jobs' })).toBe(grid);
});

it('an empty table shows the jobs added in bulk', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const feed = withFeed([]);
  renderScreen();
  expect(await screen.findByText('No jobs')).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  feed.setJobs([job({ fileName: 'new.png' })]);
  feed.api.calls.length = 0;
  await feed.change({ jobs: true });
  expect(await screen.findByText('new.png')).toBeTruthy();
  expect(listCalls(feed.api).map((c) => c.request)).toEqual([{ offset: 0, limit: 60 }]);
});

it('a failed id read refetches the visible page instead', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const first = job({ fileName: 'first.png' });
  const feed = withFeed([first]);
  renderScreen();
  await screen.findByText('first.png');
  feed.api.set('jobs:list', (request) =>
    request.ids !== undefined
      ? Promise.reject(new Error('boom'))
      : listOf([{ ...first, status: 'running', attempt: 1 }])(request),
  );
  feed.api.calls.length = 0;
  await feed.change({ jobIds: [first.id] });
  await waitFor(() => expect(within(rowOf('first.png')).getByText('Running')).toBeTruthy());
  expect(listCalls(feed.api).map((c) => c.request)).toEqual([
    { ids: [first.id], offset: 0, limit: 1 },
    { offset: 0, limit: 60 },
  ]);
});

it('an id read that answers after a filter change patches nothing and refetches the new list', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const first = job({ fileName: 'first.png' });
  const feed = withFeed([first]);
  renderScreen();
  await screen.findByText('first.png');
  const read = deferred<{ items: JobView[]; total: number }>();
  feed.api.set('jobs:list', (request) => (request.ids !== undefined ? read.promise : listOf([first])(request)));
  await feed.change({ jobIds: [first.id] });
  fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'queued' } });
  await waitFor(() => expect(listCalls(feed.api).at(-1)?.request).toEqual({ offset: 0, limit: 60, status: 'queued' }));
  await screen.findByText('first.png');
  const requests = listCalls(feed.api).length;
  await act(async () => read.resolve(pageOf([{ ...first, status: 'running', attempt: 1 }], 1)));
  expect(within(rowOf('first.png')).getByText('Queued')).toBeTruthy();
  await waitFor(() => expect(listCalls(feed.api)).toHaveLength(requests + 1));
  expect(listCalls(feed.api).at(-1)?.request).toEqual({ offset: 0, limit: 60, status: 'queued' });
});
it('the title count is every job of the workspace, the filter bar counts the jobs the filter matches', async () => {
  const failed = job({ status: 'failed', fileName: 'failed.png' });
  install(
    { 'jobs:list': listOf([job({ fileName: 'queued.png' }), failed]) },
    { ...IDLE, queued: 1, running: 2, waiting: 3, failed: 1, cancelled: 4, succeeded: 5 },
  );
  renderScreen();
  await screen.findByText('queued.png');
  const count = await screen.findByTitle('Jobs in this workspace');
  await waitFor(() => expect(count.textContent).toBe('16'));
  expect(screen.getByText('2 jobs')).toBeTruthy();

  fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'failed' } });
  expect(await screen.findByText('1 job')).toBeTruthy();
  expect(screen.getByTitle('Jobs in this workspace').textContent).toBe('16');
});

it('an empty list shows No jobs', async () => {
  install({});
  renderScreen();
  expect(await screen.findByText('No jobs')).toBeTruthy();
});

const LOCAL = providerView({ name: 'Local Ollama', taggingModel: 'vision-a' });
const RUNPOD = providerView({ name: 'RunPod', baseUrl: 'https://pod.example.test', taggingModel: 'big-vision' });

function withProviders(handlers: FakeHandlers, summary: JobSummary = IDLE) {
  return install(
    {
      ...fakeProviders(
        { providers: [LOCAL, RUNPOD] },
        {
          [LOCAL.id]: { ok: true, models: [{ name: 'vision-a', vision: true }] },
          [RUNPOD.id]: { ok: true, models: [{ name: 'big-vision', vision: true }] },
        },
      ).handlers,
      ...handlers,
    },
    summary,
  );
}

it('the Provider column shows the entry name and the model, and the stored name of a removed entry', async () => {
  const onRunPod = job({ fileName: 'pod.png', providerId: RUNPOD.id, providerName: 'Old name', model: 'big-vision' });
  const removed = job({
    fileName: 'gone.png',
    providerId: '00000000-0000-4000-8000-00000000dead',
    providerName: 'Gone Pod',
    model: 'm1',
  });
  const nameless = job({
    fileName: 'nameless.png',
    providerId: '00000000-0000-4000-8000-00000000beef',
    providerName: null,
  });
  withProviders({ 'jobs:list': listOf([onRunPod, removed, nameless]) });
  renderScreen();
  await screen.findByText('pod.png');
  // The current entry name wins over the one stored on the job once the list is loaded.
  await waitFor(() =>
    expect(within(rowOf('pod.png')).getAllByRole('gridcell')[2]!.textContent).toBe('RunPod · big-vision'),
  );
  expect(within(rowOf('pod.png')).getAllByRole('gridcell')[2]!.getAttribute('title')).toBe('RunPod · big-vision');
  expect(within(rowOf('gone.png')).getAllByRole('gridcell')[2]!.textContent).toBe('Gone Pod · m1');
  expect(within(rowOf('nameless.png')).getAllByRole('gridcell')[2]!.textContent).toBe('Removed provider');
});

it('the Provider column names the lane of a generation job, with the model of an edit and none for an upscale', async () => {
  const edit = job({
    type: IMAGE_GENERATE_JOB,
    fileName: 'edit.png',
    providerId: RUNPOD.id,
    providerName: 'RunPod',
    model: 'mock-edit',
  });
  const upscale = job({
    type: IMAGE_GENERATE_JOB,
    fileName: 'upscale.png',
    providerId: RUNPOD.id,
    providerName: 'RunPod',
    model: null,
  });
  withProviders({ 'jobs:list': listOf([edit, upscale]) });
  renderScreen();
  await screen.findByText('edit.png');
  expect(within(rowOf('edit.png')).getAllByRole('gridcell')[2]!.textContent).toBe('RunPod · mock-edit');
  expect(within(rowOf('upscale.png')).getAllByRole('gridcell')[2]!.textContent).toBe('RunPod');
});

it('the provider filter offers All providers plus the entries and sends providerId', async () => {
  const user = userEvent.setup();
  const local = job({ fileName: 'local.png', providerId: LOCAL.id, providerName: 'Local Ollama', model: 'vision-a' });
  const pod = job({ fileName: 'pod.png', providerId: RUNPOD.id, providerName: 'RunPod', model: 'big-vision' });
  const api = withProviders({ 'jobs:list': listOf([local, pod]) });
  renderScreen();
  await screen.findByText('local.png');
  const select = (await screen.findByRole('combobox', { name: 'Provider' })) as HTMLSelectElement;
  await waitFor(() =>
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All providers', 'Local Ollama', 'RunPod']),
  );
  expect((listCalls(api).at(-1)!.request as ListRequest).providerId).toBeUndefined();

  await user.selectOptions(select, RUNPOD.id);
  await waitFor(() => expect(screen.queryByText('local.png')).toBeNull());
  expect(screen.getByText('pod.png')).toBeTruthy();
  const last = listCalls(api).at(-1)!.request as ListRequest;
  expect(last.providerId).toBe(RUNPOD.id);
  expect(last.offset).toBe(0);

  await user.selectOptions(select, '');
  expect(await screen.findByText('local.png')).toBeTruthy();
  expect((listCalls(api).at(-1)!.request as ListRequest).providerId).toBeUndefined();
});

it('Move jobs in the toolbar opens the move dialog with a source select, and closing it reloads the list', async () => {
  const user = userEvent.setup();
  const api = withProviders({
    'jobs:list': listOf([job({ fileName: 'local.png', providerId: LOCAL.id, providerName: 'Local Ollama' })]),
    'jobs:waitingByProvider': () => [
      { providerId: LOCAL.id, providerName: 'Local Ollama', waiting: 7 },
      { providerId: null, providerName: null, waiting: 2 },
    ],
  });
  renderScreen();
  await screen.findByText('local.png');
  const button = screen.getByRole('button', { name: 'Move jobs' });
  expect(button.getAttribute('title')).toBe('Moves the waiting jobs of a provider to another one');
  await user.click(button);
  const dialog = await screen.findByRole('dialog', { name: 'Move jobs' });
  const from = within(dialog).getByRole('combobox', { name: 'From' }) as HTMLSelectElement;
  await waitFor(() =>
    expect(
      within(from)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Local Ollama', 'No provider']),
  );
  expect(within(dialog).getByText('7 waiting')).toBeTruthy();

  const lists = listCalls(api).length;
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog', { name: 'Move jobs' })).toBeNull();
  await waitFor(() => expect(listCalls(api).length).toBeGreaterThan(lists));
  expect(api.calls.some((c) => c.channel === 'jobs:reroute')).toBe(false);
});

it('the move dialog does not offer the lane of a Venice entry as a source', async () => {
  const user = userEvent.setup();
  const venice = providerView({
    kind: 'venice',
    name: 'Venice',
    taggingModel: null,
    promptModel: null,
    editModel: 'mock-edit',
  });
  install({
    ...fakeProviders({ providers: [LOCAL, venice] }).handlers,
    'providers:listImageModels': () => ({ ok: true, models: [] }),
    'jobs:list': listOf([job({ fileName: 'local.png', providerId: LOCAL.id, providerName: 'Local Ollama' })]),
    'jobs:waitingByProvider': () => [
      { providerId: venice.id, providerName: 'Venice', waiting: 4 },
      { providerId: LOCAL.id, providerName: 'Local Ollama', waiting: 7 },
    ],
  });
  renderScreen();
  await screen.findByText('local.png');
  await user.click(screen.getByRole('button', { name: 'Move jobs' }));
  const dialog = await screen.findByRole('dialog', { name: 'Move jobs' });
  const from = within(dialog).getByRole('combobox', { name: 'From' }) as HTMLSelectElement;
  await waitFor(() =>
    expect(
      within(from)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Local Ollama']),
  );
  expect(within(dialog).getByText('7 waiting')).toBeTruthy();
});
