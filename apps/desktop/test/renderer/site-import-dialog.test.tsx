import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SiteCrawlProblem, SiteCrawlResult, SiteProfile } from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { SiteImportDialog } from '../../src/renderer/src/components/SiteImportDialog';
import { CrawlResultView } from '../../src/renderer/src/components/SiteCrawlPanel';
import {
  bytesOfKb,
  draftOf,
  newDraft,
  noFilesHeadline,
  problemText,
  saveRequestOf,
} from '../../src/renderer/src/components/site-import-state';
import { JobsProvider } from '../../src/renderer/src/jobs-context';
import { fakeError, installFakeApi, type FakeHandlers } from './fake-api';
import { nextId } from './fixtures';

function profileOf(patch: Partial<SiteProfile> = {}): SiteProfile {
  return {
    id: nextId(),
    name: 'Shop',
    site: 'example.com',
    thumbnails: '//a/@href',
    pagination: '',
    file: '',
    kinds: ['image', 'video'],
    minBytes: 0,
    urlContains: '',
    maxPages: 20,
    maxFiles: 1000,
    ...patch,
  };
}

function setup(seed: SiteProfile[] = [], extra: FakeHandlers = {}) {
  const state = { profiles: structuredClone(seed) };
  const api = installFakeApi({
    'sites:list': () => ({ profiles: structuredClone(state.profiles) }),
    'sites:listCrawls': () => ({ items: [], total: 0 }),
    'sites:save': ({ id, url, ...fields }) => {
      const created = {
        id: id ?? nextId(),
        site:
          id === undefined
            ? new URL(url!).hostname.replace(/^www\./, '')
            : state.profiles.find((profile) => profile.id === id)!.site,
        ...fields,
      };
      state.profiles =
        id === undefined
          ? [...state.profiles, created]
          : state.profiles.map((profile) => (profile.id === id ? created : profile));
      return structuredClone(created);
    },
    'sites:delete': ({ id }) => {
      state.profiles = state.profiles.filter((profile) => profile.id !== id);
      return {};
    },
    'sites:openLogin': () => ({}),
    ...extra,
  });
  const onClose = vi.fn();
  render(
    <JobsProvider>
      <SiteImportDialog target={null} onClose={onClose} />
    </JobsProvider>,
  );
  return { api, state, onClose, user: userEvent.setup() };
}

const field = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const requests = (api: ReturnType<typeof setup>['api'], channel: string) =>
  api.calls.filter((entry) => entry.channel === channel).map((entry) => entry.request);

async function retype(user: ReturnType<typeof userEvent.setup>, name: string, text: string) {
  await user.clear(field(name));
  if (text !== '') await user.type(field(name), text);
}

it('validates existing and new performance settings and converts display units', () => {
  expect(bytesOfKb('0.5')).toBe(512);
  expect(bytesOfKb('x')).toBeNull();
  const profile = profileOf({ minBytes: 4096 });
  const draft = draftOf(profile);
  expect(draft.minKb).toBe('4');
  expect(draft.detailConcurrency).toBe('3');
  expect(saveRequestOf(draft, profile.id)).toMatchObject({
    id: profile.id,
    minBytes: 4096,
    detailConcurrency: 3,
    requestGapMs: 500,
    pageTimeoutMs: 30000,
  });
  for (const patch of [
    { maxPages: '0' },
    { maxFiles: '5001' },
    { kinds: [] },
    { thumbnails: ' ' },
    { detailConcurrency: '0' },
    { detailConcurrency: '7' },
    { requestGapMs: '-1' },
    { requestGapMs: '10001' },
    { pageTimeoutSeconds: '4' },
    { pageTimeoutSeconds: '121' },
  ])
    expect(saveRequestOf({ ...draft, ...patch }, profile.id)).toBeNull();
  expect(saveRequestOf(draft, null)).toBeNull();
  expect(newDraft()).toMatchObject({ detailConcurrency: '3', requestGapMs: '500', pageTimeoutSeconds: '30' });
});

it('creates a profile with extraction settings and exposes deletion after saving', async () => {
  const { api, state, user } = setup();
  await waitFor(() => expect(requests(api, 'sites:list')).toHaveLength(1));
  expect(button('Save').disabled).toBe(true);
  expect(button('Delete').disabled).toBe(true);
  await user.type(field('Name'), 'Shop');
  await user.type(field('Site address'), 'https://www.example.com/');
  await user.type(field('Thumbnails XPath'), '//a/@href');
  await retype(user, 'Parallel detail pages', '4');
  await retype(user, 'Request interval (ms)', '250');
  await retype(user, 'Page timeout (seconds)', '45');
  await user.click(button('Save'));
  await waitFor(() => expect(state.profiles).toHaveLength(1));
  expect(requests(api, 'sites:save')[0]).toMatchObject({
    url: 'https://www.example.com/',
    detailConcurrency: 4,
    requestGapMs: 250,
    pageTimeoutMs: 45000,
  });
  await waitFor(() => expect(button('Delete').disabled).toBe(false));
  expect(screen.queryByRole('textbox', { name: 'Site address' })).toBeNull();
  expect(button('Save').disabled).toBe(true);
});

it('edits and switches profiles without rewriting their sites', async () => {
  const one = profileOf({ name: 'One' });
  const two = profileOf({ name: 'Two', site: 'other.org', detailConcurrency: 5 });
  const { api, user } = setup([one, two]);
  await waitFor(() => expect(field('Name').value).toBe('One'));
  await retype(user, 'Name', 'Updated');
  await user.click(button('Save'));
  await waitFor(() => expect(requests(api, 'sites:save')).toHaveLength(1));
  expect(requests(api, 'sites:save')[0]).toMatchObject({ id: one.id, name: 'Updated' });
  expect(requests(api, 'sites:save')[0]).not.toHaveProperty('url');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Profile' }), two.id);
  expect(field('Name').value).toBe('Two');
  expect(field('Parallel detail pages').value).toBe('5');
});

it('unsaved profile changes prevent enqueueing until saved', async () => {
  const { user } = setup([profileOf()]);
  await waitFor(() => expect(field('Name').value).toBe('Shop'));
  await user.type(field('Gallery URLs'), 'https://example.com/album');
  expect(button('Queue extraction').disabled).toBe(false);
  await user.type(field('Name'), 'x');
  expect(button('Queue extraction').disabled).toBe(true);
});

it('deleting asks for confirmation, then removes the profile', async () => {
  const profile = profileOf();
  const { api, state, user } = setup([profile]);
  await waitFor(() => expect(field('Name').value).toBe('Shop'));
  await user.click(button('Delete'));
  const confirm = await screen.findByRole('dialog', { name: 'Delete profile Shop?' });
  expect(requests(api, 'sites:delete')).toEqual([]);
  await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(state.profiles).toEqual([]));
  expect(requests(api, 'sites:delete')).toEqual([{ id: profile.id }]);
  await waitFor(() => expect(field('Name').value).toBe(''));
});

it('a dependency error while deleting preserves the profile and explains why', async () => {
  const { state, user } = setup([profileOf()], {
    'sites:delete': () => {
      throw fakeError('invalid_operation', 'Cancel the queued extractions before deleting this profile');
    },
  });
  await waitFor(() => expect(field('Name').value).toBe('Shop'));
  await user.click(button('Delete'));
  await user.click(
    within(await screen.findByRole('dialog', { name: 'Delete profile Shop?' })).getByRole('button', { name: 'Delete' }),
  );
  expect((await screen.findByRole('alert')).textContent).toContain('Cancel the queued extractions');
  expect(state.profiles).toHaveLength(1);
});

it('Log in uses a typed gallery only when it belongs to the profile site', async () => {
  const profile = profileOf();
  const { api, user } = setup([profile]);
  await waitFor(() => expect(field('Name').value).toBe('Shop'));
  await user.click(button('Log in'));
  await user.type(field('Gallery URLs'), 'https://shop.example.com/g');
  await user.click(button('Log in'));
  await retype(user, 'Gallery URLs', 'https://other.org/g');
  await user.click(button('Log in'));
  expect(requests(api, 'sites:openLogin')).toEqual([
    { profileId: profile.id },
    { profileId: profile.id, url: 'https://shop.example.com/g' },
    { profileId: profile.id },
  ]);
});

it('shows save errors and prevents invalid extraction settings from being saved', async () => {
  const { user } = setup([profileOf()], {
    'sites:save': () => {
      throw fakeError('invalid_operation', 'A site profile with this name already exists');
    },
  });
  await waitFor(() => expect(field('Name').value).toBe('Shop'));
  await retype(user, 'Name', 'Other');
  await user.click(button('Save'));
  expect((await screen.findByRole('alert')).textContent).toBe('A site profile with this name already exists');
  await retype(user, 'Parallel detail pages', '9');
  expect(button('Save').disabled).toBe(true);
});

it('shows preserved extraction diagnostics without rendering every file URL', () => {
  const problems: SiteCrawlProblem[] = [
    { url: 'https://example.com/details/1', stage: 'detail', reason: 'timeout', detail: null },
    { url: 'https://example.com/details/2', stage: 'detail', reason: 'http_error', detail: '404' },
  ];
  const result: SiteCrawlResult = {
    crawlId: nextId(),
    files: ['https://example.com/one.jpg'],
    pages: 2,
    duplicates: 1,
    filtered: 3,
    disallowed: 1,
    invalid: 1,
    offSite: 1,
    pageFailures: 2,
    truncated: 'files',
    cancelled: true,
    problems,
    problemsDropped: 4,
  };
  render(<CrawlResultView result={result} showFiles={false} />);
  for (const text of [
    'Pages 2',
    'Files 1',
    'Duplicates 1',
    'Filtered 3',
    'Disallowed 1',
    'Not usable 1',
    'Off site 1',
    'Page failures 2',
    'Stopped at Max. files',
    'Cancelled',
    'The page did not finish loading',
    'The site answered HTTP 404',
    'and 4 more',
  ])
    expect(screen.getByText(text)).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'Found files' })).toBeNull();
});

it('keeps specific no-result diagnoses and suppresses them for cancelled results', () => {
  const noFiles = { files: [], problems: [], cancelled: false };
  expect(noFilesHeadline(noFiles)).toBe('No files found');
  expect(noFilesHeadline({ ...noFiles, cancelled: true })).toBeNull();
  expect(
    noFilesHeadline({
      ...noFiles,
      problems: [{ url: 'https://example.com', stage: 'gallery', reason: 'http_error', detail: '403' }],
    }),
  ).toBe('The site refused the page (HTTP 403). Log in again');
  expect(problemText({ reason: 'invalid_link', detail: 'javascript:void(0)' })).toBe(
    'Not a usable link: javascript:void(0)',
  );
  expect(problemText({ reason: 'robots_unavailable', detail: null })).toBe('robots.txt could not be read');
});
