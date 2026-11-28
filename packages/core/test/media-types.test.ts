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
  isVideo,
  isZipArchive,
  hasThumbnail,
  mimeFromFileName,
  VIDEO_MIME_TYPES,
  videoFormat,
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
        'blend',
        'glb',
        'gltf',
        'fbx',
        'obj',
        'stl',
        'ply',
        'usd',
        'usda',
        'usdc',
        'usdz',
        'dae',
        'abc',
        'ztl',
        'spp',
        'sbs',
        'sbsar',
      ],
      document: ['pdf', 'txt', 'md', 'doc', 'docx', 'odt', 'rtf'],
      video: ['mp4', 'm4v', 'webm'],
    });
    expect(REFUSED_IMPORT_EXTENSIONS).toEqual([
      'exe',
      'com',
      'scr',
      'msi',
      'msp',
      'msix',
      'appx',
      'appinstaller',
      'bat',
      'cmd',
      'ps1',
      'psm1',
      'psd1',
      'vbs',
      'vbe',
      'jse',
      'wsf',
      'wsh',
      'ws',
      'wsc',
      'sct',
      'hta',
      'cpl',
      'dll',
      'sys',
      'lnk',
      'url',
      'pif',
      'reg',
      'jar',
      'app',
      'dmg',
      'pkg',
      'appimage',
      'iso',
      'vhd',
    ]);
  });

  it('fileKind by extension', () => {
    expect(fileKind('a.PNG')).toBe('image');
    expect(fileKind('scene.blend')).toBe('model');
    expect(fileKind('a.exe.txt')).toBe('document');
    for (const name of ['a.py', 'README', 'a.']) expect(fileKind(name)).toBe('other');
  });

  it('fileKind and mimeFromFileName of a video', () => {
    expect(fileKind('clip.MP4')).toBe('video');
    expect(fileKind('clip.m4v')).toBe('video');
    expect(fileKind('clip.webm')).toBe('video');
    expect(mimeFromFileName('clip.MP4')).toBe('video/mp4');
    expect(mimeFromFileName('clip.m4v')).toBe('video/mp4');
    expect(mimeFromFileName('clip.webm')).toBe('video/webm');
  });

  it('kind and MIME type of a video come from one rule', () => {
    for (const name of ['.mp4', 'a.mp4.', 'a.webm ', 'mp4', 'a.mp4.txt', 'a.txt.mp4', 'a.MOV', 'a.mkv', 'a.m4v']) {
      expect(fileKind(name) === 'video').toBe(isVideo(mimeFromFileName(name)));
    }
    expect(mimeFromFileName('.mp4')).toBe('application/octet-stream');
    expect(mimeFromFileName('a.mp4.')).toBe('video/mp4');
  });

  it('video types, hasThumbnail and videoFormat', () => {
    expect(VIDEO_MIME_TYPES).toEqual(['video/mp4', 'video/webm']);
    expect(isVideo('video/mp4')).toBe(true);
    expect(isVideo('video/webm')).toBe(true);
    for (const type of ['video/quicktime', 'image/png', 'application/octet-stream']) expect(isVideo(type)).toBe(false);
    for (const type of [...PREVIEWABLE_MIME_TYPES, ...VIDEO_MIME_TYPES]) expect(hasThumbnail(type)).toBe(true);
    for (const type of ['image/svg+xml', 'image/x-exr', 'video/quicktime', 'application/pdf']) {
      expect(hasThumbnail(type)).toBe(false);
    }
    expect(videoFormat('video/mp4')).toBe('mp4');
    expect(videoFormat('video/webm')).toBe('webm');
    expect(videoFormat('image/png')).toBeNull();
    for (const type of VIDEO_MIME_TYPES) expect(isPreviewable(type)).toBe(false);
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
    for (const name of ['a.py', 'a.js', 'a.sh', 'a.html', 'a.svg', 'a.exe.txt'])
      expect(isRefusedImport(name)).toBe(false);
  });

  it('isZipArchive by import extension', () => {
    for (const name of ['a.zip', 'A.ZIP', 'a.zip. ']) expect(isZipArchive(name)).toBe(true);
    for (const name of ['a.zip.png', 'zip', 'a.zipx']) expect(isZipArchive(name)).toBe(false);
  });

  it('isRefusedImport sees through alternate data streams', () => {
    for (const name of ['a.exe::$DATA', 'a.exe:stream', 'evil.txt:payload.exe'])
      expect(isRefusedImport(name)).toBe(true);
    expect(isRefusedImport('a.png:stream')).toBe(false);
  });

  it('isOpenable by kind', () => {
    expect(isOpenable('inbox/x_a.exe.txt')).toBe(true);
    expect(isOpenable('assets/a/working/x_scene.blend')).toBe(true);
    expect(isOpenable('inbox/x_Photo.PNG.')).toBe(true);
    expect(isOpenable('inbox/x_clip.mp4')).toBe(true);
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
