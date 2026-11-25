import { describe, expect, it } from 'vitest';
import { inboxPath, mimeFromFileName, sanitizeFileName, stagingPath, workspaceFolderName } from '../src/index.js';

describe('sanitizeFileName', () => {
  it('replaces unsafe characters', () => {
    expect(sanitizeFileName('Gabriella front.png')).toBe('Gabriella_front.png');
    expect(sanitizeFileName('Größe über alles.JPG')).toBe('Größe_über_alles.JPG');
  });
  it('keeps Unicode letters and digits', () => {
    expect(sanitizeFileName('Портрет.png')).toBe('Портрет.png');
    expect(sanitizeFileName('资产.png')).toBe('资产.png');
    expect(sanitizeFileName('٣ drafts.txt')).toBe('٣_drafts.txt');
  });
  it('keeps the extension behind a placeholder when the stem has no allowed character', () => {
    expect(sanitizeFileName('???.png')).toBe('file.png');
    expect(sanitizeFileName('<>|.png')).toBe('file.png');
    expect(sanitizeFileName('_.png')).toBe('file.png');
  });
  it('strips trailing dots and spaces, which Windows drops when creating the file', () => {
    expect(sanitizeFileName('a.')).toBe('a');
    expect(sanitizeFileName('a. ')).toBe('a');
    expect(sanitizeFileName('a . .')).toBe('a');
    expect(sanitizeFileName('a.png.')).toBe('a.png');
    expect(sanitizeFileName('. .')).toBe('file');
  });
  it('never ends in a dot after truncation', () => {
    const r = sanitizeFileName(`${'a'.repeat(99)}.${'b'.repeat(20)}`);
    expect(r).toBe('a'.repeat(99));
  });
  it('never keeps separators, parent segments or reserved characters', () => {
    for (const name of ['a:b*c?.png', 'x"y<z>|.txt', '..\\..\\Портрет.png', 'a/../b.png']) {
      const r = sanitizeFileName(name);
      expect(r).not.toMatch(/[\\/:*?"<>|]/);
      expect(r).not.toContain('..');
    }
  });
  it('keeps the base name only', () => {
    expect(sanitizeFileName('..\\..\\evil/../x.png')).toBe('x.png');
    expect(sanitizeFileName('C:\\dir\\x.png')).toBe('x.png');
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

describe('workspaceFolderName', () => {
  it('keeps a readable name, including spaces and non-ASCII letters', () => {
    expect(workspaceFolderName('Gilded Hour')).toBe('Gilded Hour');
    expect(workspaceFolderName('Größe über alles')).toBe('Größe über alles');
    expect(workspaceFolderName('资产 2026')).toBe('资产 2026');
  });

  it('replaces separators and characters Windows rejects', () => {
    expect(workspaceFolderName('a/b\\c:d*e?"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i');
    expect(workspaceFolderName('tab\there')).toBe('tab_here');
  });

  it('cannot produce a traversal segment or a hidden or trailing-dot name', () => {
    expect(workspaceFolderName('..')).toBe('workspace');
    expect(workspaceFolderName('../../x')).toBe('_.._x');
    expect(workspaceFolderName('  .name. ')).toBe('name');
  });

  it('falls back to a placeholder when nothing usable is left', () => {
    expect(workspaceFolderName('   ')).toBe('workspace');
    expect(workspaceFolderName('???')).toBe('workspace');
  });

  it('prefixes Windows device names', () => {
    expect(workspaceFolderName('CON')).toBe('_CON');
    expect(workspaceFolderName('nul.txt')).toBe('_nul.txt');
    expect(workspaceFolderName('console')).toBe('console');
  });

  it('limits the length without leaving a trailing space', () => {
    const name = workspaceFolderName(`${'a'.repeat(99)} bcd`);
    expect(name).toBe('a'.repeat(99));
  });
});
