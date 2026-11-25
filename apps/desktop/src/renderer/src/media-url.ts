export function previewUrl(fileId: string, size: 'thumb' | 'detail'): string {
  return `assetforge-media://preview/${fileId}?size=${size}`;
}

/** Upper-cased extension after stripping trailing dots/spaces; 'FILE' when there is none. */
export function formatLabel(originalName: string): string {
  const name = originalName.replace(/[. ]+$/, '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'FILE';
  const ext = name.slice(dot + 1).trim();
  return ext === '' ? 'FILE' : ext.toUpperCase();
}
