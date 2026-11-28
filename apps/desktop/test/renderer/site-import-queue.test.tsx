import { useState } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileTarget, SiteCrawlTask, SiteCrawlTaskSummary, SiteProfile } from '@assetforge/contracts';
import { expect, it } from 'vitest';
import { SiteImportDialog } from '../../src/renderer/src/components/SiteImportDialog';
import { JobsProvider } from '../../src/renderer/src/jobs-context';
import { installFakeApi, urlImportResultOf, type FakeHandlers } from './fake-api';
import { nextId } from './fixtures';

function profileOf(): SiteProfile {
  return {
    id: nextId(),
    name: 'Gallery',
    site: 'example.com',
    thumbnails: '//a/@href',
    pagination: '',
    file: '//img/@src',
    kinds: ['image'],
    minBytes: 0,
    urlContains: '',
    maxPages: 20,
    maxFiles: 1000,
  };
}

function taskOf(profile: SiteProfile, patch: Partial<SiteCrawlTask> = {}): SiteCrawlTask {
  const crawlId = nextId();
  const galleryUrl = 'https://example.com/album';
  const files = ['https://example.com/existing.jpg?token=one', 'https://example.com/download?id=53'];
  return {
    crawlId,
    profileId: profile.id,
    profileName: profile.name,
    site: profile.site,
    galleryUrl,
    target: null,
    targetAssetName: null,
    jobId: nextId(),
    createdAt: '2026-11-28T12:00:00.000Z',
    updatedAt: '2026-11-28T12:00:00.000Z',
    status: 'ready',
    errorCode: null,
    errorMessage: null,
    progress: { pages: 1, files: 2, cancelling: false },
    result: {
      crawlId,
      files,
      pages: 1,
      duplicates: 0,
      filtered: 0,
      disallowed: 0,
      invalid: 0,
      offSite: 0,
      pageFailures: 0,
      truncated: null,
      cancelled: false,
      problems: [],
      problemsDropped: 0,
    },
    candidates: [
      {
        url: files[0]!,
        sourcePageUrl: 'https://example.com/details/1',
        expectedName: 'existing.jpg',
        alreadyPresent: false,
      },
      { url: files[1]!, sourcePageUrl: 'https://example.com/details/2', expectedName: null, alreadyPresent: false },
    ],
    ...patch,
  };
}

function summaryOf(task: SiteCrawlTask): SiteCrawlTaskSummary {
  const { result: _result, candidates: _candidates, ...summary } = task;
  return summary;
}

function ImportHost({ target = null }: { target?: FileTarget | null }) {
  const [open, setOpen] = useState(true);
  return (
    <JobsProvider>
      {open ? (
        <SiteImportDialog target={target} onClose={() => setOpen(false)} />
      ) : (
        <button onClick={() => setOpen(true)}>Open site import</button>
      )}
    </JobsProvider>
  );
}

function setup(seed: SiteCrawlTask[] = [], target: FileTarget | null = null, extra: FakeHandlers = {}) {
  const profile = profileOf();
  const state = { tasks: seed };
  const api = installFakeApi({
    'sites:list': () => ({ profiles: [profile] }),
    'sites:listCrawls': ({ offset = 0, limit = 20 }) => ({
      items: state.tasks.slice(offset, offset + limit).map(summaryOf),
      total: state.tasks.length,
    }),
    'sites:getCrawl': ({ crawlId }) => structuredClone(state.tasks.find((task) => task.crawlId === crawlId)!),
    'sites:enqueueCrawl': ({ url, target: capturedTarget }) => {
      const task = taskOf(profile, {
        galleryUrl: url,
        target: capturedTarget,
        status: 'queued',
        result: null,
        candidates: [],
        progress: { pages: 0, files: 0, cancelling: false },
      });
      state.tasks.unshift(task);
      return { crawlId: task.crawlId };
    },
    'sites:cancelCrawl': () => ({ cancelling: true }),
    'sites:retryCrawl': () => ({ retried: true }),
    'sites:openLogin': () => ({}),
    'sites:import': () => urlImportResultOf({ queued: 1 }),
    ...extra,
  });
  const view = render(<ImportHost target={target} />);
  return { api, state, profile, view, user: userEvent.setup() };
}

const requests = (api: ReturnType<typeof setup>['api'], channel: string) =>
  api.calls.filter((entry) => entry.channel === channel).map((entry) => entry.request);
const taskList = () => screen.getByRole('list', { name: 'Extractions' });

it('keeps importing disabled for a failed extraction with partial candidates', async () => {
  const task = taskOf(profileOf(), { status: 'failed', errorCode: 'download_forbidden' });
  const { user } = setup([task]);
  await user.click(await within(taskList()).findByRole('button'));
  const button = await screen.findByRole('button', { name: /Import selected/ });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('button', { name: /Retry|Resume/ })).toBeTruthy();
});

it('offers a deliberate way to remove an imported extraction without cancelling its downloads', async () => {
  const task = taskOf(profileOf(), { status: 'imported' });
  const { api, user } = setup([task]);
  await user.click(await within(taskList()).findByRole('button'));
  await user.click(await screen.findByRole('button', { name: 'Remove extraction' }));
  const confirmation = await screen.findByRole('dialog', { name: 'Remove extraction?' });
  expect(within(confirmation).getByText('Only saved extraction results are removed. Queued downloads continue in Jobs.')).toBeTruthy();
  expect(requests(api, 'sites:cancelCrawl')).toEqual([]);
  expect(requests(api, 'sites:removeCrawl')).toEqual([]);
});

it('loads the selected extraction live profile for editing instead of the first profile', async () => {
  const unrelated = { ...profileOf(), name: 'Other profile' };
  const liveProfile = { ...profileOf(), name: 'Live gallery', file: '//a/@href' };
  const task = taskOf(liveProfile, { profileName: 'Name when extracted', status: 'imported' });
  const { user } = setup([task], null, { 'sites:list': () => ({ profiles: [unrelated, liveProfile] }) });
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Other profile'));
  await user.click(await within(taskList()).findByRole('button'));
  await user.click(await screen.findByRole('button', { name: 'Edit profile' }));
  expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Live gallery');
  expect((screen.getByRole('textbox', { name: 'File XPath' }) as HTMLInputElement).value).toBe('//a/@href');
  expect(screen.getByText('Profile changes apply to future extractions. Saved results keep their captured settings.')).toBeTruthy();
});

it('extracts again using the saved profile and captured destination rather than current asset navigation', async () => {
  const profile = profileOf();
  const captured: FileTarget = { assetId: nextId(), role: 'reference' };
  const current: FileTarget = { assetId: nextId(), role: 'final' };
  const task = taskOf(profile, { target: captured, targetAssetName: 'Captured asset', status: 'imported' });
  const { api, state, user } = setup([task], current, { 'sites:list': () => ({ profiles: [profile] }) });
  await user.click(await within(taskList()).findByRole('button'));
  await user.click(await screen.findByRole('button', { name: 'Extract again' }));
  await waitFor(() => expect(requests(api, 'sites:enqueueCrawl')).toHaveLength(1));
  expect(requests(api, 'sites:enqueueCrawl')[0]).toEqual({ profileId: task.profileId, url: task.galleryUrl, target: captured });
  expect(state.tasks.some((entry) => entry.crawlId === task.crawlId && entry.status === 'imported')).toBe(true);
  expect(state.tasks).toHaveLength(2);
});

async function readyForm() {
  await waitFor(() =>
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Gallery'),
  );
}

it('closing the import dialog does not cancel URL extraction', async () => {
  const { api, state, user } = setup();
  await readyForm();
  await user.type(screen.getByRole('textbox', { name: 'Gallery URLs' }), 'https://example.com/album');
  await user.click(screen.getByRole('button', { name: 'Queue extraction' }));
  await waitFor(() => expect(state.tasks).toHaveLength(1));
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(requests(api, 'sites:cancelCrawl')).toEqual([]);
  expect(state.tasks[0]!.status).toBe('queued');
  expect(requests(api, 'sites:crawl')).toEqual([]);
});

it('queues five galleries independently and keeps the form usable while extraction runs', async () => {
  const target: FileTarget = { assetId: nextId(), role: 'reference' };
  const { api, state, profile, user } = setup([], target);
  await readyForm();
  const urls = Array.from({ length: 5 }, (_, index) => `https://example.com/album/${index}`);
  await user.type(screen.getByRole('textbox', { name: 'Gallery URLs' }), urls.join('\n'));
  await user.click(screen.getByRole('button', { name: 'Queue extraction' }));
  await waitFor(() => expect(within(taskList()).getAllByRole('listitem')).toHaveLength(5));
  expect(requests(api, 'sites:enqueueCrawl')).toEqual(urls.map((url) => ({ profileId: profile.id, url, target })));
  expect(new Set(state.tasks.map((task) => task.crawlId)).size).toBe(5);
  await user.type(screen.getByRole('textbox', { name: 'Gallery URLs' }), 'https://example.com/another');
  expect((screen.getByRole('button', { name: 'Queue extraction' }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).readOnly).toBe(false);
});

it('reopens saved results after navigation and imports to the captured asset instead of the current asset', async () => {
  const oldTarget: FileTarget = { assetId: nextId(), role: 'reference' };
  const newTarget: FileTarget = { assetId: nextId(), role: 'final' };
  const profile = profileOf();
  const task = taskOf(profile, { target: oldTarget, targetAssetName: 'Captured character' });
  const { api, user, view } = setup([task], oldTarget);
  await readyForm();
  await user.click(screen.getByRole('button', { name: 'Close' }));
  view.rerender(<ImportHost target={newTarget} />);
  await user.click(screen.getByRole('button', { name: 'Open site import' }));
  await user.click(await within(taskList()).findByRole('button'));
  await screen.findByRole('table', { name: 'Found files' });
  expect(screen.getAllByText('Target: Captured character · reference')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Import selected' }));
  await waitFor(() => expect(requests(api, 'sites:import')).toHaveLength(1));
  expect(requests(api, 'sites:import')[0]).toEqual({
    crawlId: task.crawlId,
    selectedUrls: task.result!.files,
    skipExistingNames: true,
    includeExistingUrls: [],
  });
});

it('skips existing filenames by default, keeps unknown names, and allows an explicit individual override', async () => {
  const profile = profileOf();
  const task = taskOf(profile, { target: { assetId: nextId(), role: 'reference' }, targetAssetName: 'Character' });
  task.candidates[0]!.alreadyPresent = true;
  const { api, user } = setup([task]);
  await user.click(await within(taskList()).findByRole('button'));
  const existing = (await screen.findByRole('checkbox', { name: 'Select existing.jpg' })) as HTMLInputElement;
  const unknown = screen.getByRole('checkbox', { name: `Select ${task.candidates[1]!.url}` }) as HTMLInputElement;
  expect(existing.checked).toBe(false);
  expect(unknown.checked).toBe(true);
  expect(screen.getByText('Already present - filename')).toBeTruthy();
  expect(screen.getByText('Filename determined during download')).toBeTruthy();
  await user.click(existing);
  await user.click(screen.getByRole('button', { name: 'Import selected' }));
  await waitFor(() => expect(requests(api, 'sites:import')).toHaveLength(1));
  expect(requests(api, 'sites:import')[0]).toMatchObject({
    skipExistingNames: true,
    selectedUrls: expect.arrayContaining(task.result!.files),
    includeExistingUrls: [task.candidates[0]!.url],
  });
});

it('the optional filename rule can be disabled and enabled without losing the raw candidates', async () => {
  const task = taskOf(profileOf(), { target: { assetId: nextId(), role: 'reference' } });
  task.candidates[0]!.alreadyPresent = true;
  const { user } = setup([task]);
  await user.click(await within(taskList()).findByRole('button'));
  const rule = await screen.findByRole('checkbox', { name: 'Skip filenames already in this asset' });
  const existing = screen.getByRole('checkbox', { name: 'Select existing.jpg' }) as HTMLInputElement;
  await user.click(rule);
  expect(existing.checked).toBe(true);
  await user.click(rule);
  expect(existing.checked).toBe(false);
  expect(within(screen.getByRole('table', { name: 'Found files' })).getAllByRole('row')).toHaveLength(3);
});

it('inbox review does not offer an asset filename rule', async () => {
  const { user } = setup([taskOf(profileOf())]);
  await user.click(await within(taskList()).findByRole('button'));
  await screen.findByRole('table', { name: 'Found files' });
  expect(screen.queryByRole('checkbox', { name: 'Skip filenames already in this asset' })).toBeNull();
  expect(screen.getByText('Target: Inbox')).toBeTruthy();
});

it('login and retry operate on the saved task profile and only explicit cancel requests cancel it', async () => {
  const task = taskOf(profileOf(), {
    status: 'waiting',
    errorCode: 'download_forbidden',
    errorMessage: 'Log in again',
    result: null,
    candidates: [],
  });
  const { api, user } = setup([task]);
  await user.click(await within(taskList()).findByRole('button'));
  await user.click(await screen.findByRole('button', { name: 'Open site' }));
  await user.click(screen.getByRole('button', { name: 'Resume extraction' }));
  await waitFor(() => expect(requests(api, 'sites:retryCrawl')).toEqual([{ crawlId: task.crawlId }]));
  expect(requests(api, 'sites:openLogin')).toEqual([{ profileId: task.profileId, url: task.galleryUrl }]);
  await user.click(screen.getByRole('button', { name: /^Cancel$/ }));
  await waitFor(() => expect(requests(api, 'sites:cancelCrawl')).toEqual([{ crawlId: task.crawlId }]));
});

it('polls summary revisions and loads full results only when the selected task changes', async () => {
  const task = taskOf(profileOf(), { status: 'running', result: null, candidates: [] });
  const { api, state, user } = setup([task]);
  await user.click(await within(taskList()).findByRole('button'));
  await screen.findByText('Target: Inbox');
  const before = requests(api, 'sites:getCrawl').length;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 650));
  });
  expect(requests(api, 'sites:getCrawl')).toHaveLength(before);
  state.tasks[0] = taskOf(profileOf(), {
    ...task,
    status: 'ready',
    updatedAt: '2026-11-28T12:02:00.000Z',
    result: taskOf(profileOf()).result,
    candidates: taskOf(profileOf()).candidates,
  });
  await screen.findByRole('table', { name: 'Found files' });
  expect(requests(api, 'sites:getCrawl').length).toBeGreaterThan(before);
});

it('only renders a page of large saved candidate results while selection spans all candidates', async () => {
  const task = taskOf(profileOf());
  task.candidates = Array.from({ length: 70 }, (_, index) => ({
    url: `https://example.com/${index}.jpg`,
    sourcePageUrl: `https://example.com/details/${index}`,
    expectedName: `${index}.jpg`,
    alreadyPresent: false,
  }));
  task.result!.files = task.candidates.map((candidate) => candidate.url);
  const { api, user } = setup([task]);
  await user.click(await within(taskList()).findByRole('button'));
  const table = await screen.findByRole('table', { name: 'Found files' });
  expect(within(table).getAllByRole('row')).toHaveLength(51);
  await user.click(screen.getByRole('button', { name: 'Next files' }));
  expect(within(table).getAllByRole('row')).toHaveLength(21);
  await user.click(screen.getByRole('button', { name: 'Import selected' }));
  await waitFor(() => expect(requests(api, 'sites:import')).toHaveLength(1));
  expect((requests(api, 'sites:import')[0] as { selectedUrls: string[] }).selectedUrls).toHaveLength(70);
});

it('unlocks review when job status changes without a new persisted crawl timestamp', async () => {
  const task = taskOf(profileOf(), { status: 'running' });
  const { state, user } = setup([task]);
  await user.click(await within(taskList()).findByRole('button'));
  const importButton = (await screen.findByRole('button', { name: 'Import selected' })) as HTMLButtonElement;
  expect(importButton.disabled).toBe(true);
  state.tasks[0] = { ...task, status: 'ready' };
  await waitFor(() => expect(importButton.disabled).toBe(false), { timeout: 2000 });
});

it('keeps saved candidates reviewable after a partial selection has been imported', async () => {
  const task = taskOf(profileOf(), { status: 'imported' });
  const { api, user } = setup([task]);
  await user.click(await within(taskList()).findByRole('button'));
  const importButton = (await screen.findByRole('button', { name: 'Import selected' })) as HTMLButtonElement;
  expect(importButton.disabled).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Clear selection' }));
  await user.click(screen.getByRole('checkbox', { name: 'Select existing.jpg' }));
  await user.click(importButton);
  await waitFor(() => expect(requests(api, 'sites:import')).toHaveLength(1));
  expect(requests(api, 'sites:import')[0]).toMatchObject({
    crawlId: task.crawlId,
    selectedUrls: [task.candidates[0]!.url],
  });
});
