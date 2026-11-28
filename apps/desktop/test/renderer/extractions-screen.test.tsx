import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SiteCrawlTask, SiteProfile } from '@assetforge/contracts';
import { expect, it } from 'vitest';
import { JobsProvider } from '../../src/renderer/src/jobs-context';
import { ExtractionsScreen } from '../../src/renderer/src/screens/ExtractionsScreen';
import { deferred, installFakeApi, urlImportResultOf, type FakeHandlers } from './fake-api';
import { nextId } from './fixtures';
import { readySiteCrawl } from './site-crawl-fixtures';

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

function task(name: string, status: SiteCrawlTask['status'] = 'ready'): SiteCrawlTask {
  const saved = readySiteCrawl(profile, { assetId: nextId(), role: 'reference' });
  const crawlId = nextId();
  return {
    ...saved,
    crawlId,
    jobId: crawlId,
    profileName: name,
    galleryUrl: `https://example.com/${name}`,
    targetAssetName: `${name} asset`,
    status,
    result: { ...saved.result!, crawlId },
  };
}

function setup(tasks: SiteCrawlTask[], handlers: FakeHandlers = {}) {
  const api = installFakeApi({
    'sites:list': () => ({ profiles: [profile] }),
    'sites:listCrawls': () => ({
      items: tasks.map(({ result: _r, candidates: _c, ...summary }) => summary),
      total: tasks.length,
    }),
    'sites:getCrawl': ({ crawlId }) => structuredClone(tasks.find((saved) => saved.crawlId === crawlId)!),
    'sites:import': () => urlImportResultOf({ queued: 1 }),
    ...handlers,
  });
  render(
    <JobsProvider>
      <ExtractionsScreen />
    </JobsProvider>,
  );
  return { api, user: userEvent.setup() };
}

function card(saved: SiteCrawlTask) {
  return screen.getByRole('button', { name: `Select extraction ${saved.galleryUrl}` });
}

async function menu(saved: SiteCrawlTask) {
  await waitFor(() => expect(card(saved)).toBeTruthy());
  fireEvent.contextMenu(card(saved), { clientX: 200, clientY: 180 });
  return screen.findByRole('menu', { name: `Extraction actions: ${saved.galleryUrl}` });
}

it('shows only extraction cards and the selected detail, without a page heading, hint or permanent profile form', async () => {
  const first = task('first');
  const second = task('second');
  const { api, user } = setup([first, second]);
  await screen.findByRole('list', { name: 'Extractions' });
  expect(screen.queryByRole('heading', { name: 'Extractions' })).toBeNull();
  expect(screen.queryByText('Extraction runs in the background. Review each result before importing.')).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(card(second)).toBeTruthy());
  expect(api.calls.filter((call) => call.channel === 'sites:getCrawl')).toHaveLength(0);
  await user.click(card(second));
  const detail = await screen.findByRole('region', { name: 'Extraction details' });
  expect(await within(detail).findByText('Target: second asset · reference')).toBeTruthy();
  expect(within(detail).queryByText('first')).toBeNull();
  expect(card(second).getAttribute('aria-pressed')).toBe('true');
  expect(api.calls.filter((call) => call.channel === 'sites:getCrawl').at(-1)?.request).toEqual({
    crawlId: second.crawlId,
  });
});

it('imports a ready card using current filename matches and its captured target without opening an asset', async () => {
  const saved = task('ready');
  saved.candidates = [
    {
      url: 'https://example.com/existing.jpg',
      sourcePageUrl: saved.galleryUrl,
      expectedName: 'existing.jpg',
      alreadyPresent: true,
    },
    {
      url: 'https://example.com/new.jpg',
      sourcePageUrl: saved.galleryUrl,
      expectedName: 'new.jpg',
      alreadyPresent: false,
    },
    {
      url: 'https://example.com/download?id=53',
      sourcePageUrl: saved.galleryUrl,
      expectedName: null,
      alreadyPresent: false,
    },
  ];
  const { api, user } = setup([saved]);
  await user.click(within(await menu(saved)).getByRole('menuitem', { name: 'Import' }));
  await waitFor(() => expect(api.calls.filter((call) => call.channel === 'sites:import')).toHaveLength(1));
  expect(api.calls.find((call) => call.channel === 'sites:import')?.request).toEqual({
    crawlId: saved.crawlId,
    selectedUrls: ['https://example.com/new.jpg', 'https://example.com/download?id=53'],
    skipExistingNames: true,
    includeExistingUrls: [],
  });
  expect(api.calls.some((call) => call.channel === 'assets:get')).toBe(false);
});

it("uses the owner's current selection when importing from the selected card menu", async () => {
  const saved = task('selection');
  saved.candidates.push({
    url: 'https://example.com/b.png',
    sourcePageUrl: saved.galleryUrl,
    expectedName: 'b.png',
    alreadyPresent: false,
  });
  const { api, user } = setup([saved]);
  await waitFor(() => expect(card(saved)).toBeTruthy());
  await user.click(card(saved));
  await user.click(await screen.findByRole('checkbox', { name: 'Select a.png' }));
  await user.click(within(await menu(saved)).getByRole('menuitem', { name: 'Import' }));
  await waitFor(() =>
    expect(api.calls.find((call) => call.channel === 'sites:import')?.request).toMatchObject({
      selectedUrls: ['https://example.com/b.png'],
    }),
  );
});

it('restarts the same selected card rather than enqueueing a copy', async () => {
  const saved = task('restart');
  const { api, user } = setup([saved], {
    'sites:restartCrawl': () => {
      Object.assign(saved, {
        status: 'running',
        result: null,
        candidates: [],
        updatedAt: '2026-11-28T12:01:00.000Z',
        progress: { pages: 0, files: 0, cancelling: false },
      });
      return { restarted: true };
    },
  });
  await user.click(within(await menu(saved)).getByRole('menuitem', { name: 'Extract again' }));
  await waitFor(() =>
    expect(api.calls.find((call) => call.channel === 'sites:restartCrawl')?.request).toEqual({
      crawlId: saved.crawlId,
    }),
  );
  expect(api.calls.some((call) => call.channel === 'sites:enqueueCrawl')).toBe(false);
  await screen.findAllByText('0 pages, 0 files');
  expect(within(screen.getByRole('list', { name: 'Extractions' })).getAllByRole('listitem')).toHaveLength(1);
  expect(card(saved).getAttribute('aria-pressed')).toBe('true');
});

it('exposes status-appropriate actions through the keyboard context menu and cancels only that card', async () => {
  const saved = task('running', 'running');
  const { api, user } = setup([saved], { 'sites:cancelCrawl': () => ({ cancelling: true }) });
  await waitFor(() => expect(card(saved)).toBeTruthy());
  card(saved).focus();
  await user.keyboard('{Shift>}{F10}{/Shift}');
  const popup = await screen.findByRole('menu');
  expect(within(popup).queryByRole('menuitem', { name: 'Import' })).toBeNull();
  expect(within(popup).getByRole('menuitem', { name: 'Extract again' }).getAttribute('aria-disabled')).toBe('true');
  expect(within(popup).getByRole('menuitem', { name: 'Remove extraction' }).getAttribute('aria-disabled')).toBe('true');
  await user.click(within(popup).getByRole('menuitem', { name: 'Cancel' }));
  await waitFor(() =>
    expect(api.calls.find((call) => call.channel === 'sites:cancelCrawl')?.request).toEqual({ crawlId: saved.crawlId }),
  );
});

it('removes the requested card after confirmation without cancelling downloads or another extraction', async () => {
  const first = task('first');
  const second = task('remove');
  const tasks = [first, second];
  const { api, user } = setup(tasks, {
    'sites:removeCrawl': ({ crawlId }) => {
      tasks.splice(
        tasks.findIndex((saved) => saved.crawlId === crawlId),
        1,
      );
      return { removed: true };
    },
  });
  await user.click(within(await menu(second)).getByRole('menuitem', { name: 'Remove extraction' }));
  const dialog = await screen.findByRole('dialog', { name: 'Remove extraction?' });
  expect(api.calls.some((call) => call.channel === 'sites:removeCrawl')).toBe(false);
  await user.click(within(dialog).getByRole('button', { name: 'Remove extraction' }));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: `Select extraction ${second.galleryUrl}` })).toBeNull(),
  );
  expect(card(first)).toBeTruthy();
  expect(api.calls.find((call) => call.channel === 'sites:removeCrawl')?.request).toEqual({ crawlId: second.crawlId });
  expect(api.calls.some((call) => call.channel === 'sites:cancelCrawl')).toBe(false);
});

it('opens creation separately and submits new galleries to the inbox', async () => {
  const { api, user } = setup([], { 'sites:enqueueCrawl': () => ({ crawlId: nextId() }) });
  await user.click(screen.getByRole('button', { name: 'New extraction' }));
  const dialog = await screen.findByRole('dialog', { name: 'Import from site' });
  await waitFor(() =>
    expect((within(dialog).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Gallery'),
  );
  await user.type(within(dialog).getByRole('textbox', { name: 'Gallery URLs' }), 'https://example.com/album');
  await user.click(within(dialog).getByRole('button', { name: 'Queue extraction' }));
  await waitFor(() =>
    expect(api.calls.find((call) => call.channel === 'sites:enqueueCrawl')?.request).toEqual({
      profileId: profile.id,
      url: 'https://example.com/album',
      target: null,
    }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('ignores a late detail response after selecting a different extraction', async () => {
  const first = task('slow');
  const second = task('fast');
  const pending = deferred<SiteCrawlTask>();
  const { user } = setup([first, second], {
    'sites:getCrawl': ({ crawlId }) => (crawlId === first.crawlId ? pending.promise : second),
  });
  await waitFor(() => expect(card(first)).toBeTruthy());
  await user.click(card(first));
  await user.click(card(second));
  await screen.findByText('Target: fast asset · reference');
  pending.resolve(first);
  await waitFor(() => expect(screen.queryByText('Target: slow asset · reference')).toBeNull());
});
