import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAppUrl, isAppUrl } from '../src/main/app-url.js';

describe('getAppUrl', () => {
  it('prefers the dev server URL', () => {
    expect(getAppUrl({ devServerUrl: 'http://localhost:5173/', rendererHtmlPath: '/x/index.html' })).toBe(
      'http://localhost:5173/',
    );
  });

  it('uses the file URL of the built renderer otherwise', () => {
    const html = join(process.cwd(), 'out', 'renderer', 'index.html');
    expect(getAppUrl({ devServerUrl: undefined, rendererHtmlPath: html })).toBe(pathToFileURL(html).href);
  });
});

describe('isAppUrl', () => {
  describe('dev server', () => {
    const app = 'http://localhost:5173/';

    it('accepts the same origin with any path, query or hash', () => {
      expect(isAppUrl('http://localhost:5173/', app)).toBe(true);
      expect(isAppUrl('http://localhost:5173/files?x=1#top', app)).toBe(true);
    });

    it('rejects another port, host or scheme', () => {
      expect(isAppUrl('http://localhost:5174/', app)).toBe(false);
      expect(isAppUrl('http://127.0.0.1:5173/', app)).toBe(false);
      expect(isAppUrl('http://localhost.evil.com:5173/', app)).toBe(false);
      expect(isAppUrl('https://localhost:5173/', app)).toBe(false);
      expect(isAppUrl('file:///C:/app/index.html', app)).toBe(false);
    });
  });

  describe('built renderer', () => {
    const app = 'file:///C:/AssetForge/out/renderer/index.html';

    it('accepts exactly that document', () => {
      expect(isAppUrl(app, app)).toBe(true);
    });

    it('accepts the same document with another hash or query (it is still the same file)', () => {
      expect(isAppUrl(`${app}#/files`, app)).toBe(true);
      expect(isAppUrl(`${app}?view=files`, app)).toBe(true);
    });

    it('rejects another file', () => {
      expect(isAppUrl('file:///C:/AssetForge/out/renderer/other.html', app)).toBe(false);
      expect(isAppUrl('file:///C:/Users/someone/Downloads/index.html', app)).toBe(false);
      expect(isAppUrl('file:///C:/AssetForge/out/renderer/', app)).toBe(false);
    });

    it('rejects the same path on another host (a UNC share)', () => {
      expect(isAppUrl('file://evil-server/C:/AssetForge/out/renderer/index.html', app)).toBe(false);
    });

    it('rejects a non-file URL with the same path', () => {
      expect(isAppUrl('http://localhost/C:/AssetForge/out/renderer/index.html', app)).toBe(false);
    });
  });

  it('rejects malformed URLs and an unparseable app URL', () => {
    expect(isAppUrl('not a url', 'http://localhost:5173/')).toBe(false);
    expect(isAppUrl('', 'http://localhost:5173/')).toBe(false);
    expect(isAppUrl('http://localhost:5173/', 'not a url')).toBe(false);
  });

  it('rejects about:, data: and javascript: URLs', () => {
    for (const app of ['http://localhost:5173/', 'file:///C:/AssetForge/out/renderer/index.html']) {
      expect(isAppUrl('about:blank', app)).toBe(false);
      expect(isAppUrl('data:text/html,<h1>x</h1>', app)).toBe(false);
      expect(isAppUrl('javascript:alert(1)', app)).toBe(false);
    }
  });
});
