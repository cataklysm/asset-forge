/** The longest edge, in pixels, up to which an original is shown as it is. */
export const ORIGINAL_MAX_EDGE = 8192;

/** MIME types a browser shows natively; originals are served only for these. */
export const ORIGINAL_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'] as const;

/** What the viewer shows: the original, a converted copy, a reduced copy, the cached preview, or nothing. */
export type ViewSource = 'original' | 'converted' | 'reduced' | 'preview' | 'none';

/** Raster types that Sharp can decode but a browser cannot show natively. */
const CONVERTIBLE_MIME_TYPES: readonly string[] = ['image/tiff'];

/** Decides the view source of an image from its MIME type and pixel size. The MIME comparison is exact. */
export function viewSource(mimeType: string, width: number | null, height: number | null): ViewSource {
  const native = (ORIGINAL_MIME_TYPES as readonly string[]).includes(mimeType);
  if (!native && !CONVERTIBLE_MIME_TYPES.includes(mimeType)) return 'none';
  if (width === null || height === null) return 'preview';
  if (Math.max(width, height) > ORIGINAL_MAX_EDGE) return 'reduced';
  return native ? 'original' : 'converted';
}
