import type { FileKind } from '@assetforge/contracts';

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

/** MIME types of the videos the app plays and takes a frame from. */
export const VIDEO_MIME_TYPES: readonly string[] = ['video/mp4', 'video/webm'];

/** The container format of a video, which decides how the frame tool reads it. */
export type VideoFormat = 'mp4' | 'webm';

export function isVideo(mimeType: string): boolean {
  return VIDEO_MIME_TYPES.includes(mimeType);
}

/** The container format of a video MIME type; null for anything else. */
export function videoFormat(mimeType: string): VideoFormat | null {
  if (mimeType === 'video/mp4') return 'mp4';
  if (mimeType === 'video/webm') return 'webm';
  return null;
}

/** A thumbnail can be made: a previewable image, or a video through one of its frames. */
export function hasThumbnail(mimeType: string): boolean {
  return isPreviewable(mimeType) || isVideo(mimeType);
}

/** Extensions (lower case, no dot) per file kind; everything else, including no extension, is `other`. */
export const FILE_KIND_EXTENSIONS: Readonly<Record<Exclude<FileKind, 'other'>, readonly string[]>> = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'gif', 'avif', 'bmp', 'exr', 'hdr', 'tga', 'psd', 'svg'],
  model: [
    'blend', 'glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'usd', 'usda', 'usdc', 'usdz', 'dae', 'abc', 'ztl', 'spp',
    'sbs', 'sbsar',
  ],
  document: ['pdf', 'txt', 'md', 'doc', 'docx', 'odt', 'rtf'],
  video: ['mp4', 'm4v', 'webm'],
};

/** Extensions (lower case, no dot) of programs, installers and shortcuts that are never imported. */
export const REFUSED_IMPORT_EXTENSIONS: readonly string[] = [
  'exe', 'com', 'scr', 'msi', 'msp', 'msix', 'appx', 'appinstaller', 'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'vbs',
  'vbe', 'jse', 'wsf', 'wsh', 'ws', 'wsc', 'sct', 'hta', 'cpl', 'dll', 'sys', 'lnk', 'url', 'pif', 'reg', 'jar',
  'app', 'dmg', 'pkg', 'appimage', 'iso', 'vhd',
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

/** The kind of a file, derived from the extension of its name. */
export function fileKind(fileName: string): FileKind {
  const extension = diskExtension(fileName);
  if (extension === null) return 'other';
  for (const kind of Object.keys(FILE_KIND_EXTENSIONS) as Exclude<FileKind, 'other'>[]) {
    if (FILE_KIND_EXTENSIONS[kind].includes(extension)) return kind;
  }
  return 'other';
}

/** Last extension after stripping trailing dots and spaces, lower case; unlike `diskExtension` a leading dot counts. */
export function importExtension(fileName: string): string | null {
  const trimmed = fileName.replace(/[. ]+$/, '');
  const dot = trimmed.lastIndexOf('.');
  if (dot < 0) return null;
  const extension = trimmed.slice(dot + 1);
  return extension === '' ? null : extension.toLowerCase();
}

/**
 * True when the name, or its part before the first `:` (an NTFS alternate data stream such as
 * `a.exe::$DATA` or `a.exe:stream`, where Windows opens the main stream), has a refused extension.
 */
export function isRefusedImport(fileName: string): boolean {
  const refused = (name: string) => {
    const extension = importExtension(name);
    return extension !== null && REFUSED_IMPORT_EXTENSIONS.includes(extension);
  };
  const colon = fileName.indexOf(':');
  return refused(fileName) || (colon >= 0 && refused(fileName.slice(0, colon)));
}

/** True for a ZIP archive by its name; decides both which sources are unpacked and that entries are not. */
export function isZipArchive(fileName: string): boolean {
  return importExtension(fileName) === 'zip';
}

/** A file can be opened externally when its kind is image, model, document or video, except SVG. */
export function isOpenable(relativePath: string): boolean {
  const name = diskName(relativePath);
  return fileKind(name) !== 'other' && diskExtension(name) !== 'svg';
}
