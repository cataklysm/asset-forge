// Imports sharp; imported only by preview-worker.ts, never by index.ts.
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';
import type { ImageSize, PreviewJob, PreviewResult } from './messages.js';

// libvips keeps opened files locked on Windows when it caches them; the pool provides parallelism.
sharp.cache(false);
sharp.concurrency(1);

/** The decoder limits of one source. */
export interface PreviewLimits {
  /** Largest pixel count the decoder accepts. */
  maxPixels: number;
  /** Largest source file in bytes. */
  maxBytes: number;
}

/** The limits the worker uses. */
export const DEFAULT_LIMITS: PreviewLimits = { maxPixels: 100_000_000, maxBytes: 256 * 1024 ** 2 };

/**
 * Renders a bounded WebP or PNG preview. Never throws; any failure yields `none` and leaves no target.
 *
 * @param job what to render where
 * @param limits the decoder limits
 * @returns `ok` once the target is in place, otherwise `none`
 */
export async function generatePreview(
  job: PreviewJob,
  limits: PreviewLimits = DEFAULT_LIMITS,
): Promise<PreviewResult> {
  const temporaryPath = `${job.targetPath}.${randomUUID()}.tmp`;
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
    await (job.format === 'png' ? resized.png({ compressionLevel: 3 }) : resized.webp()).toFile(temporaryPath);
    await rename(temporaryPath, job.targetPath);
    return 'ok';
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    return 'none';
  }
}

/**
 * Dimensions of the first frame after EXIF orientation. Never throws; any failure yields `null`.
 *
 * @param sourcePath the image
 * @param limits the decoder limits
 * @returns the dimensions, or null
 */
export async function measureImage(
  sourcePath: string,
  limits: PreviewLimits = DEFAULT_LIMITS,
): Promise<ImageSize | null> {
  try {
    const info = await stat(sourcePath);
    if (!info.isFile() || info.size > limits.maxBytes) return null;
    // Without `animated`, `height` is one frame, not the stacked frames.
    const metadata = await sharp(sourcePath, { limitInputPixels: limits.maxPixels }).metadata();
    const { width, height, orientation } = metadata;
    if (!width || !height) return null;
    if (width * height > limits.maxPixels) return null;
    return orientation !== undefined && orientation >= 5 && orientation <= 8
      ? { width: height, height: width }
      : { width, height };
  } catch {
    return null;
  }
}

/** Longest edge of the JPEG sent to a vision model. */
export const MODEL_JPEG_EDGE = 1024;
/** JPEG quality of that image. */
export const MODEL_JPEG_QUALITY = 85;

/**
 * A JPEG of the image for a vision model. Never throws.
 *
 * @param sourcePath the image
 * @param limits the decoder limits
 * @returns the JPEG bytes; null when the source cannot be decoded within the preview limits
 */
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
