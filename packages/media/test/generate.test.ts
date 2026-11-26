import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, generatePreview, measureImage } from '../src/generate.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'assetforge-generate-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function solid(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: '#38a' } });
}

/** Reads through a buffer so the test itself never keeps a file open. */
async function meta(path: string) {
  return sharp(await readFile(path)).metadata();
}

describe('generatePreview', () => {
  it('DEFAULT_LIMITS are 100 megapixels and 256 MiB', () => {
    expect(DEFAULT_LIMITS).toEqual({ maxPixels: 100_000_000, maxBytes: 268_435_456 });
  });

  it('bounds the longest edge', async () => {
    const sourcePath = join(dir, 'a.png');
    const targetPath = join(dir, 'out', 'a.webp');
    await solid(2000, 1000).png().toFile(sourcePath);
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 256, format: 'webp' })).toBe('ok');
    expect(await meta(targetPath)).toMatchObject({ format: 'webp', width: 256, height: 128 });
  });

  it('never upscales', async () => {
    const sourcePath = join(dir, 'a.png');
    const targetPath = join(dir, 'a.webp');
    await solid(100, 50).png().toFile(sourcePath);
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 1024, format: 'webp' })).toBe('ok');
    expect(await meta(targetPath)).toMatchObject({ width: 100, height: 50 });
  });

  it('applies EXIF orientation and strips metadata', async () => {
    const sourcePath = join(dir, 'a.jpg');
    const targetPath = join(dir, 'a.webp');
    await solid(40, 20).jpeg().withMetadata({ orientation: 6 }).toFile(sourcePath);
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 256, format: 'webp' })).toBe('ok');
    const info = await meta(targetPath);
    expect(info).toMatchObject({ width: 20, height: 40 });
    expect(info.exif).toBeUndefined();
  });

  it.each(['png', 'jpeg', 'webp', 'tiff', 'gif', 'avif'] as const)('turns %s into webp', async (format) => {
    const sourcePath = join(dir, `a.${format}`);
    const targetPath = join(dir, 'a.webp');
    await solid(30, 20).toFormat(format).toFile(sourcePath);
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 256, format: 'webp' })).toBe('ok');
    expect((await meta(targetPath)).format).toBe('webp');
  });

  it('takes the first frame of an animated gif', async () => {
    const sourcePath = join(dir, 'a.gif');
    const targetPath = join(dir, 'a.webp');
    const frame = await solid(40, 30).raw().toBuffer();
    const frame2 = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c33' } })
      .raw()
      .toBuffer();
    await sharp(Buffer.concat([frame, frame2]), {
      raw: { width: 40, height: 30 * 2, channels: 3, pageHeight: 30 },
    })
      .gif()
      .toFile(sourcePath);
    expect(await sharp(await readFile(sourcePath), { animated: true }).metadata()).toMatchObject({
      pages: 2,
    });
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 256, format: 'webp' })).toBe('ok');
    const info = await meta(targetPath);
    expect(info).toMatchObject({ width: 40, height: 30 });
    expect(info.pages === undefined || info.pages === 1).toBe(true);
  });

  it('a pixel count above the limit yields none', async () => {
    const sourcePath = join(dir, 'a.png');
    const targetPath = join(dir, 'a.webp');
    await solid(20, 20).png().toFile(sourcePath);
    const result = await generatePreview(
      { sourcePath, targetPath, longestEdge: 256, format: 'webp' },
      { maxPixels: 100, maxBytes: DEFAULT_LIMITS.maxBytes },
    );
    expect(result).toBe('none');
    expect(existsSync(targetPath)).toBe(false);
  });

  it('a file above the size limit yields none', async () => {
    const sourcePath = join(dir, 'a.png');
    const targetPath = join(dir, 'a.webp');
    await solid(20, 20).png().toFile(sourcePath);
    const result = await generatePreview(
      { sourcePath, targetPath, longestEdge: 256, format: 'webp' },
      { maxPixels: DEFAULT_LIMITS.maxPixels, maxBytes: 10 },
    );
    expect(result).toBe('none');
    expect(existsSync(targetPath)).toBe(false);
  });

  it('corrupt input yields none', async () => {
    const sourcePath = join(dir, 'x.png');
    const targetPath = join(dir, 'x.webp');
    await writeFile(sourcePath, randomBytes(512));
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 256, format: 'webp' })).toBe('none');
    expect(existsSync(targetPath)).toBe(false);
  });

  it('a missing source yields none', async () => {
    const targetPath = join(dir, 'x.webp');
    expect(
      await generatePreview({ sourcePath: join(dir, 'missing.png'), targetPath, longestEdge: 256, format: 'webp' }),
    ).toBe('none');
  });

  it('leaves no temporary file after success or failure', async () => {
    const sourcePath = join(dir, 'a.png');
    const targetPath = join(dir, 'a.webp');
    await solid(20, 20).png().toFile(sourcePath);
    await generatePreview({ sourcePath, targetPath, longestEdge: 256, format: 'webp' });
    expect((await readdir(dir)).sort()).toEqual(['a.png', 'a.webp']);

    await rm(targetPath);
    await generatePreview(
      { sourcePath, targetPath, longestEdge: 256, format: 'webp' },
      { maxPixels: 10, maxBytes: DEFAULT_LIMITS.maxBytes },
    );
    expect(await readdir(dir)).toEqual(['a.png']);
  });

  it('releases source and target so both can be deleted at once', async () => {
    const sourcePath = join(dir, 'a.png');
    const targetPath = join(dir, 'a.webp');
    await solid(50, 50).png().toFile(sourcePath);
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 32, format: 'webp' })).toBe('ok');
    expect(() => rmSync(sourcePath)).not.toThrow();
    expect(() => rmSync(targetPath)).not.toThrow();

    const rejected = join(dir, 'b.png');
    await solid(50, 50).png().toFile(rejected);
    const result = await generatePreview(
      { sourcePath: rejected, targetPath: join(dir, 'b.webp'), longestEdge: 32, format: 'webp' },
      { maxPixels: 10, maxBytes: DEFAULT_LIMITS.maxBytes },
    );
    expect(result).toBe('none');
    expect(() => rmSync(rejected)).not.toThrow();
  });
});

/** Writes a TIFF of random RGBA pixels. */
async function rgba(width: number, height: number, path: string): Promise<void> {
  const pixels = randomBytes(width * height * 4);
  await sharp(pixels, { raw: { width, height, channels: 4 } }).tiff().toFile(path);
}

async function rawRgba(input: string | Buffer, rotate = false) {
  let image = sharp(input);
  if (rotate) image = image.rotate();
  return image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

describe('measureImage', () => {
  it('measures a png', async () => {
    const sourcePath = join(dir, 'a.png');
    await solid(2000, 1000).png().toFile(sourcePath);
    expect(await measureImage(sourcePath)).toEqual({ width: 2000, height: 1000 });
  });

  it('swaps width and height for EXIF orientations 5 to 8', async () => {
    const sourcePath = join(dir, 'a.jpg');
    await solid(40, 20).jpeg().withMetadata({ orientation: 6 }).toFile(sourcePath);
    expect(await measureImage(sourcePath)).toEqual({ width: 20, height: 40 });
  });

  it.each(['gif', 'webp'] as const)('measures one frame of an animated %s', async (format) => {
    const sourcePath = join(dir, `a.${format}`);
    const frames = await Promise.all(
      ['#38a', '#c33', '#3c3'].map((background) =>
        sharp({ create: { width: 30, height: 20, channels: 4, background } })
          .raw()
          .toBuffer(),
      ),
    );
    await sharp(Buffer.concat(frames), { raw: { width: 30, height: 60, channels: 4, pageHeight: 20 } })
      .toFormat(format)
      .toFile(sourcePath);
    expect(await sharp(await readFile(sourcePath), { animated: true }).metadata()).toMatchObject({ pages: 3 });
    expect(await measureImage(sourcePath)).toEqual({ width: 30, height: 20 });
  });

  it('yields null for a non-image, a missing path and a directory', async () => {
    const text = join(dir, 'a.png');
    await writeFile(text, 'not an image');
    expect(await measureImage(text)).toBeNull();
    expect(await measureImage(join(dir, 'missing.png'))).toBeNull();
    expect(await measureImage(dir)).toBeNull();
  });

  it('yields null above the pixel or byte limit', async () => {
    const sourcePath = join(dir, 'a.png');
    await solid(20, 20).png().toFile(sourcePath);
    expect(await measureImage(sourcePath, { maxPixels: 100, maxBytes: 1 << 20 })).toBeNull();
    expect(await measureImage(sourcePath, { maxPixels: 1_000_000, maxBytes: 10 })).toBeNull();
  });
});

describe('generatePreview as lossless png', () => {
  it('keeps every pixel of the source', async () => {
    const sourcePath = join(dir, 'a.tiff');
    const targetPath = join(dir, 'out', 'a.png');
    await rgba(64, 48, sourcePath);
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 8192, format: 'png' })).toBe('ok');
    expect(await meta(targetPath)).toMatchObject({ format: 'png', width: 64, height: 48 });
    const out = await rawRgba(await readFile(targetPath));
    expect(out.info).toMatchObject({ width: 64, height: 48, channels: 4 });
    // The reference is the source as decoded: a TIFF does not store arbitrary RGBA values verbatim.
    expect(out.data.equals((await rawRgba(await readFile(sourcePath))).data)).toBe(true);
  });

  it('applies the orientation and still matches the rotated source', async () => {
    const sourcePath = join(dir, 'a.tiff');
    const targetPath = join(dir, 'a.png');
    const pixels = randomBytes(64 * 48 * 4);
    await sharp(pixels, { raw: { width: 64, height: 48, channels: 4 } })
      .withMetadata({ orientation: 6 })
      .tiff()
      .toFile(sourcePath);
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 8192, format: 'png' })).toBe('ok');
    expect(await meta(targetPath)).toMatchObject({ width: 48, height: 64 });
    const expected = await rawRgba(await readFile(sourcePath), true);
    const out = await rawRgba(await readFile(targetPath));
    expect(expected.info).toMatchObject({ width: 48, height: 64 });
    expect(out.data.equals(expected.data)).toBe(true);
  });

  it('bounds the longest edge', async () => {
    const sourcePath = join(dir, 'a.tiff');
    const targetPath = join(dir, 'a.png');
    await rgba(64, 48, sourcePath);
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 32, format: 'png' })).toBe('ok');
    expect(await meta(targetPath)).toMatchObject({ format: 'png', width: 32, height: 24 });
  });

  it('webp stays webp', async () => {
    const sourcePath = join(dir, 'a.png');
    const targetPath = join(dir, 'a.out');
    await solid(30, 20).png().toFile(sourcePath);
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 256, format: 'webp' })).toBe('ok');
    expect((await meta(targetPath)).format).toBe('webp');
  });
});
