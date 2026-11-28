import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileTarget, SiteCrawlTask, SiteProfile } from '@assetforge/contracts';
import { expect, it } from 'vitest';
import { JobsProvider } from '../../src/renderer/src/jobs-context';
import { ExtractionsScreen } from '../../src/renderer/src/screens/ExtractionsScreen';
import { installFakeApi, urlImportResultOf } from './fake-api';
import { nextId } from './fixtures';

const profile: SiteProfile = {
  id: nextId(),
  name: 'Gallery',
  site: 'example.com',
  thumbnails: '//a/@href',
  pagination: '',
  file: '',
  kinds: ['image'],
  minBytes: 0,
  urlContains: '',
  maxPages: 20,
  maxFiles: 1000,
};

it('renders the shared extraction workspace as a standalone page rather than a modal', async () => {
  const api = installFakeApi({
    'sites:list': () => ({ profiles: [profile] }),
    'sites:listCrawls': () => ({ items: [], total: 0 }),
  });
  render(
    <JobsProvider>
      <ExtractionsScreen />
    </JobsProvider>,
  );
  expect(screen.getByRole('heading', { name: 'Extractions', level: 2 })).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  await waitFor(() =>
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Gallery'),
  );
  expect(api.calls.filter((call) => call.channel === 'sites:list')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Queue extraction' })).toBeTruthy();
});

it('starts new page extractions in the inbox without requiring an asset', async () => {
  const api = installFakeApi({
    'sites:list': () => ({ profiles: [profile] }),
    'sites:listCrawls': () => ({ items: [], total: 0 }),
    'sites:enqueueCrawl': () => ({ crawlId: nextId() }),
  });
  const user = userEvent.setup();
  render(
    <JobsProvider>
      <ExtractionsScreen />
    </JobsProvider>,
  );
  await waitFor(() =>
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Gallery'),
  );
  await user.type(screen.getByRole('textbox', { name: 'Gallery URLs' }), 'https://example.com/album');
  await user.click(screen.getByRole('button', { name: 'Queue extraction' }));
  await waitFor(() => expect(api.calls.filter((call) => call.channel === 'sites:enqueueCrawl')).toHaveLength(1));
  expect(api.calls.find((call) => call.channel === 'sites:enqueueCrawl')!.request).toEqual({
    profileId: profile.id,
    url: 'https://example.com/album',
    target: null,
  });
});

it('reviews an existing asset extraction from the page without retargeting it to the inbox', async () => {
  const target: FileTarget = { assetId: nextId(), role: 'reference' };
  const crawlId = nextId();
  const fileUrl = 'https://example.com/one.jpg';
  const task: SiteCrawlTask = {
    crawlId,
    profileId: profile.id,
    profileName: profile.name,
    site: profile.site,
    galleryUrl: 'https://example.com/album',
    target,
    targetAssetName: 'Captured asset',
    createdAt: '2026-11-28T12:00:00.000Z',
    updatedAt: '2026-11-28T12:00:00.000Z',
    status: 'ready',
    jobId: nextId(),
    errorCode: null,
    errorMessage: null,
    progress: { pages: 1, files: 1, cancelling: false },
    result: {
      crawlId,
      files: [fileUrl],
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
      { url: fileUrl, sourcePageUrl: 'https://example.com/details/1', expectedName: 'one.jpg', alreadyPresent: false },
    ],
  };
  const { candidates: _candidates, result: _result, ...summary } = task;
  const api = installFakeApi({
    'sites:list': () => ({ profiles: [profile] }),
    'sites:listCrawls': () => ({ items: [summary], total: 1 }),
    'sites:getCrawl': () => task,
    'sites:import': () => urlImportResultOf({ queued: 1 }),
  });
  const user = userEvent.setup();
  render(
    <JobsProvider>
      <ExtractionsScreen />
    </JobsProvider>,
  );
  await user.click(await within(screen.getByRole('list', { name: 'Extractions' })).findByRole('button'));
  await screen.findByText('Target: Captured asset · reference');
  await user.click(screen.getByRole('button', { name: 'Import selected' }));
  await waitFor(() => expect(api.calls.filter((call) => call.channel === 'sites:import')).toHaveLength(1));
  expect(api.calls.find((call) => call.channel === 'sites:import')!.request).toMatchObject({
    crawlId,
    selectedUrls: [fileUrl],
  });
  expect(api.calls.find((call) => call.channel === 'sites:import')!.request).not.toHaveProperty('target');
  expect(api.calls.some((call) => call.channel === 'assets:get')).toBe(false);
});
