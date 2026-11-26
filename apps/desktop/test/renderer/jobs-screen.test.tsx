import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ANALYZE_FILE_JOB, type IpcRequest, type JobSummary, type JobView } from '@assetforge/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { formatDateTime } from '../../src/renderer/src/format';
import { JOB_POLL_MS, JobsProvider } from '../../src/renderer/src/jobs-context';
import { JobsScreen } from '../../src/renderer/src/screens/JobsScreen';
import { deferred, fakeError, installFakeApi, type FakeHandlers } from './fake-api';
import { nextId, pageOf } from './fixtures';

afterEach(() => {
  vi.useRealTimers();
});

const CREATED = '2026-01-01T10:00:00.000Z';
const RUN_AFTER = '2026-01-01T10:05:00.000Z';

const IDLE: JobSummary = { queued: 0, running: 0, waiting: 0, failed: 0, cancelled: 0, succeeded: 0, changes: 0, paused: null };

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
    ...p,
  };
}

type ListRequest = IpcRequest<'jobs:list'>;

function listOf(items: JobView[]) {
  return (request: ListRequest) => {
    const matching = request.status === undefined ? items : items.filter((j) => j.status === request.status);
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
      <JobsScreen />
    </JobsProvider>,
  );
}

const listCalls = (api: ReturnType<typeof installFakeApi>) => api.calls.filter((c) => c.channel === 'jobs:list');

function rowOf(name: string): HTMLElement {
  const cell = screen.getAllByRole('gridcell').find((c) => c.textContent === name);
  if (cell === undefined) throw new Error(`no row with ${name}`);
  return cell.closest<HTMLElement>('[role="row"]')!;
}

it('shows the six columns of a running, a retrying and a failed job', async () => {
  const running = job({ status: 'running', attempt: 1, fileName: 'running.png' });
  const retrying = job({ status: 'retry_wait', attempt: 2, fileName: 'retrying.png', runAfter: RUN_AFTER });
  const failed = job({
    status: 'failed',
    attempt: 3,
    fileName: null,
    type: 'other.kind',
    errorCode: 'provider_unreachable',
    errorMessage: 'The analysis provider could not be reached',
  });
  install({ 'jobs:list': listOf([running, retrying, failed]) });
  renderScreen();

  expect(await screen.findByText('running.png')).toBeTruthy();
  expect(screen.getByRole('heading', { level: 2, name: /Jobs/ })).toBeTruthy();
  expect(screen.getByTitle('Jobs in this workspace').textContent).toBe('3');
  expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
    'Job',
    'File',
    'Status',
    'Attempt',
    'Created',
    'Error',
    '',
  ]);

  const cells = (row: HTMLElement) => within(row).getAllByRole('gridcell').map((c) => c.textContent);
  expect(cells(rowOf('running.png'))).toEqual(['Analyse image', 'running.png', 'Running', '1 / 3', formatDateTime(CREATED), '', '']);
  expect(cells(rowOf('retrying.png'))).toEqual(['Analyse image', 'retrying.png', 'Retrying', '2 / 3', formatDateTime(CREATED), '', '']);
  expect(within(rowOf('retrying.png')).getByText('Retrying').closest('[title]')?.getAttribute('title')).toBe(
    `Next try at ${formatDateTime(RUN_AFTER)}`,
  );
  expect(cells(rowOf('other.kind'))).toEqual([
    'other.kind',
    '—',
    'Failed',
    '3 / 3',
    formatDateTime(CREATED),
    'The analysis provider could not be reached',
    '',
  ]);
});

it('the status filter asks for that status and offers All plus the seven labels', async () => {
  const user = userEvent.setup();
  const failed = job({ status: 'failed', fileName: 'failed.png', errorMessage: 'x' });
  const api = install({ 'jobs:list': listOf([job({ fileName: 'queued.png' }), failed]) });
  renderScreen();
  await screen.findByText('queued.png');

  const select = screen.getByRole('combobox', { name: 'Status' });
  expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
    'All',
    'Queued',
    'Running',
    'Retrying',
    'Waiting',
    'Done',
    'Failed',
    'Cancelled',
  ]);
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
  expect(alert.compareDocumentPosition(screen.getByRole('grid', { name: 'Jobs' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
  await waitFor(() => expect((screen.getByRole('button', { name: 'Cancel all' }) as HTMLButtonElement).disabled).toBe(false));

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
  await waitFor(() => expect((screen.getByRole('button', { name: 'Cancel all' }) as HTMLButtonElement).disabled).toBe(false));
});

it('a moved changes in the next poll loads the list again, keeping the rows meanwhile', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let summary: JobSummary = { ...IDLE, queued: 1, changes: 1 };
  let jobs = [job({ fileName: 'first.png' })];
  const api = installFakeApi({
    'jobs:summary': () => summary,
    'jobs:list': (request) => listOf(jobs)(request),
  });
  renderScreen();
  await screen.findByText('first.png');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
  });
  const before = listCalls(api).length;

  jobs = [job({ fileName: 'second.png' }), ...jobs];
  summary = { ...summary, queued: 2, changes: 2 };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
  });
  await waitFor(() => expect(listCalls(api).length).toBeGreaterThan(before));
  expect(await screen.findByText('second.png')).toBeTruthy();
  expect(screen.getByText('first.png')).toBeTruthy();
});

it('an empty list shows No jobs', async () => {
  install({});
  renderScreen();
  expect(await screen.findByText('No jobs')).toBeTruthy();
});
