const MAX_LENGTH = 100;
const MAX_EXTENSION_LENGTH = 10;

const PLACEHOLDER_STEM = 'file';

/**
 * Turns an arbitrary source name into a single safe path segment: Unicode letters and
 * digits plus `.`, `_` and `-` survive, everything else becomes `_`. Trailing dots and
 * spaces are dropped because Windows drops them when creating the file, which would make
 * the stored relative path differ from the on-disk name.
 */
export function sanitizeFileName(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const replaced = base.replace(/[. ]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '_');

  // A stem made only of replacement characters (e.g. `???.png`) gets a placeholder so the
  // extension survives; a stem of dots only (e.g. `..hidden`) is a leading-dot name.
  const dot = replaced.lastIndexOf('.');
  const stem = dot > 0 ? replaced.slice(0, dot) : '';
  const cleaned =
    /^[._]+$/.test(stem) && stem.includes('_')
      ? PLACEHOLDER_STEM + replaced.slice(dot)
      : replaced.replace(/^[._]+/, '');
  if (cleaned === '') return PLACEHOLDER_STEM;

  // Count code points so truncation never splits a surrogate pair.
  const chars = [...cleaned];
  if (chars.length <= MAX_LENGTH) return cleaned;
  const extDot = cleaned.lastIndexOf('.');
  const ext = extDot > 0 && [...cleaned.slice(extDot + 1)].length <= MAX_EXTENSION_LENGTH ? cleaned.slice(extDot) : '';
  return chars.slice(0, MAX_LENGTH - [...ext].length).join('').replace(/\.+$/, '') + ext;
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
  blend: 'application/x-blender',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  fbx: 'application/octet-stream',
  obj: 'model/obj',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
};

export function mimeFromFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}
