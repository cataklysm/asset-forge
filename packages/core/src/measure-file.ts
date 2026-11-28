import type { FileRecord } from '@assetforge/contracts';
import { NotFoundError, StorageUnreachableError } from './errors.js';
import { isPreviewable, type VideoFormat, videoFormat } from './media-types.js';
import type { VideoInfo } from './ports/media-probes.js';
import type { WorkspaceSession } from './session.js';

/**
 * Whether a probed value is usable.
 *
 * @param value the probed value
 * @returns true for a positive safe integer
 */
function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * A width or height that is not a positive integer makes the answer unknown; such a duration makes only the
 * duration unknown.
 *
 * @param info what the video probe answered
 * @returns the usable answer; null when the size is unknown
 */
function validVideoInfo(info: VideoInfo | null): VideoInfo | null {
  if (info === null || !isPositiveInteger(info.width) || !isPositiveInteger(info.height)) return null;
  const durationMs = info.durationMs !== null && isPositiveInteger(info.durationMs) ? info.durationMs : null;
  return { width: info.width, height: info.height, durationMs };
}

/** A probed size, with the duration of a video. */
export type MeasuredSize = { width: number; height: number; durationMs?: number | null };

/** What a measurement probes: the file as it was read, its absolute path and, for a video, its format. */
export interface MeasureTarget {
  readonly file: FileRecord;
  readonly absolutePath: string;
  readonly video: VideoFormat | null;
}

/**
 * Reads the file and decides whether it needs a measurement: a complete, previewable image or a complete video
 * without dimensions whose binary is present. `target` is null when there is nothing to measure.
 *
 * @param session the open workspace
 * @param fileId the file
 * @returns the file as read and what to probe
 * @throws NotFoundError for an unknown file, StorageUnreachableError
 */
export async function planMeasurement(
  session: WorkspaceSession,
  fileId: string,
): Promise<{ file: FileRecord; target: MeasureTarget | null }> {
  const file = await session.database.files.get(fileId);
  if (file === null) throw new NotFoundError('File not found');
  const video = videoFormat(file.mimeType);
  if (file.status !== 'complete' || (video === null && !isPreviewable(file.mimeType))) return { file, target: null };
  if (file.width !== null && file.height !== null) return { file, target: null };
  if (!(await session.storage.isReachable())) {
    throw new StorageUnreachableError('The storage of this workspace is not reachable');
  }
  if (!(await session.storage.exists(file.relativePath))) return { file, target: null };
  return { file, target: { file, absolutePath: await session.storage.absolutePath(file.relativePath), video } };
}

/**
 * Runs the image or video probe. Touches no database.
 *
 * @param probes the image and video probes
 * @param target what to probe
 * @returns the size; null when it cannot be determined
 */
export async function probeMeasurement(
  probes: Pick<WorkspaceSession, 'imageProbe' | 'videoProbe'>,
  target: MeasureTarget,
): Promise<MeasuredSize | null> {
  try {
    if (target.video === null) return await probes.imageProbe.measure(target.absolutePath);
    return validVideoInfo(await probes.videoProbe.measure(target.absolutePath, target.video));
  } catch {
    return null;
  }
}

/**
 * Stores a probed size only while the file is still the one that was probed: present, complete, at the same
 * place, with the same content and still unmeasured. Otherwise writes nothing and answers the current record.
 *
 * @param session the open workspace
 * @param target what was probed
 * @param size the probed size
 * @returns the file afterwards
 * @throws NotFoundError when the file is gone
 */
export async function storeMeasurement(
  session: WorkspaceSession,
  target: MeasureTarget,
  size: MeasuredSize,
): Promise<FileRecord> {
  const current = await session.database.files.get(target.file.id);
  if (current === null) throw new NotFoundError('File not found');
  const isUnchanged =
    current.status === 'complete' &&
    current.relativePath === target.file.relativePath &&
    current.sha256 === target.file.sha256 &&
    current.width === null &&
    current.height === null;
  return isUnchanged ? session.database.files.setDimensions(current.id, size) : current;
}

/**
 * Stores the pixel size of a complete, previewable file that has none yet, and for a complete video its
 * displayed size and duration through the video probe. Idempotent: a file that already has dimensions is
 * returned as is. A file whose size cannot be determined stays unchanged. The probe runs outside any
 * database transaction. `WorkspaceManager.measureFile` runs the same steps with the probe outside its queue.
 *
 * @param session the open workspace
 * @param fileId the file
 * @returns the file afterwards
 */
export async function measureFile(session: WorkspaceSession, fileId: string): Promise<FileRecord> {
  const { file, target } = await planMeasurement(session, fileId);
  if (target === null) return file;
  const size = await probeMeasurement(session, target);
  return size === null ? file : storeMeasurement(session, target, size);
}
