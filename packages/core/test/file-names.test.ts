import { describe, expect, it } from 'vitest';
import { inboxPath, mimeFromFileName, sanitizeFileName, stagingPath } from '../src/index.js';

describe('sanitizeFileName', () => {
  it('replaces unsafe characters', () => {
    expect(sanitizeFileName('Gabriella front.png')).toBe('Gabriella_front.png');
    expect(sanitizeFileName('Größe über alles.JPG')).toBe('Gr_e_ber_alles.JPG');
  });
  it('keeps the base name only', () => {
    expect(sanitizeFileName('..\..\evil/../x.png')).toBe('x.png');
  });
  it('strips leading dots', () => {
    expect(sanitizeFileName('..hidden')).toBe('hidden');
  });
  it('falls back to "file"', () => {
    expect(sanitizeFileName('')).toBe('file');
    expect(sanitizeFileName('..')).toBe('file');
  });
  it('truncates to 100 characters keeping the extension', () => {
    const r = sanitizeFileName('a'.repeat(300) + '.png');
    expect(r).toHaveLength(100);
    expect(r.endsWith('.png')).toBe(true);
  });
  it('leaves reserved device names alone', () => {
    expect(sanitizeFileName('CON')).toBe('CON');
  });
});

describe('mimeFromFileName', () => {
  it('maps known extensions case-insensitively', () => {
    expect(mimeFromFileName('a.PNG')).toBe('image/png');
    expect(mimeFromFileName('scene.blend')).toBe('application/x-blender');
    expect(mimeFromFileName('model.glb')).toBe('model/gltf-binary');
  });
  it('falls back to octet-stream', () => {
    expect(mimeFromFileName('noext')).toBe('application/octet-stream');
  });
});

describe('paths', () => {
  const id = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
  it('builds inbox and staging paths', () => {
    expect(inboxPath(id, 'a b.png')).toBe(`inbox/${id}_a_b.png`);
    expect(stagingPath(id)).toBe(`.assetforge/staging/${id}.part`);
  });
});
