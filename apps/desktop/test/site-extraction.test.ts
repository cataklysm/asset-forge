// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { EXTRACT_LIMITS, extractionCode, readExtraction } from '../src/main/site-sessions.js';

// The extraction script runs here against jsdom's XPath, the closest stand-in for the page's isolated world that
// the test Electron (ELECTRON_RUN_AS_NODE) allows.

const run = (queries: Record<string, string>, limits = EXTRACT_LIMITS): unknown => (0, eval)(extractionCode(queries, limits));

beforeEach(() => {
  document.body.innerHTML = `
    <div id="gallery">
      <a class="thumb" href="/full/1.jpg"><img src="/thumb/1.jpg"></a>
      <a class="thumb" href="https://cdn.example.com/2.png">two</a>
      <img class="lone" src="3.webp">
      <span class="plain">no link</span>
      <p class="text">/text/4.jpg</p>
      <!-- a comment -->
      <nav><a class="next" href="?page=2">next</a></nav>
    </div>`;
});

describe('extraction script', () => {
  it('takes href, else src, an attribute value or a text node, and ignores anything else', () => {
    const raw = run({
      thumbnails: '//a[@class="thumb"] | //img[@class="lone"] | //span[@class="plain"] | //comment()',
      attribute: '//img/@src',
      text: '//p[@class="text"]/text()',
      pagination: '//a[@class="next"]',
    });
    expect(raw).toEqual({
      results: {
        thumbnails: ['/full/1.jpg', 'https://cdn.example.com/2.png', '3.webp'],
        attribute: ['/thumb/1.jpg', '3.webp'],
        text: ['/text/4.jpg'],
        pagination: ['?page=2'],
      },
      counts: { thumbnails: 5, attribute: 2, text: 1, pagination: 1 },
    });
  });

  it('names the query whose expression is not valid XPath', () => {
    expect(run({ thumbnails: '//a', pagination: '//a[' })).toEqual({ invalid: 'pagination' });
    expect(readExtraction(run({ file: 'count(//a)' }), ['file'])).toEqual({ kind: 'invalid', query: 'file' });
  });

  it('never runs an expression as code', () => {
    const globals = globalThis as { pwned?: number };
    for (const query of [`'); globalThis.pwned = 1; ('`, `"); globalThis.pwned = 1; ("`, '</script><script>globalThis.pwned=1</script>', '${globalThis.pwned = 1}']) {
      expect(run({ thumbnails: query })).toEqual({ invalid: 'thumbnails' });
    }
    expect(globals.pwned).toBeUndefined();
  });

  it('caps the values per query and the length of each', () => {
    expect(EXTRACT_LIMITS).toEqual({ maxResults: 20_000, maxLength: 10_000 });
    document.body.innerHTML = Array.from({ length: 5 }, (_, i) => `<a href="/${i}-${'x'.repeat(20)}">${i}</a>`).join('');
    const limits = { maxResults: 3, maxLength: 4 };
    const raw = run({ thumbnails: '//a' }, limits);
    expect(raw).toEqual({ results: { thumbnails: ['/0-x', '/1-x', '/2-x'] }, counts: { thumbnails: 5 } });
    expect(readExtraction(raw, ['thumbnails'], limits)).toEqual({
      kind: 'results',
      results: { thumbnails: ['/0-x', '/1-x', '/2-x'] },
      counts: { thumbnails: 5 },
    });
  });
});
