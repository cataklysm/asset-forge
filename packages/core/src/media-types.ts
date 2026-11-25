/** MIME types for which a preview (thumbnail) can be generated, in spec order. */
export const PREVIEWABLE_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/tiff',
  'image/gif',
  'image/avif',
];

export function isPreviewable(mimeType: string): boolean {
  return PREVIEWABLE_MIME_TYPES.includes(mimeType);
}

/** Extensions (lower case, no dot) of programs and scripts that are never opened externally. */
export const BLOCKED_OPEN_EXTENSIONS: readonly string[] = [
  'exe',
  'com',
  'bat',
  'cmd',
  'msi',
  'scr',
  'pif',
  'lnk',
  'ps1',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'wsh',
  'hta',
  'jar',
  'sh',
  'app',
  'command',
  'desktop',
  'html',
  'htm',
  'svg',
  'url',
  'reg',
  'py',
  'pyw',
  'psm1',
  'chm',
  'jnlp',
  'application',
  'appref-ms',
  'settingcontent-ms',
  'library-ms',
  'msc',
  'cpl',
  'msp',
  'scf',
  'inf',
  'website',
  'diagcab',
];

/** Lower-case extension of an on-disk name after stripping trailing dots and spaces; null when none. */
export function diskExtension(fileName: string): string | null {
  const trimmed = fileName.replace(/[. ]+$/, '');
  const dot = trimmed.lastIndexOf('.');
  // A name whose only dot is the first character has no extension.
  if (dot <= 0) return null;
  const extension = trimmed.slice(dot + 1);
  return extension === '' ? null : extension.toLowerCase();
}

/** Last `/` segment of a relative storage path. */
export function diskName(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf('/') + 1);
}

/** A file can be opened externally unless it has no extension or the extension is blocked. */
export function isOpenable(relativePath: string): boolean {
  const extension = diskExtension(diskName(relativePath));
  return extension !== null && !BLOCKED_OPEN_EXTENSIONS.includes(extension);
}
