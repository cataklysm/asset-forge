import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileTarget, SiteCrawlProblem, SiteCrawlResult, SiteProfile } from '@assetforge/contracts';
import { expect, it, vi } from 'vitest';
import { SiteImportDialog } from '../../src/renderer/src/components/SiteImportDialog';
import { bytesOfKb, draftOf, saveRequestOf } from '../../src/renderer/src/components/site-import-state';
import { JobsProvider } from '../../src/renderer/src/jobs-context';
import { deferred, fakeError, installFakeApi, urlImportResultOf, type FakeHandlers } from './fake-api';
import { nextId } from './fixtures';

function profileOf(p: Partial<SiteProfile> = {}): SiteProfile {
  return {
    id: nextId(),
    name: 'Shop',
    site: 'example.com',
    thumbnails: '//a[@class="thumb"]',
    pagination: '',
    file: '',
    kinds: ['image', 'video'],
    minBytes: 0,
    urlContains: '',
    maxPages: 20,
    maxFiles: 1000,
    ...p,
  };
}

function crawlOf(p: Partial<SiteCrawlResult> = {}): SiteCrawlResult {
  return {
    crawlId: nextId(),
    files: ['https://example.com/a.png', 'https://example.com/b.png'],
    pages: 2,
    duplicates: 1,
    filtered: 3,
    disallowed: 0,
    invalid: 0,
    offSite: 0,
    pageFailures: 0,
    truncated: null,
    cancelled: false,
    problems: [],
    problemsDropped: 0,
    ...p,
  };
}

/** In-memory `sites:list`/`save`/`delete` that store what they are given. */
function fakeSites(seed: SiteProfile[] = []) {
  const state = { profiles: structuredClone(seed) };
  const handlers: FakeHandlers = {
    'sites:list': () => ({ profiles: structuredClone(state.profiles) }),
    'sites:save': (request) => {
      const { id, url, ...fields } = request;
      if (id === undefined) {
        const created = { id: nextId(), site: new URL(url!).hostname.replace(/^www\./, ''), ...fields };
        state.profiles = [...state.profiles, created];
        return structuredClone(created);
      }
      const before = state.profiles.find((p) => p.id === id)!;
      const next = { ...before, ...fields };
      state.profiles = state.profiles.map((p) => (p.id === id ? next : p));
      return structuredClone(next);
    },
    'sites:delete': ({ id }) => {
      state.profiles = state.profiles.filter((p) => p.id !== id);
      return {};
    },
    'sites:openLogin': () => ({}),
    'sites:crawl': () => crawlOf(),
    'sites:crawlProgress': () => null,
    'sites:cancelCrawl': () => ({ cancelling: true }),
    'sites:import': () => urlImportResultOf({ queued: 2 }),
  };
  return { state, handlers };
}

function setup(seed: SiteProfile[] = [], handlers: FakeHandlers = {}, target: FileTarget | null = null) {
  const sites = fakeSites(seed);
  const api = installFakeApi({ ...sites.handlers, ...handlers });
  const onClose = vi.fn();
  const onImported = vi.fn();
  render(
    <JobsProvider>
      <SiteImportDialog target={target} onClose={onClose} onImported={onImported} />
    </JobsProvider>,
  );
  return { api, sites, onClose, onImported, user: userEvent.setup() };
}

type Api = ReturnType<typeof setup>['api'];
const dialog = () => screen.getByRole('dialog', { name: 'Import from site' });
const field = (name: string) => within(dialog()).getByRole('textbox', { name }) as HTMLInputElement;
const button = (name: string) => within(dialog()).getByRole('button', { name }) as HTMLButtonElement;
const requests = (api: Api, channel: string) => api.calls.filter((c) => c.channel === channel).map((c) => c.request);

async function retype(user: ReturnType<typeof userEvent.setup>, name: string, text: string) {
  await user.clear(field(name));
  if (text !== '') await user.type(field(name), text);
}

/** Opens with one saved profile and runs a test of `url`. */
async function tested(handlers: FakeHandlers = {}, target: FileTarget | null = null) {
  const profile = profileOf();
  const ctx = setup([profile], handlers, target);
  await waitFor(() => expect(field('Name').value).toBe('Shop'));
  await ctx.user.type(field('Gallery URL'), 'https://example.com/gallery');
  await ctx.user.click(button('Test'));
  await within(dialog()).findByRole('list', { name: 'Found files' });
  return { ...ctx, profile };
}

it('the state module sends Min. size in bytes and refuses fields the schema refuses', () => {
  expect(bytesOfKb('2')).toBe(2048);
  expect(bytesOfKb('0.5')).toBe(512);
  expect(bytesOfKb('x')).toBeNull();
  const profile = profileOf({ minBytes: 4096 });
  const draft = draftOf(profile);
  expect(draft.minKb).toBe('4');
  expect(saveRequestOf(draft, profile.id)).toMatchObject({ id: profile.id, minBytes: 4096 });
  expect(saveRequestOf({ ...draft, maxPages: '0' }, profile.id)).toBeNull();
  expect(saveRequestOf({ ...draft, maxFiles: '5001' }, profile.id)).toBeNull();
  expect(saveRequestOf({ ...draft, kinds: [] }, profile.id)).toBeNull();
  expect(saveRequestOf({ ...draft, thumbnails: ' ' }, profile.id)).toBeNull();
  expect(saveRequestOf(draft, null)).toBeNull();
  expect(saveRequestOf({ ...draft, siteAddress: 'https://www.example.com/' }, null)).toMatchObject({
    url: 'https://www.example.com/',
  });
});

it('without profiles a new one is created: the form saves and the list reloads with it', async () => {
  const { api, sites, user } = setup();
  await waitFor(() => expect(requests(api, 'sites:list')).toHaveLength(1));
  expect(button('Save').disabled).toBe(true);
  expect(button('Delete').disabled).toBe(true);
  expect(button('Log in').disabled).toBe(true);
  await user.type(field('Name'), 'Shop');
  await user.type(field('Site address'), 'https://www.example.com/');
  await user.type(field('Thumbnails XPath'), '//a');
  await user.click(within(dialog()).getByRole('checkbox', { name: 'Document' }));
  await retype(user, 'Min. size', '2');
  await retype(user, 'Max. pages', '5');
  await user.click(button('Save'));
  await waitFor(() => expect(sites.state.profiles).toHaveLength(1));
  expect(requests(api, 'sites:save')[0]).toEqual({
    url: 'https://www.example.com/',
    name: 'Shop',
    thumbnails: '//a',
    pagination: '',
    file: '',
    kinds: ['image', 'video', 'document'],
    minBytes: 2048,
    urlContains: '',
    maxPages: 5,
    maxFiles: 1000,
  });
  // Saved: the site is shown read-only, the select names the profile, Delete and Log in are offered.
  await waitFor(() => expect(within(dialog()).queryByRole('textbox', { name: 'Site address' })).toBeNull());
  expect(within(dialog()).getByText('example.com')).toBeTruthy();
  const select = within(dialog()).getByRole('combobox', { name: 'Profile' }) as HTMLSelectElement;
  expect(select.selectedOptions[0]!.textContent).toBe('Shop');
  expect(button('Delete').disabled).toBe(false);
  expect(button('Log in').disabled).toBe(false);
  expect(button('Save').disabled).toBe(true);
});

it('an existing profile is edited and saved with its id, and a switch shows the other profile', async () => {
  const first = profileOf({ name: 'One', minBytes: 1024 });
  const second = profileOf({ name: 'Two', site: 'other.org', urlContains: 'full' });
  const { api, user } = setup([first, second]);
  await waitFor(() => expect(field('Name').value).toBe('One'));
  expect(field('Min. size').value).toBe('1');
  await retype(user, 'URL contains', 'large');
  await user.click(button('Save'));
  await waitFor(() => expect(requests(api, 'sites:save')).toHaveLength(1));
  expect(requests(api, 'sites:save')[0]).toMatchObject({ id: first.id, urlContains: 'large', minBytes: 1024 });
  expect(requests(api, 'sites:save')[0]).not.toHaveProperty('url');
  await user.selectOptions(within(dialog()).getByRole('combobox', { name: 'Profile' }), second.id);
  expect(field('Name').value).toBe('Two');
  expect(field('URL contains').value).toBe('full');
  expect(within(dialog()).getByText('other.org')).toBeTruthy();
});

it('a failed save shows the message as given', async () => {
  const { user } = setup([profileOf()], {
    'sites:save': () => {
      throw fakeError('invalid_operation', 'A site profile with this name already exists');
    },
  });
  await waitFor(() => expect(field('Name').value).toBe('Shop'));
  await retype(user, 'Name', 'Other');
  await user.click(button('Save'));
  expect((await within(dialog()).findByRole('alert')).textContent).toBe('A site profile with this name already exists');
});

it('Delete asks first and then removes the profile', async () => {
  const profile = profileOf();
  const { api, sites, user } = setup([profile]);
  await waitFor(() => expect(field('Name').value).toBe('Shop'));
  await user.click(button('Delete'));
  const confirm = await screen.findByRole('dialog', { name: 'Delete profile Shop?' });
  await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(sites.state.profiles).toEqual([]));
  expect(requests(api, 'sites:delete')).toEqual([{ id: profile.id }]);
  await waitFor(() => expect(field('Name').value).toBe(''));
});

it('Log in calls sites:openLogin with the profile, and the gallery URL when it belongs to the site', async () => {
  const profile = profileOf();
  const { api, user } = setup([profile]);
  await waitFor(() => expect(field('Name').value).toBe('Shop'));
  await user.click(button('Log in'));
  await user.type(field('Gallery URL'), 'https://shop.example.com/g');
  await user.click(button('Log in'));
  await retype(user, 'Gallery URL', 'https://elsewhere.test/g');
  await user.click(button('Log in'));
  await waitFor(() => expect(requests(api, 'sites:openLogin')).toHaveLength(3));
  expect(requests(api, 'sites:openLogin')).toEqual([
    { profileId: profile.id },
    { profileId: profile.id, url: 'https://shop.example.com/g' },
    { profileId: profile.id },
  ]);
});

it('Test shows the counts and the list of found files, and enables Import', async () => {
  const { api, profile } = await tested({
    'sites:crawl': () =>
      crawlOf({ disallowed: 4, invalid: 5, offSite: 7, pageFailures: 6, truncated: 'files', cancelled: true }),
  });
  expect(requests(api, 'sites:crawl')).toEqual([{ profileId: profile.id, url: 'https://example.com/gallery' }]);
  const text = dialog().textContent!;
  for (const line of [
    'Pages 2',
    'Files 2',
    'Duplicates 1',
    'Filtered 3',
    'Disallowed 4',
    'Not usable 5',
    'Off site 7',
    'Page failures 6',
    'Stopped at Max. files',
    'Cancelled',
  ])
    expect(text).toContain(line);
  const list = within(dialog()).getByRole('list', { name: 'Found files' });
  expect(
    within(list)
      .getAllByRole('listitem')
      .map((li) => li.textContent),
  ).toEqual(['https://example.com/a.png', 'https://example.com/b.png']);
  expect(button('Import').disabled).toBe(false);
});

it('lists every problem with its reason and the shortened URL, the full URL in the title, and the dropped count', async () => {
  const problems: SiteCrawlProblem[] = [
    { url: 'https://example.com/g?p=2', stage: 'gallery', reason: 'no_thumbnails', detail: null },
    { url: 'https://example.com/d/1', stage: 'detail', reason: 'no_file', detail: null },
    { url: 'https://example.com/d/2', stage: 'detail', reason: 'left_site', detail: 'login.example.org' },
    { url: 'https://example.com/d/3', stage: 'detail', reason: 'left_site', detail: '' },
    { url: 'https://example.com/d/4', stage: 'detail', reason: 'http_error', detail: '404' },
    { url: 'https://example.com/d/5', stage: 'detail', reason: 'timeout', detail: null },
    { url: 'https://example.com/d/6', stage: 'detail', reason: 'load_failed', detail: null },
    { url: 'https://example.com/private/7.png', stage: 'file', reason: 'robots_disallowed', detail: null },
    { url: 'https://cdn.other.org/8.png', stage: 'file', reason: 'robots_unavailable', detail: 'cdn.other.org' },
    { url: 'https://example.com/g', stage: 'link', reason: 'invalid_link', detail: 'javascript:void(0)' },
    { url: 'https://other.org/d/9', stage: 'detail', reason: 'off_site', detail: null },
    { url: 'https://example.com/a.pdf', stage: 'file', reason: 'filtered_kind', detail: null },
    { url: 'https://example.com/small/b.png', stage: 'file', reason: 'filtered_text', detail: null },
  ];
  await tested({ 'sites:crawl': () => crawlOf({ problems, problemsDropped: 7 }) });
  const list = within(dialog()).getByRole('list', { name: 'Problems' });
  const items = within(list).getAllByRole('listitem');
  expect(items.map((li) => li.firstElementChild?.textContent ?? li.textContent)).toEqual([
    'No thumbnail matched on this page',
    'No file matched on this page',
    'Redirected to login.example.org',
    'Redirected off the site',
    'The site answered HTTP 404',
    'The page did not finish loading',
    'The page could not be loaded',
    'Disallowed by robots.txt',
    'robots.txt of cdn.other.org could not be read',
    'Not a usable link: javascript:void(0)',
    'Link leaves the site',
    'Left out by the kinds filter',
    'Left out by the address filter',
    'and 7 more',
  ]);
  const address = items[7]!.lastElementChild as HTMLElement;
  expect(address.textContent).toBe('example.com/7.png');
  expect(address.getAttribute('title')).toBe('https://example.com/private/7.png');
  expect(within(list).queryAllByRole('link')).toEqual([]);
  // Files were found: no headline.
  expect(within(dialog()).queryByText('No files found')).toBeNull();
});

it('shows no problem list for a test without problems', async () => {
  await tested();
  expect(within(dialog()).queryByRole('list', { name: 'Problems' })).toBeNull();
});

for (const [what, problems, headline] of [
  ['no problem', [], 'No files found'],
  [
    'no thumbnail on the first page',
    [{ url: 'https://example.com/g', stage: 'gallery', reason: 'no_thumbnails', detail: null }],
    'No thumbnail matched. The login may have expired, or the expression does not fit',
  ],
  [
    'a redirect off the site',
    [{ url: 'https://example.com/g', stage: 'gallery', reason: 'left_site', detail: 'login.example.org' }],
    'The site redirected to login.example.org. Log in again',
  ],
  [
    'HTTP 401',
    [{ url: 'https://example.com/g', stage: 'gallery', reason: 'http_error', detail: '401' }],
    'The site refused the page (HTTP 401). Log in again',
  ],
  [
    'HTTP 403',
    [{ url: 'https://example.com/g', stage: 'gallery', reason: 'http_error', detail: '403' }],
    'The site refused the page (HTTP 403). Log in again',
  ],
  [
    'HTTP 500',
    [{ url: 'https://example.com/g', stage: 'gallery', reason: 'http_error', detail: '500' }],
    'The site answered HTTP 500',
  ],
  [
    'a timeout',
    [{ url: 'https://example.com/g', stage: 'gallery', reason: 'timeout', detail: null }],
    'The page did not finish loading',
  ],
  [
    'robots.txt',
    [{ url: 'https://example.com/g', stage: 'gallery', reason: 'robots_disallowed', detail: null }],
    'Disallowed by robots.txt',
  ],
] as const) {
  it(`a test without files heads the problems with one line for ${what}`, async () => {
    const { user } = setup([profileOf()], { 'sites:crawl': () => crawlOf({ files: [], problems: [...problems] }) });
    await waitFor(() => expect(field('Name').value).toBe('Shop'));
    await user.type(field('Gallery URL'), 'https://example.com/g');
    await user.click(button('Test'));
    await within(dialog()).findByText('Files 0');
    const lines = Array.from(dialog().querySelectorAll('p')).map((p) => p.textContent);
    expect(lines.filter((line) => line === headline)).toHaveLength(1);
  });
}

it('a cancelled test without files shows the cancelled state and no diagnosis', async () => {
  const { user } = setup([profileOf()], {
    'sites:crawl': () =>
      crawlOf({
        files: [],
        cancelled: true,
        problems: [{ url: 'https://example.com/g', stage: 'gallery', reason: 'no_thumbnails', detail: null }],
      }),
  });
  await waitFor(() => expect(field('Name').value).toBe('Shop'));
  await user.type(field('Gallery URL'), 'https://example.com/g');
  await user.click(button('Test'));
  await within(dialog()).findByText('Files 0');
  const lines = Array.from(dialog().querySelectorAll('p')).map((p) => p.textContent ?? '');
  expect(lines.some((line) => line.startsWith('No thumbnail matched.'))).toBe(false);
  expect(lines).not.toContain('No files found');
});

it('reads a robots_unavailable problem without a host sensibly', async () => {
  await tested({
    'sites:crawl': () =>
      crawlOf({
        problems: [{ url: 'https://cdn.other.org/8.png', stage: 'file', reason: 'robots_unavailable', detail: '' }],
      }),
  });
  expect(within(dialog()).getByText('robots.txt could not be read')).toBeTruthy();
});

it('Import stays disabled for a test without files, for a new profile and for unsaved changes', async () => {
  const { user } = setup([profileOf()], { 'sites:crawl': () => crawlOf({ files: [] }) });
  await waitFor(() => expect(field('Name').value).toBe('Shop'));
  expect(button('Import').disabled).toBe(true);
  expect(button('Test').disabled).toBe(true);
  await user.type(field('Gallery URL'), 'https://example.com/g');
  await user.click(button('Test'));
  expect(await within(dialog()).findByText('Files 0')).toBeTruthy();
  expect(button('Import').disabled).toBe(true);
  // Unsaved changes block a test too.
  await user.type(field('Name'), 'x');
  expect(button('Test').disabled).toBe(true);
});

for (const [what, change] of [
  ['a field edit', async (user: ReturnType<typeof userEvent.setup>) => user.type(field('File XPath'), '//img')],
  ['a URL change', async (user: ReturnType<typeof userEvent.setup>) => user.type(field('Gallery URL'), '2')],
  [
    'a kind change',
    async (user: ReturnType<typeof userEvent.setup>) =>
      user.click(within(dialog()).getByRole('checkbox', { name: 'Video' })),
  ],
] as const) {
  it(`${what} clears the test answer and disables Import`, async () => {
    const { user } = await tested();
    await change(user);
    expect(within(dialog()).queryByRole('list', { name: 'Found files' })).toBeNull();
    expect(button('Import').disabled).toBe(true);
  });
}

it('a save clears the test answer', async () => {
  const { user } = await tested();
  await user.type(field('URL contains'), 'a');
  await user.click(button('Save'));
  await waitFor(() => expect(button('Save').disabled).toBe(true));
  expect(within(dialog()).queryByRole('list', { name: 'Found files' })).toBeNull();
  expect(button('Import').disabled).toBe(true);
  // Testing the saved profile again enables Import.
  await user.click(button('Test'));
  await within(dialog()).findByRole('list', { name: 'Found files' });
  expect(button('Import').disabled).toBe(false);
});

it('a profile switch and New clear the test answer', async () => {
  const first = profileOf({ name: 'One' });
  const second = profileOf({ name: 'Two' });
  const { user } = setup([first, second]);
  await waitFor(() => expect(field('Name').value).toBe('One'));
  await user.type(field('Gallery URL'), 'https://example.com/g');
  await user.click(button('Test'));
  await within(dialog()).findByRole('list', { name: 'Found files' });
  await user.selectOptions(within(dialog()).getByRole('combobox', { name: 'Profile' }), second.id);
  expect(within(dialog()).queryByRole('list', { name: 'Found files' })).toBeNull();
  expect(button('Import').disabled).toBe(true);
  await user.click(button('Test'));
  await within(dialog()).findByRole('list', { name: 'Found files' });
  await user.click(button('New'));
  expect(within(dialog()).queryByRole('list', { name: 'Found files' })).toBeNull();
  expect(field('Name').value).toBe('');
  expect(button('Test').disabled).toBe(true);
});

it('shows the progress with Cancel while a test runs; Cancel calls sites:cancelCrawl', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const answer = deferred<SiteCrawlResult>();
    const progress = { pages: 1, files: 7, cancelling: false };
    const profile = profileOf();
    const { api } = setup([profile], {
      'sites:crawl': () => answer.promise,
      'sites:crawlProgress': () => progress,
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await waitFor(() => expect(field('Name').value).toBe('Shop'));
    await user.type(field('Gallery URL'), 'https://example.com/g');
    await user.click(button('Test'));
    expect(button('Test').disabled).toBe(true);
    expect(field('Gallery URL').readOnly).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(await within(dialog()).findByText('1 pages, 7 files')).toBeTruthy();
    await user.click(button('Cancel'));
    expect(requests(api, 'sites:cancelCrawl')).toHaveLength(1);
    expect(button('Cancel').disabled).toBe(true);
    answer.resolve(crawlOf({ cancelled: true }));
    expect(await within(dialog()).findByText('Cancelled')).toBeTruthy();
    expect(within(dialog()).queryByText('1 pages, 7 files')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('a failed test shows the message as given and no list', async () => {
  const { user } = setup([profileOf()], {
    'sites:crawl': () => {
      throw fakeError('invalid_operation', "The site's robots.txt could not be read");
    },
  });
  await waitFor(() => expect(field('Name').value).toBe('Shop'));
  await user.type(field('Gallery URL'), 'https://example.com/g');
  await user.click(button('Test'));
  expect((await within(dialog()).findByRole('alert')).textContent).toBe("The site's robots.txt could not be read");
  expect(within(dialog()).queryByRole('list', { name: 'Found files' })).toBeNull();
  expect(button('Import').disabled).toBe(true);
});

it('Import sends the crawl id and a null target from the inbox and shows the URL import result', async () => {
  const crawl = crawlOf();
  const { api, user, onClose, onImported } = await tested({
    'sites:crawl': () => crawl,
    'sites:import': () => urlImportResultOf({ queued: 1, alreadyImported: 1 }),
  });
  await user.click(button('Import'));
  expect(await within(dialog()).findByText('Queued 1')).toBeTruthy();
  expect(within(dialog()).getByText('Already imported 1')).toBeTruthy();
  expect(requests(api, 'sites:import')).toEqual([{ crawlId: crawl.crawlId, target: null }]);
  expect(onImported).toHaveBeenCalled();
  const close = within(dialog()).getByRole('button', { name: 'Close' });
  await waitFor(() => expect(document.activeElement).toBe(close));
  await user.click(close);
  expect(onClose).toHaveBeenCalled();
});

it('Import passes the screen target through', async () => {
  const target = { assetId: '11111111-1111-4111-8111-111111111111', role: 'concept' } as const;
  const crawl = crawlOf();
  const { api, user } = await tested({ 'sites:crawl': () => crawl }, target);
  await user.click(button('Import'));
  await within(dialog()).findByText('Queued 2');
  expect(requests(api, 'sites:import')).toEqual([{ crawlId: crawl.crawlId, target }]);
});

it('a failed import shows the message as given and keeps the answer', async () => {
  const { user } = await tested({
    'sites:import': () => {
      throw fakeError('invalid_operation', 'Run the test again');
    },
  });
  await user.click(button('Import'));
  expect((await within(dialog()).findByRole('alert')).textContent).toBe('Run the test again');
  expect(within(dialog()).getByRole('list', { name: 'Found files' })).toBeTruthy();
});

it('every button has the one look, and the fields carry their tooltips', async () => {
  setup([profileOf()]);
  await waitFor(() => expect(field('Name').value).toBe('Shop'));
  const buttons = within(dialog()).getAllByRole('button');
  expect(new Set(buttons.map((b) => b.className)).size).toBe(1);
  for (const name of ['Thumbnails XPath', 'Pagination XPath', 'File XPath', 'Min. size', 'URL contains', 'Gallery URL'])
    expect(field(name).getAttribute('title')).toBeTruthy();
});
