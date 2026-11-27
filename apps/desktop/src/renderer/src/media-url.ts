import { viewSource, type FileRecord, type ViewSource } from '@assetforge/contracts';

export function previewUrl(fileId: string, size: 'thumb' | 'detail' | 'full'): string {
  return `assetforge-media://preview/${fileId}?size=${size}`;
}

export function originalUrl(fileId: string): string {
  return `assetforge-media://original/${fileId}`;
}

/** The original video, streamed with byte ranges by the main process. */
export function videoUrl(fileId: string): string {
  return `assetforge-media://video/${fileId}`;
}

/** The large image of the viewer; null for `none`. */
export function viewUrl(file: Pick<FileRecord, 'id' | 'mimeType' | 'width' | 'height'>): {
  source: ViewSource;
  url: string | null;
} {
  const source = viewSource(file.mimeType, file.width, file.height);
  switch (source) {
    case 'original':
      return { source, url: originalUrl(file.id) };
    case 'converted':
    case 'reduced':
      return { source, url: previewUrl(file.id, 'full') };
    case 'preview':
      return { source, url: previewUrl(file.id, 'detail') };
    case 'none':
      return { source, url: null };
  }
}

/** Upper-cased extension after stripping trailing dots/spaces; 'FILE' when there is none. */
export function formatLabel(originalName: string): string {
  const name = originalName.replace(/[. ]+$/, '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'FILE';
  const ext = name.slice(dot + 1).trim();
  return ext === '' ? 'FILE' : ext.toUpperCase();
}
