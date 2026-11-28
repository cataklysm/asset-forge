// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXTRACT_LIMITS, extractionCode, readExtraction } from '../src/main/site-extraction.js';

// The extraction script runs here against jsdom's XPath, the closest stand-in for the page's isolated world that
// the test Electron (ELECTRON_RUN_AS_NODE) allows.

const run = (queries: Record<string, string>, limits = EXTRACT_LIMITS): unknown => (0, eval)(extractionCode(queries, limits));

// jsdom's XPath throws plain `Error`s or its own `XPathException` where Chromium throws a `SyntaxError` DOMException
// for an expression it cannot parse and a `TypeError` for one that does not give nodes. The stand-in maps them, so
// the script sees what the page's isolated world would.
const jsdomEvaluate = Document.prototype.evaluate;
function chromiumEvaluate(this: Document, ...args: Parameters<Document['evaluate']>): XPathResult {
  try {
    return jsdomEvaluate.apply(this, args);
  } catch (error) {
    const e = error as { name?: string; code?: number };
    if (e.name === 'XPathException' && e.code === 52) throw new TypeError('The result is not a node set');
    throw new DOMException('The string is not a valid XPath expression', 'SyntaxError');
  }
}

beforeEach(() => {
  Document.prototype.evaluate = chromiumEvaluate;
});

afterEach(() => {
  Document.prototype.evaluate = jsdomEvaluate;
});

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
      baseUrl: document.baseURI,
    });
  });

  it("reports the document's base URL, also one set by a base element", () => {
    const base = document.createElement('base');
    base.setAttribute('href', 'https://example.com/gallery/');
    document.head.append(base);
    try {
      const raw = run({ thumbnails: '//a' });
      expect(raw).toMatchObject({ baseUrl: 'https://example.com/gallery/' });
      expect(readExtraction(raw, ['thumbnails'])).toMatchObject({ kind: 'results', baseUrl: 'https://example.com/gallery/' });
    } finally {
      base.remove();
    }
  });

  it('cannot be clobbered by named elements of the page', () => {
    document.body.innerHTML = `
      <img name="evaluate" src="/e.jpg">
      <img name="baseURI" src="/b.jpg">
      <form id="f" href="/form-href"><input name="getAttribute"><input name="hasAttribute"><input name="nodeType"></form>
      <a class="thumb" href="/full/1.jpg">1</a>`;
    // The page's own world sees the clobbered names; the script must not.
    expect(typeof (document as unknown as { evaluate: unknown }).evaluate).not.toBe('function');
    const raw = run({ thumbnails: '//a[@class="thumb"] | //form | //img' });
    expect(raw).toEqual({
      results: { thumbnails: ['/e.jpg', '/b.jpg', '/form-href', '/full/1.jpg'] },
      counts: { thumbnails: 4 },
      baseUrl: 'http://localhost:3000/',
    });
  });

  it('skips a node it cannot read and keeps the others', () => {
    document.body.innerHTML = '<a href="/1.jpg">1</a><a href="/2.jpg">2</a>';
    const original = Element.prototype.getAttribute;
    let calls = 0;
    Element.prototype.getAttribute = function (this: Element, name: string) {
      calls++;
      if (calls === 1) throw new Error('unreadable');
      return original.call(this, name);
    };
    try {
      expect(run({ thumbnails: '//a' })).toMatchObject({ results: { thumbnails: ['/2.jpg'] }, counts: { thumbnails: 2 } });
    } finally {
      Element.prototype.getAttribute = original;
    }
  });

  it('names the query whose expression is not valid XPath', () => {
    expect(run({ thumbnails: '//a', pagination: '//a[' })).toEqual({ invalid: 'pagination' });
    expect(readExtraction(run({ file: 'count(//a)' }), ['file'])).toEqual({ kind: 'invalid', query: 'file' });
  });

  it('throws any other failure of evaluate instead of calling the expression invalid', () => {
    Document.prototype.evaluate = () => {
      throw new DOMException('The document is gone', 'InvalidStateError');
    };
    expect(() => run({ thumbnails: '//a' })).toThrow('The document is gone');
    Document.prototype.evaluate = () => {
      throw new Error('unexpected');
    };
    expect(() => run({ thumbnails: '//a' })).toThrow('unexpected');
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
    expect(raw).toMatchObject({ results: { thumbnails: ['/0-x', '/1-x', '/2-x'] }, counts: { thumbnails: 5 } });
    expect(readExtraction(raw, ['thumbnails'], limits)).toEqual({
      kind: 'results',
      results: { thumbnails: ['/0-x', '/1-x', '/2-x'] },
      counts: { thumbnails: 5 },
      // A base URL longer than the limit is dropped, not cut.
      baseUrl: '',
    });
  });
});
