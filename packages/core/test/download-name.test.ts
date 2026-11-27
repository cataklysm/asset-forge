import { describe, expect, it } from 'vitest';
import { downloadFileName, isWebPage } from '../src/index.js';

const name = (finalUrl: string, contentType: string | null = null, dispositionName: string | null = null) =>
  downloadFileName({ finalUrl, contentType, dispositionName });

describe('downloadFileName', () => {
  it('prefers the Content-Disposition name', () => {
    expect(name('https://a.example/x/photo.png', 'image/png', 'cat.webp')).toBe('cat.webp');
  });

  it('ignores an empty Content-Disposition name', () => {
    expect(name('https://a.example/x/photo.png', 'image/png', '')).toBe('photo.png');
  });

  it('takes the percent-decoded last path segment and sanitises it', () => {
    // sanitizeFileName replaces the space; the spec routes every name through it.
    expect(name('https://a.example/photo%20one', 'image/jpeg')).toBe('photo_one.jpg');
  });

  it('keeps an undecodable segment as it is', () => {
    expect(name('https://a.example/a%E0%A4%A.png')).toBe('a_E0_A4_A.png');
  });

  it('answers download without a path segment', () => {
    expect(name('https://a.example/')).toBe('download');
    expect(name('https://a.example')).toBe('download');
    expect(name('https://a.example/', 'image/png')).toBe('download.png');
  });

  it('never appends to a name with a known kind', () => {
    expect(name('https://a.example/a.png', 'image/jpeg')).toBe('a.png');
    expect(name('https://a.example/model.glb', 'application/octet-stream')).toBe('model.glb');
  });

  it('does not append an extension the name already has from the map', () => {
    expect(name('https://a.example/pack.zip', 'application/zip')).toBe('pack.zip');
    expect(name('https://a.example/pack.zip', 'image/png')).toBe('pack.zip');
  });

  it('appends the extension of a known content type to an unknown name', () => {
    const cases: [string, string][] = [
      ['image/jpeg', 'x.jpg'],
      ['image/png', 'x.png'],
      ['image/webp', 'x.webp'],
      ['image/gif', 'x.gif'],
      ['image/avif', 'x.avif'],
      ['image/tiff', 'x.tiff'],
      ['image/bmp', 'x.bmp'],
      ['image/svg+xml', 'x.svg'],
      ['application/pdf', 'x.pdf'],
      ['application/zip', 'x.zip'],
      ['model/gltf-binary', 'x.glb'],
    ];
    for (const [type, expected] of cases) expect(name('https://a.example/x', type)).toBe(expected);
    expect(name('https://a.example/x', 'application/octet-stream')).toBe('x');
    expect(name('https://a.example/x', null)).toBe('x');
  });

  it('a long name keeps its appended extension', () => {
    const result = name(`https://a.example/${'a'.repeat(400)}`, 'image/png');
    expect(result.endsWith('.png')).toBe(true);
    expect([...result].length).toBe(100);
  });

  it('strips a path from the disposition name', () => {
    expect(name('https://a.example/x', null, '../../evil.png')).toBe('evil.png');
  });
});

describe('isWebPage', () => {
  it('is true for HTML and XHTML only', () => {
    expect(isWebPage('text/html')).toBe(true);
    expect(isWebPage('application/xhtml+xml')).toBe(true);
    expect(isWebPage('TEXT/HTML; charset=utf-8')).toBe(true);
    expect(isWebPage('image/png')).toBe(false);
    expect(isWebPage('text/plain')).toBe(false);
    expect(isWebPage(null)).toBe(false);
  });
});
