import { ORIGINAL_MIME_TYPES, viewSource, type FileRecord } from '@assetforge/contracts';
import { isOpenable, isPreviewable, isVideo, videoFormat, type VideoFormat } from './media-types.js';
import { NotFoundError, ValidationFailedError } from './errors.js';
import { requireLiveFile } from './file-trash.js';
import type { WorkspaceSession } from './session.js';
import { requireReachableStorage } from './storage-reachability.js';

/** The source a preview is rendered from. */
export interface PreviewSource {
  sha256: string;
  absolutePath: string;
  /** The container format when the source is a video (its preview is rendered from a frame); null for an image. */
  video: VideoFormat | null;
}

/**
 * The file row when it exists, is complete and has a checksum.
 *
 * @param session the open workspace
 * @param fileId the file
 * @returns the file; null otherwise
 */
async function completeFile(session: WorkspaceSession, fileId: string): Promise<FileRecord | null> {
  const file = await session.database.files.get(fileId);
  if (file === null || file.status !== 'complete' || file.sha256 === null) return null;
  return file;
}

/**
 * The absolute path of a file the media protocol serves, refused while the storage cannot be reached, so a dropped
 * share answers "unreachable" instead of a path that then reads as missing.
 *
 * @param session the open workspace
 * @param relativePath the file's relative path
 * @returns the absolute path
 * @throws StorageUnreachableError while the storage cannot be reached
 */
async function reachablePath(session: WorkspaceSession, relativePath: string): Promise<string> {
  await requireReachableStorage(session.storage);
  return session.storage.absolutePath(relativePath);
}

/**
 * null unless the file exists, is complete, has a checksum and is previewable or a video. Storage errors
 * propagate.
 *
 * @param session the open workspace
 * @param fileId the file
 * @returns the preview source; null otherwise
 */
export async function resolvePreviewSource(session: WorkspaceSession, fileId: string): Promise<PreviewSource | null> {
  const file = await completeFile(session, fileId);
  if (file === null) return null;
  const video = videoFormat(file.mimeType);
  if (video === null && !isPreviewable(file.mimeType)) return null;
  return { sha256: file.sha256!, absolutePath: await reachablePath(session, file.relativePath), video };
}

/** The original of a video the media protocol streams. */
export interface VideoSource {
  absolutePath: string;
  mimeType: string;
}

/**
 * null unless the file exists, is complete, has a checksum and its MIME type is one of `VIDEO_MIME_TYPES`. Serves
 * a file in the trash as well. Storage errors propagate.
 *
 * @param session the open workspace
 * @param fileId the file
 * @returns the video source; null otherwise
 */
export async function resolveVideoSource(session: WorkspaceSession, fileId: string): Promise<VideoSource | null> {
  const file = await completeFile(session, fileId);
  if (file === null || !isVideo(file.mimeType)) return null;
  return { absolutePath: await reachablePath(session, file.relativePath), mimeType: file.mimeType };
}

/** The original of an image the renderer decodes itself. */
export interface OriginalSource {
  absolutePath: string;
  mimeType: (typeof ORIGINAL_MIME_TYPES)[number];
}

/**
 * null unless the file exists, is complete, has a checksum and viewSource(mimeType, width, height)
 * is 'original' (one of the five native types, dimensions known, longest edge within the limit).
 * Storage errors propagate.
 *
 * @param session the open workspace
 * @param fileId the file
 * @returns the original source; null otherwise
 */
export async function resolveOriginalSource(session: WorkspaceSession, fileId: string): Promise<OriginalSource | null> {
  const file = await completeFile(session, fileId);
  if (file === null || viewSource(file.mimeType, file.width, file.height) !== 'original') return null;
  const mimeType = ORIGINAL_MIME_TYPES.find((type) => type === file.mimeType);
  if (mimeType === undefined) return null;
  return { absolutePath: await reachablePath(session, file.relativePath), mimeType };
}

/**
 * Absolute path for the shell. 'open' additionally requires isOpenable.
 *
 * @param session the open workspace
 * @param fileId the file
 * @param purpose open the file, or reveal it in its folder
 * @returns the absolute path
 * @throws NotFoundError for an unknown, incomplete or missing file, InvalidOperationError for a file in the trash,
 *   StorageUnreachableError, ValidationFailedError for a file that is never opened
 */
export async function resolveFilePath(
  session: WorkspaceSession,
  fileId: string,
  purpose: 'open' | 'reveal',
): Promise<string> {
  const file = await session.database.files.get(fileId);
  if (file === null || file.status !== 'complete') throw new NotFoundError('File not found');
  requireLiveFile(file);
  await requireReachableStorage(session.storage);
  if (purpose === 'open' && !isOpenable(file.relativePath)) {
    throw new ValidationFailedError('This file type is never opened by AssetForge');
  }
  if (!(await session.storage.exists(file.relativePath))) {
    throw new NotFoundError('The file is missing on disk');
  }
  return session.storage.absolutePath(file.relativePath);
}
