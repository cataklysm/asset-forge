import { ORIGINAL_MIME_TYPES, viewSource } from '@assetforge/contracts';
import { describe, expect, it } from 'vitest';
import {
  FILE_KIND_EXTENSIONS,
  PREVIEWABLE_MIME_TYPES,
  REFUSED_IMPORT_EXTENSIONS,
  diskExtension,
  diskName,
  fileKind,
  importExtension,
  isOpenable,
  isPreviewable,
  isRefusedImport,
  isZipArchive,
} from '../src/index.js';

describe('media types', () => {
  it('every previewable type has a view source and the originals plus tiff are exactly the previewable types', () => {
    for (const type of PREVIEWABLE_MIME_TYPES) expect(viewSource(type, null, null)).toBe('preview');
    expect([...ORIGINAL_MIME_TYPES, 'image/tiff'].sort()).toEqual([...PREVIEWABLE_MIME_TYPES].sort());
  });

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

  it('FILE_KIND_EXTENSIONS and REFUSED_IMPORT_EXTENSIONS match the spec', () => {
    expect(FILE_KIND_EXTENSIONS).toEqual({
      image: ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'gif', 'avif', 'bmp', 'exr', 'hdr', 'tga', 'psd', 'svg'],
      model: [
        'blend', 'glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'usd', 'usda', 'usdc', 'usdz', 'dae', 'abc', 'ztl',
        'spp', 'sbs', 'sbsar',
      ],
      document: ['pdf', 'txt', 'md', 'doc', 'docx', 'odt', 'rtf'],
    });
    expect(REFUSED_IMPORT_EXTENSIONS).toEqual([
      'exe', 'com', 'scr', 'msi', 'msp', 'msix', 'appx', 'appinstaller', 'bat', 'cmd', 'ps1', 'psm1', 'psd1',
      'vbs', 'vbe', 'jse', 'wsf', 'wsh', 'ws', 'wsc', 'sct', 'hta', 'cpl', 'dll', 'sys', 'lnk', 'url', 'pif',
      'reg', 'jar', 'app', 'dmg', 'pkg', 'appimage', 'iso', 'vhd',
    ]);
  });

  it('fileKind by extension', () => {
    expect(fileKind('a.PNG')).toBe('image');
    expect(fileKind('scene.blend')).toBe('model');
    expect(fileKind('a.exe.txt')).toBe('document');
    for (const name of ['a.py', 'README', 'a.']) expect(fileKind(name)).toBe('other');
  });

  it('importExtension takes the last extension and counts a leading dot', () => {
    expect(importExtension('Setup.EXE.')).toBe('exe');
    expect(importExtension('a.txt.exe')).toBe('exe');
    expect(importExtension('.bat')).toBe('bat');
    expect(importExtension('run.Bat ')).toBe('bat');
    expect(importExtension('README')).toBeNull();
  });

  it('isRefusedImport', () => {
    for (const name of ['Setup.EXE.', 'a.txt.exe', '.bat', 'x.appimage']) expect(isRefusedImport(name)).toBe(true);
    for (const name of ['a.py', 'a.js', 'a.sh', 'a.html', 'a.svg', 'a.exe.txt']) expect(isRefusedImport(name)).toBe(false);
  });

  it('isZipArchive by import extension', () => {
    for (const name of ['a.zip', 'A.ZIP', 'a.zip. ']) expect(isZipArchive(name)).toBe(true);
    for (const name of ['a.zip.png', 'zip', 'a.zipx']) expect(isZipArchive(name)).toBe(false);
  });

  it('isRefusedImport sees through alternate data streams', () => {
    for (const name of ['a.exe::$DATA', 'a.exe:stream', 'evil.txt:payload.exe']) expect(isRefusedImport(name)).toBe(true);
    expect(isRefusedImport('a.png:stream')).toBe(false);
  });

  it('isOpenable by kind', () => {
    expect(isOpenable('inbox/x_a.exe.txt')).toBe(true);
    expect(isOpenable('assets/a/working/x_scene.blend')).toBe(true);
    expect(isOpenable('inbox/x_Photo.PNG.')).toBe(true);
    for (const name of ['x_a.svg', 'x_a.py', 'x_README', 'x_a.zip']) expect(isOpenable(`inbox/${name}`)).toBe(false);
  });

  it('diskExtension and diskName', () => {
    expect(diskExtension('a.PNG')).toBe('png');
    expect(diskExtension('.hidden')).toBeNull();
    expect(diskExtension('a.')).toBeNull();
    expect(diskName('inbox/x_a.png')).toBe('x_a.png');
    expect(diskName('x_a.png')).toBe('x_a.png');
  });
});
