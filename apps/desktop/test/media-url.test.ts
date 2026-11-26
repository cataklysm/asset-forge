import { describe, expect, it } from 'vitest';
import { parseOriginalUrl, parsePreviewUrl } from '../src/main/media-protocol.js';
import { formatLabel, originalUrl, previewUrl, viewUrl } from '../src/renderer/src/media-url.js';

const ID = '0b9f6c1e-1111-4222-8333-444455556666';

describe('previewUrl', () => {
  it('builds the internal protocol url', () => {
    expect(previewUrl(ID, 'thumb')).toBe(`assetforge-media://preview/${ID}?size=thumb`);
    expect(previewUrl(ID, 'detail')).toBe(`assetforge-media://preview/${ID}?size=detail`);
    expect(previewUrl(ID, 'full')).toBe(`assetforge-media://preview/${ID}?size=full`);
  });

  it.each(['thumb', 'detail', 'full'] as const)('builds a %s url the main process accepts', (size) => {
    expect(parsePreviewUrl(previewUrl(ID, size))).toEqual({ fileId: ID, size });
  });
});

describe('originalUrl', () => {
  it('builds the original url the main process accepts', () => {
    expect(originalUrl(ID)).toBe(`assetforge-media://original/${ID}`);
    expect(parseOriginalUrl(originalUrl(ID))).toEqual({ fileId: ID });
  });
});

describe('viewUrl', () => {
  it.each([
    ['original', 'image/png', 1600, 2000, `assetforge-media://original/${ID}`],
    ['original', 'image/avif', 8192, 8192, `assetforge-media://original/${ID}`],
    ['converted', 'image/tiff', 1600, 2000, `assetforge-media://preview/${ID}?size=full`],
    ['reduced', 'image/jpeg', 8193, 10, `assetforge-media://preview/${ID}?size=full`],
    ['reduced', 'image/tiff', 10, 9000, `assetforge-media://preview/${ID}?size=full`],
    ['preview', 'image/png', null, null, `assetforge-media://preview/${ID}?size=detail`],
    ['none', 'image/svg+xml', 100, 100, null],
    ['none', 'application/pdf', null, null, null],
  ] as const)('%s for %s %s x %s', (source, mimeType, width, height, url) => {
    expect(viewUrl({ id: ID, mimeType, width, height })).toEqual({ source, url });
  });

  it('builds only urls the main process accepts', () => {
    const files = [
      { mimeType: 'image/webp', width: 10, height: 10 },
      { mimeType: 'image/tiff', width: 10, height: 10 },
      { mimeType: 'image/png', width: 9000, height: 10 },
      { mimeType: 'image/gif', width: null, height: null },
    ];
    for (const file of files) {
      const { url } = viewUrl({ id: ID, ...file });
      expect(url).not.toBeNull();
      expect(parseOriginalUrl(url!) ?? parsePreviewUrl(url!)).toMatchObject({ fileId: ID });
    }
  });
});

describe('formatLabel', () => {
  it.each([
    ['scene.blend', 'BLEND'],
    ['README', 'FILE'],
    ['archive.tar.gz', 'GZ'],
    ['.gitignore', 'FILE'],
    ['name.', 'FILE'],
    ['name...', 'FILE'],
    ['name .PNG ', 'PNG'],
    ['', 'FILE'],
  ])('%j -> %s', (name, label) => {
    expect(formatLabel(name)).toBe(label);
  });
});
