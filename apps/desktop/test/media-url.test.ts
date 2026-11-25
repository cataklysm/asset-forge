import { describe, expect, it } from 'vitest';
import { formatLabel, previewUrl } from '../src/renderer/src/media-url.js';

describe('previewUrl', () => {
  it('builds the internal protocol url', () => {
    const id = '0b9f6c1e-1111-4222-8333-444455556666';
    expect(previewUrl(id, 'thumb')).toBe(`assetforge-media://preview/${id}?size=thumb`);
    expect(previewUrl(id, 'detail')).toBe(`assetforge-media://preview/${id}?size=detail`);
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
