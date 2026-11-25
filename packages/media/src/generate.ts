// Imports sharp; imported only by preview-worker.ts, never by index.ts.
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';
import type { PreviewJob, PreviewResult } from './messages.js';

// libvips keeps opened files locked on Windows when it caches them; the pool provides parallelism.
sharp.cache(false);
sharp.concurrency(1);

export interface PreviewLimits {
  maxPixels: number;
  maxBytes: number;
}

export const DEFAULT_LIMITS: PreviewLimits = { maxPixels: 100_000_000, maxBytes: 256 * 1024 ** 2 };

/** Renders a bounded WebP preview. Never throws; any failure yields `none` and leaves no target. */
export async function generatePreview(
  job: PreviewJob,
  limits: PreviewLimits = DEFAULT_LIMITS,
): Promise<PreviewResult> {
  const tmp = `${job.targetPath}.${randomUUID()}.tmp`;
  try {
    const info = await stat(job.sourcePath);
    if (!info.isFile() || info.size > limits.maxBytes) return 'none';
    await mkdir(dirname(job.targetPath), { recursive: true });
    await sharp(job.sourcePath, { limitInputPixels: limits.maxPixels, animated: false, pages: 1 })
      .rotate()
      .resize({
        width: job.longestEdge,
        height: job.longestEdge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp()
      .toFile(tmp);
    await rename(tmp, job.targetPath);
    return 'ok';
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined);
    return 'none';
  }
}
