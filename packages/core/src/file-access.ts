import { ORIGINAL_MIME_TYPES, viewSource } from '@assetforge/contracts';
import { isOpenable, isPreviewable, isVideo, videoFormat, type VideoFormat } from './media-types.js';
import { NotFoundError, StorageUnreachableError, ValidationFailedError } from './errors.js';
import { requireLiveFile } from './file-trash.js';
import type { WorkspaceSession } from './session.js';

export interface PreviewSource {
  sha256: string;
  absolutePath: string;
  /** The container format when the source is a video (its preview is rendered from a frame); null for an image. */
  video: VideoFormat | null;
}

/**
 * null unless the file exists, is complete, has a checksum and is previewable or a video. Storage errors
 * propagate.
 */
export async function resolvePreviewSource(
  s: WorkspaceSession,
  fileId: string,
): Promise<PreviewSource | null> {
  const file = await s.database.files.get(fileId);
  if (file === null || file.status !== 'complete' || file.sha256 === null) return null;
  const video = videoFormat(file.mimeType);
  if (video === null && !isPreviewable(file.mimeType)) return null;
  return { sha256: file.sha256, absolutePath: await s.storage.absolutePath(file.relativePath), video };
}

export interface VideoSource {
  absolutePath: string;
  mimeType: string;
}

/**
 * null unless the file exists, is complete, has a checksum and its MIME type is one of `VIDEO_MIME_TYPES`. Serves
 * a file in the trash as well. Storage errors propagate.
 */
export async function resolveVideoSource(s: WorkspaceSession, fileId: string): Promise<VideoSource | null> {
  const file = await s.database.files.get(fileId);
  if (file === null || file.status !== 'complete' || file.sha256 === null) return null;
  if (!isVideo(file.mimeType)) return null;
  return { absolutePath: await s.storage.absolutePath(file.relativePath), mimeType: file.mimeType };
}

export interface OriginalSource {
  absolutePath: string;
  mimeType: (typeof ORIGINAL_MIME_TYPES)[number];
}

/**
 * null unless the file exists, is complete, has a checksum and viewSource(mimeType, width, height)
 * is 'original' (one of the five native types, dimensions known, longest edge within the limit).
 * Storage errors propagate.
 */
export async function resolveOriginalSource(
  s: WorkspaceSession,
  fileId: string,
): Promise<OriginalSource | null> {
  const file = await s.database.files.get(fileId);
  if (file === null || file.status !== 'complete' || file.sha256 === null) return null;
  if (viewSource(file.mimeType, file.width, file.height) !== 'original') return null;
  const mimeType = ORIGINAL_MIME_TYPES.find((type) => type === file.mimeType);
  if (mimeType === undefined) return null;
  return { absolutePath: await s.storage.absolutePath(file.relativePath), mimeType };
}

/** Absolute path for the shell. 'open' additionally requires isOpenable. */
export async function resolveFilePath(
  s: WorkspaceSession,
  fileId: string,
  purpose: 'open' | 'reveal',
): Promise<string> {
  const file = await s.database.files.get(fileId);
  if (file === null || file.status !== 'complete') throw new NotFoundError('File not found');
  requireLiveFile(file);
  if (!(await s.storage.isReachable())) {
    throw new StorageUnreachableError('The storage of this workspace is not reachable');
  }
  if (purpose === 'open' && !isOpenable(file.relativePath)) {
    throw new ValidationFailedError('This file type is never opened by AssetForge');
  }
  if (!(await s.storage.exists(file.relativePath))) {
    throw new NotFoundError('The file is missing on disk');
  }
  return s.storage.absolutePath(file.relativePath);
}
