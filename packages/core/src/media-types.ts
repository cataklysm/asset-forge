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

/** A file can be opened externally when its kind is image, model, document or video, except SVG. */
export function isOpenable(relativePath: string): boolean {
  const name = diskName(relativePath);
  return fileKind(name) !== 'other' && diskExtension(name) !== 'svg';
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  exr: 'image/x-exr',
  gif: 'image/gif',
  avif: 'image/avif',
  blend: 'application/x-blender',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  fbx: 'application/octet-stream',
  obj: 'model/obj',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
};

const OCTET_STREAM = 'application/octet-stream';

/**
 * The MIME type stored for a file of this name. A video type follows the same extension rule as `fileKind`, so a
 * name has a video type exactly when its kind is `video`.
 */
export function mimeFromFileName(name: string): string {
  if (fileKind(name) === 'video') return MIME_BY_EXTENSION[diskExtension(name)!]!;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return OCTET_STREAM;
  const type = MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? OCTET_STREAM;
  return isVideo(type) ? OCTET_STREAM : type;
}
