// Imports sharp; imported only by preview-worker.ts, never by index.ts.
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';
import type { ImageSize, PreviewJob, PreviewResult } from './messages.js';

// libvips keeps opened files locked on Windows when it caches them; the pool provides parallelism.
sharp.cache(false);
sharp.concurrency(1);

export interface PreviewLimits {
  maxPixels: number;
  maxBytes: number;
}

export const DEFAULT_LIMITS: PreviewLimits = { maxPixels: 100_000_000, maxBytes: 256 * 1024 ** 2 };

/** Renders a bounded WebP or PNG preview. Never throws; any failure yields `none` and leaves no target. */
export async function generatePreview(
  job: PreviewJob,
  limits: PreviewLimits = DEFAULT_LIMITS,
): Promise<PreviewResult> {
  const tmp = `${job.targetPath}.${randomUUID()}.tmp`;
  try {
    const info = await stat(job.sourcePath);
    if (!info.isFile() || info.size > limits.maxBytes) return 'none';
    await mkdir(dirname(job.targetPath), { recursive: true });
    const resized = sharp(job.sourcePath, { limitInputPixels: limits.maxPixels, animated: false, pages: 1 })
      .rotate()
      .resize({
        width: job.longestEdge,
        height: job.longestEdge,
        fit: 'inside',
        withoutEnlargement: true,
      });
    await (job.format === 'png' ? resized.png({ compressionLevel: 3 }) : resized.webp()).toFile(tmp);
    await rename(tmp, job.targetPath);
    return 'ok';
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined);
    return 'none';
  }
}

/** Dimensions of the first frame after EXIF orientation. Never throws; any failure yields `null`. */
export async function measureImage(
  sourcePath: string,
  limits: PreviewLimits = DEFAULT_LIMITS,
): Promise<ImageSize | null> {
  try {
    const info = await stat(sourcePath);
    if (!info.isFile() || info.size > limits.maxBytes) return null;
    // Without `animated`, `height` is one frame, not the stacked frames.
    const meta = await sharp(sourcePath, { limitInputPixels: limits.maxPixels }).metadata();
    const { width, height, orientation } = meta;
    if (!width || !height) return null;
    if (width * height > limits.maxPixels) return null;
    return orientation !== undefined && orientation >= 5 && orientation <= 8
      ? { width: height, height: width }
      : { width, height };
  } catch {
    return null;
  }
}

export const MODEL_JPEG_EDGE = 1024;
export const MODEL_JPEG_QUALITY = 85;

/** A JPEG of the image for a vision model; null when the source cannot be decoded within the preview limits. Never throws. */
export async function modelJpeg(
  sourcePath: string,
  limits: PreviewLimits = DEFAULT_LIMITS,
): Promise<Uint8Array | null> {
  try {
    const info = await stat(sourcePath);
    if (!info.isFile() || info.size > limits.maxBytes) return null;
    const bytes = await sharp(sourcePath, { limitInputPixels: limits.maxPixels, animated: false, pages: 1 })
      .rotate()
      .resize({ width: MODEL_JPEG_EDGE, height: MODEL_JPEG_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: MODEL_JPEG_QUALITY })
      .toBuffer();
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch {
    return null;
  }
}
