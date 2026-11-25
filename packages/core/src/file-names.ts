const MAX_LENGTH = 100;
const MAX_EXTENSION_LENGTH = 10;

export function sanitizeFileName(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '');
  if (cleaned === '') return 'file';
  if (cleaned.length <= MAX_LENGTH) return cleaned;

  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot - 1 <= MAX_EXTENSION_LENGTH ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX_LENGTH - ext.length) + ext;
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
