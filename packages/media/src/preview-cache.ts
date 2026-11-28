import { rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { evictLeastRecentlyUsed } from './cache-eviction.js';
import { FailureMemory } from './failure-memory.js';
import type { VideoInfo } from './video-diagnostics.js';
import type { VideoFormat } from './video-frame-arguments.js';
import type { VideoFrames } from './video-frames.js';
import type { WorkerPool } from './worker-pool.js';

/** The renditions of an image: tile thumbnail, detail preview and lossless full size. */
export type PreviewSize = 'thumb' | 'detail' | 'full';

/** Longest edge per rendition. */
export const PREVIEW_EDGE: Record<PreviewSize, number> = { thumb: 256, detail: 1024, full: 8192 };
/** Version of the WebP thumbnails and previews, part of their file names. */
export const PREVIEW_FORMAT_VERSION = 1;
/** Version of the lossless `full` rendition, independent of `PREVIEW_FORMAT_VERSION`. */
export const FULL_FORMAT_VERSION = 1;
/** Budget of each cache directory. */
export const CACHE_LIMIT_BYTES = 2 * 1024 ** 3;
/** An eviction trims a directory down to this share of its budget. */
export const CACHE_TARGET_RATIO = 0.9;
/** New thumbnails, previews and frames between two cleanups. */
export const CLEANUP_EVERY = 500;
/** Full renditions are large, so they trigger a cleanup far sooner than thumbnails. */
export const FULL_CLEANUP_EVERY = 8;

/** Version of the extracted video frames, independent of the preview versions. */
export const FRAME_FORMAT_VERSION = 1;

const DIRECTORIES: Record<PreviewSize, string> = { thumb: 'thumbnails', detail: 'previews', full: 'full' };
const FRAMES_DIRECTORY = 'frames';
/** Every directory the LRU cleanup trims, each against its own budget. */
const CACHE_DIRECTORIES = [...Object.values(DIRECTORIES), FRAMES_DIRECTORY];
const SHA256 = /^[0-9a-f]{64}$/;
const VIDEO_FORMATS: readonly string[] = ['mp4', 'webm'] satisfies VideoFormat[];

/**
 * Path relative to the cache root, e.g. `thumbnails/ab/<sha256>-256-v1.webp` or `full/ab/<sha256>-8192-v1.png`.
 *
 * @param sha256 the content hash of the source
 * @param size the rendition
 * @returns the relative path with forward slashes
 */
export function previewRelativePath(sha256: string, size: PreviewSize): string {
  if (size === 'full') {
    return `${DIRECTORIES.full}/${sha256.slice(0, 2)}/${sha256}-${PREVIEW_EDGE.full}-v${FULL_FORMAT_VERSION}.png`;
  }
  return `${DIRECTORIES[size]}/${sha256.slice(0, 2)}/${sha256}-${PREVIEW_EDGE[size]}-v${PREVIEW_FORMAT_VERSION}.webp`;
}

/**
 * Path of an extracted video frame relative to the cache root, e.g. `frames/ab/<sha256>-v1.jpg`.
 *
 * @param sha256 the content hash of the video
 * @returns the relative path with forward slashes
 */
export function frameRelativePath(sha256: string): string {
  return `${FRAMES_DIRECTORY}/${sha256.slice(0, 2)}/${sha256}-v${FRAME_FORMAT_VERSION}.jpg`;
}

/** One preview asked of the cache. */
export interface PreviewRequest {
  /** The content hash of the source, which keys the cache. */
  sha256: string;
  /** The source file. */
  sourcePath: string;
  /** The rendition. */
  size: PreviewSize;
  /** Set for a video: the preview is rendered from one extracted frame, never from the video. */
  video?: VideoFormat;
}

/** The preview cache of the app. */
export interface PreviewService {
  /**
   * The cached preview, generated when missing. Never throws.
   *
   * @param request the source and the rendition
   * @returns absolute path of the cached WebP (PNG for `full`), or null for "no preview"
   */
  get(request: PreviewRequest): Promise<string | null>;
  /**
   * Size and duration of a video through a temporary frame that is removed afterwards. Never throws.
   *
   * @param sourcePath the video
   * @param format its container
   * @returns what the frame tool measured; null when it could not
   */
  measureVideo(sourcePath: string, format: VideoFormat): Promise<VideoInfo | null>;
  /**
   * Evicts least recently used entries from `thumbnails`, `previews`, `full` and `frames`, each
   * directory separately against `limitBytes`; concurrent calls share one run. Never throws.
   *
   * @returns resolves once the run is over
   */
  cleanup(): Promise<void>;
  /**
   * Closes the frame tool and the worker pool; later requests answer null.
   *
   * @returns resolves once the pool is closed and a running cleanup is over
   */
  close(): Promise<void>;
}

/** What `createPreviewService` is configured with. */
export interface PreviewServiceOptions {
  /** The cache root (`userData/cache`). */
  cacheDir: string;
  /** The pool that renders previews. */
  pool: WorkerPool;
  /** Without it a video has no preview. */
  frames?: VideoFrames;
  /** Budget per cache directory. Default: `CACHE_LIMIT_BYTES`. */
  limitBytes?: number;
  /** New thumbnails, previews and frames between two cleanups. Default: `CLEANUP_EVERY`. */
  cleanupEvery?: number;
}

/** A preview request for a video. */
type FrameRequest = PreviewRequest & { video: VideoFormat };

/**
 * Whether a path exists.
 *
 * @param path the path
 * @returns false for anything `stat` refuses
 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Marks a cache entry as used now, which the LRU cleanup reads; a failure is ignored.
 *
 * @param path the cache entry
 * @returns resolves once the time is set or the attempt failed
 */
async function touch(path: string): Promise<void> {
  const now = new Date();
  await utimes(path, now, now).catch(() => undefined);
}

/**
 * Content-keyed preview cache below `cacheDir`. Previews are generated on demand through the
 * worker pool; identical concurrent requests share one generation. A source that produced no
 * preview is remembered for the session, a source that cannot be reached is not.
 *
 * @param options the cache root, the pool, the frame tool and the cleanup settings
 * @returns the service
 */
export function createPreviewService(options: PreviewServiceOptions): PreviewService {
  const cache = new PreviewCache(options);
  return {
    get: (request) => cache.get(request),
    measureVideo: (sourcePath, format) => cache.measureVideo(sourcePath, format),
    cleanup: () => cache.cleanup(),
    close: () => cache.close(),
  };
}

/** The state of one preview cache: running and failed generations, counters and the running cleanup. */
class PreviewCache {
  private readonly cacheDir: string;
  private readonly pool: WorkerPool;
  private readonly frames: VideoFrames | undefined;
  private readonly limitBytes: number;
  private readonly cleanupEvery: number;
  /** Keys (`<sha256>:<size>` or `<sha256>:frame`) whose source gave no preview this session, the newest kept. */
  private readonly failed = new FailureMemory();
  /** Running generations by key. */
  private readonly inflight = new Map<string, Promise<string | null>>();
  /** Video measurements by format and source path: the running ones, and those that failed this session. */
  private readonly measuring = new Map<string, Promise<VideoInfo | null>>();
  private readonly failedMeasurements = new FailureMemory();
  /** New entries since the last cleanup. */
  private readonly newEntries = { thumb: 0, full: 0 };
  /** The running cleanup, shared by concurrent calls. */
  private cleaning: Promise<void> | undefined;
  /** `close` was called. */
  private isClosed = false;

  /** @param options the cache root, the pool, the frame tool and the cleanup settings */
  constructor(options: PreviewServiceOptions) {
    this.cacheDir = options.cacheDir;
    this.pool = options.pool;
    this.frames = options.frames;
    this.limitBytes = options.limitBytes ?? CACHE_LIMIT_BYTES;
    this.cleanupEvery = options.cleanupEvery ?? CLEANUP_EVERY;
  }

  /**
   * See `PreviewService.get`.
   *
   * @param request the source and the rendition
   * @returns the cached path, or null
   */
  get(request: PreviewRequest): Promise<string | null> {
    if (this.isClosed || !SHA256.test(request.sha256) || !(request.size in PREVIEW_EDGE)) {
      return Promise.resolve(null);
    }
    if (
      request.video !== undefined &&
      (!this.frames || request.size === 'full' || !VIDEO_FORMATS.includes(request.video))
    ) {
      return Promise.resolve(null);
    }
    const key = `${request.sha256}:${request.size}`;
    if (this.failed.has(key)) return Promise.resolve(null);
    const running = this.inflight.get(key);
    if (running) {
      // Asked for again (a tile scrolled back into view): a render still waiting for a worker moves to the front.
      this.pool.prioritize(join(this.cacheDir, previewRelativePath(request.sha256, request.size)));
      return running;
    }
    const promise = this.resolvePreview(key, request)
      .catch(() => null)
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * See `PreviewService.measureVideo`.
   *
   * @param sourcePath the video
   * @param format its container
   * @returns the measurement, or null
   */
  measureVideo(sourcePath: string, format: VideoFormat): Promise<VideoInfo | null> {
    if (this.isClosed || !this.frames || !VIDEO_FORMATS.includes(format)) return Promise.resolve(null);
    const key = `${format}:${sourcePath}`;
    if (this.failedMeasurements.has(key)) return Promise.resolve(null);
    const running = this.measuring.get(key);
    if (running) return running;
    const promise = this.measure(key, sourcePath, format, this.frames)
      .catch(() => null)
      .finally(() => this.measuring.delete(key));
    this.measuring.set(key, promise);
    return promise;
  }

  /**
   * See `PreviewService.cleanup`.
   *
   * @returns the running cleanup
   */
  cleanup(): Promise<void> {
    this.cleaning ??= this.trimDirectories().finally(() => {
      this.cleaning = undefined;
    });
    return this.cleaning;
  }

  /**
   * See `PreviewService.close`.
   *
   * @returns resolves once the pool is closed and a running cleanup is over
   */
  async close(): Promise<void> {
    this.isClosed = true;
    this.frames?.close();
    await this.pool.close();
    await this.cleaning;
  }

  /**
   * Answers a cached preview or renders it; a video is rendered from its frame.
   *
   * @param key the request's cache key
   * @param request the source and the rendition
   * @returns the cached path, or null
   */
  private async resolvePreview(key: string, request: PreviewRequest): Promise<string | null> {
    const targetPath = join(this.cacheDir, previewRelativePath(request.sha256, request.size));
    if (await exists(targetPath)) {
      await touch(targetPath);
      return targetPath;
    }
    let renderSource = request.sourcePath;
    if (request.video) {
      // A video never reaches the worker pool: only its extracted frame does.
      const frame = this.frames ? await this.frameOf({ ...request, video: request.video }, this.frames) : null;
      if (!frame) return null;
      renderSource = frame;
    } else if (!(await exists(request.sourcePath))) {
      return null;
    }
    const result = await this.pool.run({
      sourcePath: renderSource,
      targetPath,
      longestEdge: PREVIEW_EDGE[request.size],
      format: request.size === 'full' ? 'png' : 'webp',
    });
    if (result === 'ok') {
      this.countNewEntry(request.size === 'full' ? 'full' : 'thumb');
      return targetPath;
    }
    // A pool that was closed or a source (or frame) that vanished meanwhile says nothing about the content.
    if (!this.isClosed && (await exists(renderSource))) this.failed.add(key);
    return null;
  }

  /**
   * The cached frame of a video, extracted once; deduplicated and remembered like a preview.
   *
   * @param request the video's preview request
   * @param extractor the frame tool
   * @returns the frame's path, or null
   */
  private frameOf(request: FrameRequest, extractor: VideoFrames): Promise<string | null> {
    const key = `${request.sha256}:frame`;
    if (this.failed.has(key)) return Promise.resolve(null);
    const running = this.inflight.get(key);
    if (running) return running;
    const promise = this.extractFrame(key, request, extractor)
      .catch(() => null)
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * Answers the cached frame of a video or extracts it.
   *
   * @param key the frame's cache key
   * @param request the video's preview request
   * @param extractor the frame tool
   * @returns the frame's path, or null
   */
  private async extractFrame(key: string, request: FrameRequest, extractor: VideoFrames): Promise<string | null> {
    const framePath = join(this.cacheDir, frameRelativePath(request.sha256));
    if (await exists(framePath)) {
      await touch(framePath);
      return framePath;
    }
    if (!(await exists(request.sourcePath))) return null;
    if (await extractor.extract(request.sourcePath, request.video, framePath)) {
      this.countNewEntry('thumb');
      return framePath;
    }
    if (!this.isClosed && (await exists(request.sourcePath))) this.failed.add(key);
    return null;
  }

  /**
   * Measures a video through a temporary frame and removes the frame.
   *
   * @param key the measurement's key
   * @param sourcePath the video
   * @param format its container
   * @param extractor the frame tool
   * @returns the measurement, or null
   */
  private async measure(
    key: string,
    sourcePath: string,
    format: VideoFormat,
    extractor: VideoFrames,
  ): Promise<VideoInfo | null> {
    // Ends in `.tmp`, so a target left by a crash is removed by the stale-file sweep of the cleanup.
    const target = join(this.cacheDir, FRAMES_DIRECTORY, `measure-${randomUUID()}.tmp`);
    let info: VideoInfo | null = null;
    try {
      info = await extractor.extract(sourcePath, format, target);
    } catch {
      info = null;
    } finally {
      await rm(target, { force: true, maxRetries: 3 }).catch(() => undefined);
    }
    // A source that is gone (or unreachable) may come back, so only a present one is remembered as failed.
    if (info === null && !this.isClosed && (await exists(sourcePath))) this.failedMeasurements.add(key);
    return info;
  }

  /**
   * Trims every cache directory in turn; a failing directory is skipped.
   *
   * @returns resolves once every directory was trimmed
   */
  private async trimDirectories(): Promise<void> {
    // Each directory has its own budget (ReadMe §15.3).
    for (const directory of CACHE_DIRECTORIES) {
      await evictLeastRecentlyUsed(join(this.cacheDir, directory), this.limitBytes, CACHE_TARGET_RATIO).catch(
        () => undefined,
      );
    }
  }

  /**
   * Counts one new entry and starts a cleanup when the counter is full. Thumbnails, previews and frames share one
   * counter, full renditions have their own.
   *
   * @param counter the counter of the new entry
   */
  private countNewEntry(counter: 'thumb' | 'full'): void {
    this.newEntries[counter]++;
    if (this.newEntries[counter] >= (counter === 'full' ? FULL_CLEANUP_EVERY : this.cleanupEvery)) {
      this.newEntries[counter] = 0;
      void this.cleanup();
    }
  }
}
