import { ORIGINAL_MIME_TYPES } from '@assetforge/contracts';
import {
  resolveOriginalSource,
  resolvePreviewSource,
  resolveVideoSource,
  VIDEO_MIME_TYPES,
  type OriginalSource,
  type PreviewSource,
  type VideoSource,
  type WorkspaceManager,
} from '@assetforge/core';
import type { PreviewRequest, PreviewService, PreviewSize } from '@assetforge/media';
import { parseRangeHeader, type RangeRequest } from './byte-range.js';
import type { OpenedFile } from './media-file.js';
import { parseOriginalUrl, parsePreviewUrl, parseVideoUrl } from './media-routes.js';

// The handler of the media protocol: routes a request (see `media-routes.ts`) to the file it may serve.

/** What `handleMediaRequest` is wired with. */
export interface MediaProtocolDependencies {
  /**
   * Finds the source of a preview.
   *
   * @param fileId the file's id
   * @returns the source, or null when the file has none
   */
  findSource(fileId: string): Promise<PreviewSource | null>;
  /**
   * Finds an original that may be served unchanged.
   *
   * @param fileId the file's id
   * @returns the source, or null
   */
  findOriginal(fileId: string): Promise<OriginalSource | null>;
  /**
   * Finds a video.
   *
   * @param fileId the file's id
   * @returns the source, or null
   */
  findVideo(fileId: string): Promise<VideoSource | null>;
  /** The preview cache. */
  previews: Pick<PreviewService, 'get'>;
  /**
   * Reads a small cached preview (`thumb`, `detail`) as a whole.
   *
   * @param path the cached file
   * @returns its bytes
   */
  readFile(path: string): Promise<Uint8Array>;
  /**
   * Rejects when the file cannot be opened; nothing is read into memory as a whole. With a range only
   * its bytes are read, and an unsatisfiable range answers no stream with the handle already closed.
   *
   * @param path the file to open
   * @param range the range asked for, if any
   * @returns the opened file
   */
  openFile(path: string, range?: RangeRequest): Promise<OpenedFile>;
}

/** The parts of a protocol request the handler reads. */
export interface MediaRequest {
  url: string;
  method: string;
  headers?: { get(name: string): string | null };
}

/**
 * Every failure is a bare 404: no body, no headers, no hint whether the file exists.
 *
 * @returns the answer
 */
function notFound(): Response {
  return new Response(null, { status: 404 });
}

/**
 * Streams an original unchanged.
 *
 * @param fileId the file's id
 * @param dependencies the lookups and the file access
 * @returns a 200 with the file, or a 404
 */
async function serveOriginal(fileId: string, dependencies: MediaProtocolDependencies): Promise<Response> {
  const source = await dependencies.findOriginal(fileId);
  if (source === null) return notFound();
  // The lookup already guarantees an allowed type; checked again because it becomes Content-Type.
  if (!(ORIGINAL_MIME_TYPES as readonly string[]).includes(source.mimeType)) return notFound();
  const file = await dependencies.openFile(source.absolutePath);
  if (file.stream === null) return notFound();
  return new Response(file.stream, {
    status: 200,
    headers: {
      'Content-Type': source.mimeType,
      'Content-Length': String(file.size),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Serves a cached preview: the full rendition as a PNG stream, the others as WebP bytes.
 *
 * @param fileId the file's id
 * @param size the preview size asked for
 * @param dependencies the lookups, the preview cache and the file access
 * @returns a 200 with the preview, or a 404
 */
async function servePreview(
  fileId: string,
  size: PreviewSize,
  dependencies: MediaProtocolDependencies,
): Promise<Response> {
  const source = await dependencies.findSource(fileId);
  if (source === null) return notFound();
  const request: PreviewRequest = { sha256: source.sha256, sourcePath: source.absolutePath, size };
  // A video is rendered from an extracted frame; without the format the preview service would hand it to Sharp.
  if (source.video !== null) request.video = source.video;
  const previewPath = await dependencies.previews.get(request);
  if (previewPath === null) return notFound();
  // Cache cleanup may remove the file between `get` and opening or reading it; that is a 404 as well.
  if (size === 'full') {
    const file = await dependencies.openFile(previewPath);
    if (file.stream === null) return notFound();
    return new Response(file.stream, {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(file.size), 'Cache-Control': 'no-store' },
    });
  }
  const bytes = await dependencies.readFile(previewPath);
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=31536000' },
  });
}

/**
 * Streams a video, whole (200) or one byte range (206); a malformed or unsatisfiable range is a 416 that
 * names only the size. Several ranges are served as the whole file.
 *
 * @param fileId the file's id
 * @param rangeHeader the `Range` header, null without one
 * @param dependencies the lookups and the file access
 * @returns the answer
 */
async function serveVideo(
  fileId: string,
  rangeHeader: string | null,
  dependencies: MediaProtocolDependencies,
): Promise<Response> {
  const source = await dependencies.findVideo(fileId);
  if (source === null) return notFound();
  // The lookup already guarantees an allowed type; checked again because it becomes Content-Type.
  if (!VIDEO_MIME_TYPES.includes(source.mimeType)) return notFound();
  const asked = parseRangeHeader(rangeHeader);
  const file =
    asked === null
      ? await dependencies.openFile(source.absolutePath)
      : await dependencies.openFile(source.absolutePath, asked);
  if (file.stream === null) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}` } });
  }
  const headers: Record<string, string> = {
    'Content-Type': source.mimeType,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
  if (file.range === null) {
    return new Response(file.stream, { status: 200, headers: { ...headers, 'Content-Length': String(file.size) } });
  }
  const { start, end } = file.range;
  return new Response(file.stream, {
    status: 206,
    headers: {
      ...headers,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${file.size}`,
    },
  });
}

/**
 * Answers one request of the media protocol. Only GET on one of the three routes is served; anything else and
 * every failure is a bare 404.
 *
 * @param request the protocol request
 * @param dependencies the lookups, the preview cache and the file access
 * @returns the answer
 */
export async function handleMediaRequest(
  request: MediaRequest,
  dependencies: MediaProtocolDependencies,
): Promise<Response> {
  if (request.method !== 'GET') return notFound();
  try {
    const video = parseVideoUrl(request.url);
    if (video !== null) return await serveVideo(video.fileId, request.headers?.get('range') ?? null, dependencies);
    const original = parseOriginalUrl(request.url);
    if (original !== null) return await serveOriginal(original.fileId, dependencies);
    const preview = parsePreviewUrl(request.url);
    if (preview !== null) return await servePreview(preview.fileId, preview.size, dependencies);
    return notFound();
  } catch {
    return notFound();
  }
}

/**
 * Preview source lookup in the currently open workspace; rejects when none is open.
 *
 * @param manager the workspace manager
 * @returns the lookup
 */
export function findSourceIn(manager: WorkspaceManager): (fileId: string) => Promise<PreviewSource | null> {
  return (fileId) => manager.read((session) => resolvePreviewSource(session, fileId));
}

/**
 * Video lookup in the currently open workspace; rejects when none is open.
 *
 * @param manager the workspace manager
 * @returns the lookup
 */
export function findVideoIn(manager: WorkspaceManager): (fileId: string) => Promise<VideoSource | null> {
  return (fileId) => manager.read((session) => resolveVideoSource(session, fileId));
}

/**
 * Original lookup in the currently open workspace; rejects when none is open.
 *
 * @param manager the workspace manager
 * @returns the lookup
 */
export function findOriginalIn(manager: WorkspaceManager): (fileId: string) => Promise<OriginalSource | null> {
  return (fileId) => manager.read((session) => resolveOriginalSource(session, fileId));
}
