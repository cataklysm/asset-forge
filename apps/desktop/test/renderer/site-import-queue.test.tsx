import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SiteCrawlResult, SiteProfile } from '@assetforge/contracts';
import { expect, it } from 'vitest';
import { SiteImportDialog } from '../../src/renderer/src/components/SiteImportDialog';
import { JobsProvider } from '../../src/renderer/src/jobs-context';
import { deferred, installFakeApi } from './fake-api';
import { nextId } from './fixtures';

const profile: SiteProfile = {
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

function ImportHost() {
  const [open, setOpen] = useState(true);
  return (
    <JobsProvider>
      {open && <SiteImportDialog target={null} onClose={() => setOpen(false)} />}
    </JobsProvider>
  );
}

it('closing the import dialog does not cancel URL extraction', async () => {
  const pending = deferred<SiteCrawlResult>();
  const api = installFakeApi({
    'sites:list': () => ({ profiles: [profile] }),
    'sites:crawl': () => pending.promise,
    'sites:crawlProgress': () => null,
    'sites:cancelCrawl': () => ({ cancelling: true }),
  });
  const user = userEvent.setup();
  render(<ImportHost />);
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Gallery'));
  await user.type(screen.getByRole('textbox', { name: 'Gallery URL' }), 'https://example.com/album');
  await user.click(screen.getByRole('button', { name: 'Test' }));
  await waitFor(() => expect(api.calls.some((entry) => entry.channel === 'sites:crawl')).toBe(true));
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.calls.filter((entry) => entry.channel === 'sites:cancelCrawl')).toEqual([]);
});
