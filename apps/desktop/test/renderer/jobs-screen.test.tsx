import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ANALYZE_FILE_JOB, IMAGE_GENERATE_JOB, type IpcRequest, type JobSummary, type JobView } from '@assetforge/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { formatDateTime } from '../../src/renderer/src/format';
import { JOB_POLL_MS, JobsProvider } from '../../src/renderer/src/jobs-context';
import { ProviderSettingsProvider } from '../../src/renderer/src/provider-context';
import { JobsScreen } from '../../src/renderer/src/screens/JobsScreen';
import { deferred, fakeError, fakeProviders, installFakeApi, providerView, type FakeHandlers } from './fake-api';
import { nextId, pageOf } from './fixtures';

afterEach(() => {
  vi.useRealTimers();
});

const CREATED = '2026-01-01T10:00:00.000Z';
const RUN_AFTER = '2026-01-01T10:05:00.000Z';

const IDLE: JobSummary = { queued: 0, running: 0, waiting: 0, failed: 0, cancelled: 0, succeeded: 0, changes: 0, paused: [] };

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
    ...p,
  };
}

type ListRequest = IpcRequest<'jobs:list'>;

function listOf(items: JobView[]) {
  return (request: ListRequest) => {
    const matching = items.filter(
      (j) =>
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
  install({ 'jobs:list': listOf([running, retrying, failed]) });
  renderScreen();

  expect(await screen.findByText('running.png')).toBeTruthy();
  expect(screen.getByRole('heading', { level: 2, name: /Jobs/ })).toBeTruthy();
  expect(screen.getByTitle('Jobs in this workspace').textContent).toBe('3');
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

  const cells = (row: HTMLElement) => within(row).getAllByRole('gridcell').map((c) => c.textContent);
  expect(cells(rowOf('running.png'))).toEqual(['Analysis', 'running.png', 'No provider', 'Running', '1 / 3', formatDateTime(CREATED), '', '']);
  expect(cells(rowOf('retrying.png'))).toEqual(['Analysis', 'retrying.png', 'No provider', 'Retrying', '2 / 3', formatDateTime(CREATED), '', '']);
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
  const nameless = job({ fileName: 'nameless.png', providerId: '00000000-0000-4000-8000-00000000beef', providerName: null });
  withProviders({ 'jobs:list': listOf([onRunPod, removed, nameless]) });
  renderScreen();
  await screen.findByText('pod.png');
  // The current entry name wins over the one stored on the job once the list is loaded.
  await waitFor(() => expect(within(rowOf('pod.png')).getAllByRole('gridcell')[2]!.textContent).toBe('RunPod · big-vision'));
  expect(within(rowOf('pod.png')).getAllByRole('gridcell')[2]!.getAttribute('title')).toBe('RunPod · big-vision');
  expect(within(rowOf('gone.png')).getAllByRole('gridcell')[2]!.textContent).toBe('Gone Pod · m1');
  expect(within(rowOf('nameless.png')).getAllByRole('gridcell')[2]!.textContent).toBe('Removed provider');
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
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['All providers', 'Local Ollama', 'RunPod']),
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
  await waitFor(() => expect(within(from).getAllByRole('option').map((o) => o.textContent)).toEqual(['Local Ollama', 'No provider']));
  expect(within(dialog).getByText('7 waiting')).toBeTruthy();

  const lists = listCalls(api).length;
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog', { name: 'Move jobs' })).toBeNull();
  await waitFor(() => expect(listCalls(api).length).toBeGreaterThan(lists));
  expect(api.calls.some((c) => c.channel === 'jobs:reroute')).toBe(false);
});

it('the move dialog does not offer the lane of a Venice entry as a source', async () => {
  const user = userEvent.setup();
  const venice = providerView({ kind: 'venice', name: 'Venice', taggingModel: null, promptModel: null, editModel: 'mock-edit' });
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
  await waitFor(() => expect(within(from).getAllByRole('option').map((o) => o.textContent)).toEqual(['Local Ollama']));
  expect(within(dialog).getByText('7 waiting')).toBeTruthy();
});
