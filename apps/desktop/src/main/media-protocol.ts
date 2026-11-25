import { z } from 'zod';
import { resolvePreviewSource, type PreviewSource, type WorkspaceManager } from '@assetforge/core';
import type { PreviewService, PreviewSize } from '@assetforge/media';

/** Internal protocol through which the renderer loads cached previews. */
export const MEDIA_SCHEME = 'assetforge-media';

export interface MediaProtocolDeps {
  findSource(fileId: string): Promise<PreviewSource | null>;
  previews: Pick<PreviewService, 'get'>;
  readFile(path: string): Promise<Uint8Array>;
}

const SIZES: readonly PreviewSize[] = ['thumb', 'detail'];
const FILE_ID = z.uuid();

/**
 * Accepts only `assetforge-media://preview/<file uuid>?size=thumb|detail`, spelled exactly like
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
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.hostname !== 'preview') return null;
  if (parsed.port !== '') return null;
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') return null;
  const segments = parsed.pathname.split('/');
  if (segments.length !== 2 || segments[0] !== '') return null;
  const fileId = segments[1]!;
  if (!FILE_ID.safeParse(fileId).success) return null;
  const params = [...parsed.searchParams.entries()];
  if (params.length !== 1) return null;
  const [name, value] = params[0]!;
  if (name !== 'size' || !SIZES.includes(value as PreviewSize)) return null;
  if (url !== `${MEDIA_SCHEME}://preview/${fileId}?size=${value}`) return null;
  return { fileId, size: value as PreviewSize };
}

/** Every failure is a bare 404: no body, no headers, no hint whether the file exists. */
function notFound(): Response {
  return new Response(null, { status: 404 });
}

export async function handleMediaRequest(
  request: { url: string; method: string },
  deps: MediaProtocolDeps,
): Promise<Response> {
  if (request.method !== 'GET') return notFound();
  const target = parsePreviewUrl(request.url);
  if (target === null) return notFound();
  try {
    const source = await deps.findSource(target.fileId);
    if (source === null) return notFound();
    const previewPath = await deps.previews.get({
      sha256: source.sha256,
      sourcePath: source.absolutePath,
      size: target.size,
    });
    if (previewPath === null) return notFound();
    // Cache cleanup may remove the file between `get` and this read; that is a 404 as well.
    const bytes = await deps.readFile(previewPath);
    return new Response(bytes as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=31536000' },
    });
  } catch {
    return notFound();
  }
}

/** Preview source lookup in the currently open workspace; rejects when none is open. */
export function findSourceIn(manager: WorkspaceManager): (fileId: string) => Promise<PreviewSource | null> {
  return (fileId) => manager.read((s) => resolvePreviewSource(s, fileId));
}
