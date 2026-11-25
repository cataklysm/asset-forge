import { describe, expect, it } from 'vitest';
import {
  BLOCKED_OPEN_EXTENSIONS,
  PREVIEWABLE_MIME_TYPES,
  diskExtension,
  diskName,
  isOpenable,
  isPreviewable,
} from '../src/index.js';

describe('media types', () => {
  it('previewable types are exactly the six raster formats', () => {
    expect(PREVIEWABLE_MIME_TYPES).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/tiff',
      'image/gif',
      'image/avif',
    ]);
    expect(isPreviewable('image/png')).toBe(true);
    expect(isPreviewable('image/x-exr')).toBe(false);
    expect(isPreviewable('image/svg+xml')).toBe(false);
  });

  it('the block list is the spec list', () => {
    // Literal list from the phase 3a design spec ("Open externally / show in folder").
    expect(BLOCKED_OPEN_EXTENSIONS).toEqual([
      'exe',
      'com',
      'bat',
      'cmd',
      'msi',
      'scr',
      'pif',
      'lnk',
      'ps1',
      'vbs',
      'vbe',
      'js',
      'jse',
      'wsf',
      'wsh',
      'hta',
      'jar',
      'sh',
      'app',
      'command',
      'desktop',
      'html',
      'htm',
      'svg',
      'url',
      'reg',
      'py',
      'pyw',
      'psm1',
      'chm',
      'jnlp',
      'application',
      'appref-ms',
      'settingcontent-ms',
      'library-ms',
      'msc',
      'cpl',
      'msp',
      'scf',
      'inf',
      'website',
      'diagcab',
    ]);
  });

  it.each([
    ['a.txt.exe', false],
    ['a.exe.txt', true],
    ['.bat', false],
    ['a.bat.', false],
    ['a.BAT ', false],
    ['README', false],
  ])('isOpenable(%j) is %s', (name, expected) => {
    expect(isOpenable(name)).toBe(expected);
    expect(isOpenable(`inbox/${name}`)).toBe(expected);
  });

  it('isOpenable normalises case and trailing dots and spaces', () => {
    expect(isOpenable('inbox/x_Setup.EXE.')).toBe(false);
    expect(isOpenable('inbox/x_run.Bat ')).toBe(false);
    expect(isOpenable('assets/a/working/x_scene.blend')).toBe(true);
    expect(isOpenable('inbox/x_README')).toBe(false);
    expect(isOpenable('inbox/x_file.appref-ms')).toBe(false);
  });

  it('diskExtension and diskName', () => {
    expect(diskExtension('a.PNG')).toBe('png');
    expect(diskExtension('.hidden')).toBeNull();
    expect(diskExtension('a.')).toBeNull();
    expect(diskName('inbox/x_a.png')).toBe('x_a.png');
    expect(diskName('x_a.png')).toBe('x_a.png');
  });
});
