import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { ORIGINAL_MIME_TYPES } from '@assetforge/contracts';
import {
  resolveOriginalSource,
  resolvePreviewSource,
  type OriginalSource,
  type PreviewSource,
  type WorkspaceManager,
} from '@assetforge/core';
import type { PreviewService, PreviewSize } from '@assetforge/media';

/** Internal protocol through which the renderer loads cached previews and unchanged originals. */
export const MEDIA_SCHEME = 'assetforge-media';

export interface MediaProtocolDeps {
  findSource(fileId: string): Promise<PreviewSource | null>;
  findOriginal(fileId: string): Promise<OriginalSource | null>;
  previews: Pick<PreviewService, 'get'>;
  /** Reads a small cached preview (`thumb`, `detail`) as a whole. */
  readFile(path: string): Promise<Uint8Array>;
  /** Rejects when the file cannot be opened; nothing is read into memory as a whole. */
  openFile(path: string): Promise<{ size: number; stream: ReadableStream<Uint8Array> }>;
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
  const previewPath = await deps.previews.get({ sha256: source.sha256, sourcePath: source.absolutePath, size });
  if (previewPath === null) return notFound();
  // Cache cleanup may remove the file between `get` and opening or reading it; that is a 404 as well.
  if (size === 'full') {
    const file = await deps.openFile(previewPath);
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

export async function handleMediaRequest(
  request: { url: string; method: string },
  deps: MediaProtocolDeps,
): Promise<Response> {
  if (request.method !== 'GET') return notFound();
  try {
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
 * opened, so the caller can answer 404 before any response exists.
 */
export async function openFile(path: string): Promise<{ size: number; stream: ReadableStream<Uint8Array> }> {
  const handle = await open(path, 'r');
  let size: number;
  try {
    size = (await handle.stat()).size;
  } catch (error) {
    await handle.close();
    throw error;
  }
  const stream = Readable.toWeb(handle.createReadStream({ autoClose: true }));
  return { size, stream: stream as ReadableStream<Uint8Array> };
}

/** Preview source lookup in the currently open workspace; rejects when none is open. */
export function findSourceIn(manager: WorkspaceManager): (fileId: string) => Promise<PreviewSource | null> {
  return (fileId) => manager.read((s) => resolvePreviewSource(s, fileId));
}

/** Original lookup in the currently open workspace; rejects when none is open. */
export function findOriginalIn(manager: WorkspaceManager): (fileId: string) => Promise<OriginalSource | null> {
  return (fileId) => manager.read((s) => resolveOriginalSource(s, fileId));
}
