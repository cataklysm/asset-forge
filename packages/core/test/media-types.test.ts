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
    expect(BLOCKED_OPEN_EXTENSIONS).toHaveLength(42);
    expect(new Set(BLOCKED_OPEN_EXTENSIONS).size).toBe(42);
    for (const entry of BLOCKED_OPEN_EXTENSIONS) expect(entry).toMatch(/^[a-z0-9-]+$/);
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
