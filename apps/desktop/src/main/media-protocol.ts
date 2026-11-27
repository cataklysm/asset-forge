import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { z } from 'zod';
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

/** Internal protocol through which the renderer loads cached previews, unchanged originals and videos. */
export const MEDIA_SCHEME = 'assetforge-media';

/**
 * Registered before the app is ready. `standard` makes media URLs parse like http URLs (host, path,
 * canonical form); `secure` treats the scheme as a secure origin, so loading media into the page is not
 * mixed content; `stream` lets the video element read a response body as it arrives and seek through
 * byte ranges. The renderer's CSP admits the scheme through its explicit `img-src` and `media-src`
 * entries, not through any privilege.
 */
export const MEDIA_SCHEME_PRIVILEGES = Object.freeze({ standard: true, secure: true, stream: true });

/** An inclusive byte range resolved against the file size. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * A `Range` header as asked, before the size is known: `bytes=a-b` / `bytes=a-` (`end` null), `bytes=-n`
 * (`suffix`), or `invalid` for anything malformed. Resolved by `resolveRange` against the size.
 */
export type RangeRequest = { start: number; end: number | null } | { suffix: number } | 'invalid';

export interface OpenedFile {
  /** Size of the whole file. */
  size: number;
  /** Exactly the bytes of `range` (or the whole file without one); null when the range cannot be satisfied. */
  stream: ReadableStream<Uint8Array> | null;
  /** The resolved range; null when none was asked or it cannot be satisfied. */
  range: ByteRange | null;
}

export interface MediaProtocolDeps {
  findSource(fileId: string): Promise<PreviewSource | null>;
  findOriginal(fileId: string): Promise<OriginalSource | null>;
  findVideo(fileId: string): Promise<VideoSource | null>;
  previews: Pick<PreviewService, 'get'>;
  /** Reads a small cached preview (`thumb`, `detail`) as a whole. */
  readFile(path: string): Promise<Uint8Array>;
  /**
   * Rejects when the file cannot be opened; nothing is read into memory as a whole. With a range only
   * its bytes are read, and an unsatisfiable range answers no stream with the handle already closed.
   */
  openFile(path: string, range?: RangeRequest): Promise<OpenedFile>;
}

const SIZES: readonly PreviewSize[] = ['thumb', 'detail', 'full'];
const FILE_ID = z.uuid();

/**
 * Parses an absolute URL of the media scheme with the given host and checks the parts every route
 * shares: no port, no credentials, no fragment (not even an empty `#`), exactly one path segment
 * holding a file UUID. The caller still compares against its canonical spelling.
 */
function parseFileUrl(url: string, host: string): { fileId: string; parsed: URL } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.hostname !== host) return null;
  if (parsed.port !== '') return null;
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') return null;
  const segments = parsed.pathname.split('/');
  if (segments.length !== 2 || segments[0] !== '') return null;
  const fileId = segments[1]!;
  if (!FILE_ID.safeParse(fileId).success) return null;
  return { fileId, parsed };
}

/**
 * Accepts only `assetforge-media://preview/<file uuid>?size=thumb|detail|full`, spelled exactly like
 * that: one path segment, one query parameter, no credentials, no port, no fragment (not even an
 * empty `#`), no dot segments. Anything else is null.
 *
 * The final comparison against the canonical spelling rejects every form the URL parser would
 * otherwise normalise away (dot segments, an empty fragment). The host is compared case-sensitively:
 * Node keeps the case of a non-special scheme's host, so `PREVIEW` is rejected here; under Electron's
 * standard-scheme registration Chromium lowercases the host before the handler sees it, which only
 * ever addresses the same preview. Chromium also never forwards a fragment to a protocol handler.
 */
export function parsePreviewUrl(url: string): { fileId: string; size: PreviewSize } | null {
  const target = parseFileUrl(url, 'preview');
  if (target === null) return null;
  const params = [...target.parsed.searchParams.entries()];
  if (params.length !== 1) return null;
  const [name, value] = params[0]!;
  if (name !== 'size' || !SIZES.includes(value as PreviewSize)) return null;
  if (url !== `${MEDIA_SCHEME}://preview/${target.fileId}?size=${value}`) return null;
  return { fileId: target.fileId, size: value as PreviewSize };
}

/**
 * Accepts only `assetforge-media://original/<file uuid>`, spelled exactly like that: no query (not
 * even an empty `?`), no fragment, no trailing slash, no further segment, no credentials, no port.
 * The same canonical-spelling comparison as in `parsePreviewUrl` applies.
 */
export function parseOriginalUrl(url: string): { fileId: string } | null {
  const target = parseFileUrl(url, 'original');
  if (target === null) return null;
  if (url !== `${MEDIA_SCHEME}://original/${target.fileId}`) return null;
  return { fileId: target.fileId };
}

/** Accepts only `assetforge-media://video/<file uuid>`, under the same rules as `parseOriginalUrl`. */
export function parseVideoUrl(url: string): { fileId: string } | null {
  const target = parseFileUrl(url, 'video');
  if (target === null) return null;
  if (url !== `${MEDIA_SCHEME}://video/${target.fileId}`) return null;
  return { fileId: target.fileId };
}

const DIGITS = /^\d+$/;

/** A non-negative safe integer from a run of decimal digits, or null. */
function byteOffset(text: string): number | null {
  if (!DIGITS.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Reads a `Range` header. null when there is none or it asks for several ranges (both are served as the
 * whole file); `invalid` for a malformed one. The unit is compared regardless of case; no whitespace is
 * accepted inside the range.
 */
export function parseRangeHeader(header: string | null): RangeRequest | null {
  if (header === null) return null;
  const separator = header.indexOf('=');
  if (separator < 0 || header.slice(0, separator).toLowerCase() !== 'bytes') return 'invalid';
  const spec = header.slice(separator + 1);
  if (spec.includes(',')) return null;
  const dash = spec.indexOf('-');
  if (dash < 0) return 'invalid';
  const first = spec.slice(0, dash);
  const last = spec.slice(dash + 1);
  if (first === '') {
    const suffix = byteOffset(last);
    return suffix === null ? 'invalid' : { suffix };
  }
  const start = byteOffset(first);
  if (start === null) return 'invalid';
  if (last === '') return { start, end: null };
  const end = byteOffset(last);
  return end === null || end < start ? 'invalid' : { start, end };
}

/** The inclusive range to serve from a file of `size` bytes; null when it cannot be satisfied. */
export function resolveRange(request: RangeRequest, size: number): ByteRange | null {
  if (request === 'invalid' || size === 0) return null;
  if ('suffix' in request) {
    if (request.suffix === 0) return null;
    return { start: Math.max(0, size - request.suffix), end: size - 1 };
  }
  if (request.start >= size) return null;
  return { start: request.start, end: Math.min(request.end ?? size - 1, size - 1) };
}

/** Every failure is a bare 404: no body, no headers, no hint whether the file exists. */
function notFound(): Response {
  return new Response(null, { status: 404 });
}

async function serveOriginal(fileId: string, deps: MediaProtocolDeps): Promise<Response> {
  const source = await deps.findOriginal(fileId);
  if (source === null) return notFound();
  // The lookup already guarantees an allowed type; checked again because it becomes Content-Type.
  if (!(ORIGINAL_MIME_TYPES as readonly string[]).includes(source.mimeType)) return notFound();
  const file = await deps.openFile(source.absolutePath);
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

async function servePreview(fileId: string, size: PreviewSize, deps: MediaProtocolDeps): Promise<Response> {
  const source = await deps.findSource(fileId);
  if (source === null) return notFound();
  const request: PreviewRequest = { sha256: source.sha256, sourcePath: source.absolutePath, size };
  // A video is rendered from an extracted frame; without the format the preview service would hand it to Sharp.
  if (source.video !== null) request.video = source.video;
  const previewPath = await deps.previews.get(request);
  if (previewPath === null) return notFound();
  // Cache cleanup may remove the file between `get` and opening or reading it; that is a 404 as well.
  if (size === 'full') {
    const file = await deps.openFile(previewPath);
    if (file.stream === null) return notFound();
    return new Response(file.stream, {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(file.size), 'Cache-Control': 'no-store' },
    });
  }
  const bytes = await deps.readFile(previewPath);
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=31536000' },
  });
}

/**
 * Streams a video, whole (200) or one byte range (206); a malformed or unsatisfiable range is a 416 that
 * names only the size. Several ranges are served as the whole file.
 */
async function serveVideo(fileId: string, rangeHeader: string | null, deps: MediaProtocolDeps): Promise<Response> {
  const source = await deps.findVideo(fileId);
  if (source === null) return notFound();
  // The lookup already guarantees an allowed type; checked again because it becomes Content-Type.
  if (!VIDEO_MIME_TYPES.includes(source.mimeType)) return notFound();
  const asked = parseRangeHeader(rangeHeader);
  const file = asked === null ? await deps.openFile(source.absolutePath) : await deps.openFile(source.absolutePath, asked);
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

export async function handleMediaRequest(
  request: { url: string; method: string; headers?: { get(name: string): string | null } },
  deps: MediaProtocolDeps,
): Promise<Response> {
  if (request.method !== 'GET') return notFound();
  try {
    const video = parseVideoUrl(request.url);
    if (video !== null) return await serveVideo(video.fileId, request.headers?.get('range') ?? null, deps);
    const original = parseOriginalUrl(request.url);
    if (original !== null) return await serveOriginal(original.fileId, deps);
    const preview = parsePreviewUrl(request.url);
    if (preview !== null) return await servePreview(preview.fileId, preview.size, deps);
    return notFound();
  } catch {
    return notFound();
  }
}

/**
 * Opens a file for streaming. The size comes from the open handle; the handle is closed when the
 * stream ends, errors or is cancelled. Rejects (with the handle closed) when the file cannot be
 * opened or is not a regular file, so the caller can answer 404 before any response exists.
 *
 * With a range the stream reads exactly the resolved bytes and nothing outside them; a range that cannot
 * be satisfied closes the handle at once and answers the size without a stream.
 */
export async function openFile(path: string, range?: RangeRequest): Promise<OpenedFile> {
  const handle = await open(path, 'r');
  let size: number;
  let resolved: ByteRange | null = null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Not a regular file');
    size = stat.size;
    if (range !== undefined) {
      resolved = resolveRange(range, size);
      if (resolved === null) {
        await handle.close();
        return { size, stream: null, range: null };
      }
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  const options = resolved === null ? { autoClose: true } : { autoClose: true, start: resolved.start, end: resolved.end };
  const stream = Readable.toWeb(handle.createReadStream(options));
  return { size, stream: stream as ReadableStream<Uint8Array>, range: resolved };
}

/** Preview source lookup in the currently open workspace; rejects when none is open. */
export function findSourceIn(manager: WorkspaceManager): (fileId: string) => Promise<PreviewSource | null> {
  return (fileId) => manager.read((s) => resolvePreviewSource(s, fileId));
}

/** Video lookup in the currently open workspace; rejects when none is open. */
export function findVideoIn(manager: WorkspaceManager): (fileId: string) => Promise<VideoSource | null> {
  return (fileId) => manager.read((s) => resolveVideoSource(s, fileId));
}

/** Original lookup in the currently open workspace; rejects when none is open. */
export function findOriginalIn(manager: WorkspaceManager): (fileId: string) => Promise<OriginalSource | null> {
  return (fileId) => manager.read((s) => resolveOriginalSource(s, fileId));
}
