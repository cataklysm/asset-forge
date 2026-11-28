import { describe, expect, it } from 'vitest';
import { createPageLoader, type PageView } from '../src/main/site-page-loader.js';

const timing = { pollMs: 2, settleMs: 50, totalMs: 150 };
const request = { queries: { file: '//img/@src' }, waitFor: 'file', signal: new AbortController().signal };

function viewFor(values: (call: number) => string[], unsettled = false) {
  let calls = 0;
  const view: PageView = {
    navigate: async (_url, onParsed) => {
      onParsed?.();
      if (unsettled) return new Promise(() => {});
      return 'loaded';
    },
    evaluate: async () => ({
      results: { file: values(++calls) },
      counts: { file: 1 },
      baseUrl: 'https://gallery.test/d/1',
    }),
    currentUrl: () => 'https://gallery.test/d/1',
    stop: () => {},
    onLeftSite: () => {},
    onResponse: () => {},
  };
  return { view, calls: () => calls };
}

describe('usable extraction readiness', () => {
  it('waits for URL values even when the selected DOM node already exists', async () => {
    const { view, calls } = viewFor((call) => (call < 3 ? [] : ['/original.jpg']));
    const result = await createPageLoader(view, 'gallery.test', timing).load('https://gallery.test/d/1', request);
    expect(result).toMatchObject({ ok: true, results: { file: ['/original.jpg'] } });
    expect(calls()).toBeGreaterThanOrEqual(3);
  });

  it('uses stable URL values instead of stable node counts while a page is still loading', async () => {
    const { view, calls } = viewFor((call) => [call === 1 ? '/placeholder.jpg' : '/original.jpg'], true);
    const result = await createPageLoader(view, 'gallery.test', timing).load('https://gallery.test/d/1', request);
    expect(result).toMatchObject({ ok: true, results: { file: ['/original.jpg'] } });
    expect(calls()).toBeGreaterThanOrEqual(3);
  });

  it('waits for stable URL results when scripts append links after the document loaded', async () => {
    const { view, calls } = viewFor((call) => (call === 1 ? ['/first.jpg'] : ['/first.jpg', '/second.jpg']));
    const result = await createPageLoader(view, 'gallery.test', timing).load('https://gallery.test/d/1', request);
    expect(result).toMatchObject({ ok: true, results: { file: ['/first.jpg', '/second.jpg'] } });
    expect(calls()).toBeGreaterThanOrEqual(3);
  });
});
