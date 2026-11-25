import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, generatePreview } from '../src/generate.js';

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
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 256 })).toBe('ok');
    expect(await meta(targetPath)).toMatchObject({ format: 'webp', width: 256, height: 128 });
  });

  it('never upscales', async () => {
    const sourcePath = join(dir, 'a.png');
    const targetPath = join(dir, 'a.webp');
    await solid(100, 50).png().toFile(sourcePath);
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 1024 })).toBe('ok');
    expect(await meta(targetPath)).toMatchObject({ width: 100, height: 50 });
  });

  it('applies EXIF orientation and strips metadata', async () => {
    const sourcePath = join(dir, 'a.jpg');
    const targetPath = join(dir, 'a.webp');
    await solid(40, 20).jpeg().withMetadata({ orientation: 6 }).toFile(sourcePath);
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 256 })).toBe('ok');
    const info = await meta(targetPath);
    expect(info).toMatchObject({ width: 20, height: 40 });
    expect(info.exif).toBeUndefined();
  });

  it.each(['png', 'jpeg', 'webp', 'tiff', 'gif', 'avif'] as const)('turns %s into webp', async (format) => {
    const sourcePath = join(dir, `a.${format}`);
    const targetPath = join(dir, 'a.webp');
    await solid(30, 20).toFormat(format).toFile(sourcePath);
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 256 })).toBe('ok');
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
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 256 })).toBe('ok');
    const info = await meta(targetPath);
    expect(info).toMatchObject({ width: 40, height: 30 });
    expect(info.pages === undefined || info.pages === 1).toBe(true);
  });

  it('a pixel count above the limit yields none', async () => {
    const sourcePath = join(dir, 'a.png');
    const targetPath = join(dir, 'a.webp');
    await solid(20, 20).png().toFile(sourcePath);
    const result = await generatePreview(
      { sourcePath, targetPath, longestEdge: 256 },
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
      { sourcePath, targetPath, longestEdge: 256 },
      { maxPixels: DEFAULT_LIMITS.maxPixels, maxBytes: 10 },
    );
    expect(result).toBe('none');
    expect(existsSync(targetPath)).toBe(false);
  });

  it('corrupt input yields none', async () => {
    const sourcePath = join(dir, 'x.png');
    const targetPath = join(dir, 'x.webp');
    await writeFile(sourcePath, randomBytes(512));
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 256 })).toBe('none');
    expect(existsSync(targetPath)).toBe(false);
  });

  it('a missing source yields none', async () => {
    const targetPath = join(dir, 'x.webp');
    expect(
      await generatePreview({ sourcePath: join(dir, 'missing.png'), targetPath, longestEdge: 256 }),
    ).toBe('none');
  });

  it('leaves no temporary file after success or failure', async () => {
    const sourcePath = join(dir, 'a.png');
    const targetPath = join(dir, 'a.webp');
    await solid(20, 20).png().toFile(sourcePath);
    await generatePreview({ sourcePath, targetPath, longestEdge: 256 });
    expect((await readdir(dir)).sort()).toEqual(['a.png', 'a.webp']);

    await rm(targetPath);
    await generatePreview(
      { sourcePath, targetPath, longestEdge: 256 },
      { maxPixels: 10, maxBytes: DEFAULT_LIMITS.maxBytes },
    );
    expect(await readdir(dir)).toEqual(['a.png']);
  });

  it('releases source and target so both can be deleted at once', async () => {
    const sourcePath = join(dir, 'a.png');
    const targetPath = join(dir, 'a.webp');
    await solid(50, 50).png().toFile(sourcePath);
    expect(await generatePreview({ sourcePath, targetPath, longestEdge: 32 })).toBe('ok');
    expect(() => rmSync(sourcePath)).not.toThrow();
    expect(() => rmSync(targetPath)).not.toThrow();

    const rejected = join(dir, 'b.png');
    await solid(50, 50).png().toFile(rejected);
    const result = await generatePreview(
      { sourcePath: rejected, targetPath: join(dir, 'b.webp'), longestEdge: 32 },
      { maxPixels: 10, maxBytes: DEFAULT_LIMITS.maxBytes },
    );
    expect(result).toBe('none');
    expect(() => rmSync(rejected)).not.toThrow();
  });
});
