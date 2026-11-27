import type { FileRecord } from '@assetforge/contracts';
import { NotFoundError, StorageUnreachableError } from './errors.js';
import { isPreviewable, type VideoFormat, videoFormat } from './media-types.js';
import type { VideoInfo } from './ports.js';
import type { WorkspaceSession } from './session.js';

const isPositiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;

/** A width or height that is not a positive integer makes the answer unknown; such a duration makes only the duration unknown. */
function validVideoInfo(info: VideoInfo | null): VideoInfo | null {
  if (info === null || !isPositiveInteger(info.width) || !isPositiveInteger(info.height)) return null;
  const durationMs = info.durationMs !== null && isPositiveInteger(info.durationMs) ? info.durationMs : null;
  return { width: info.width, height: info.height, durationMs };
}

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
 */
export async function planMeasurement(
  s: WorkspaceSession,
  fileId: string,
): Promise<{ file: FileRecord; target: MeasureTarget | null }> {
  const file = await s.database.files.get(fileId);
  if (file === null) throw new NotFoundError('File not found');
  const video = videoFormat(file.mimeType);
  if (file.status !== 'complete' || (video === null && !isPreviewable(file.mimeType))) return { file, target: null };
  if (file.width !== null && file.height !== null) return { file, target: null };
  if (!(await s.storage.isReachable())) {
    throw new StorageUnreachableError('The storage of this workspace is not reachable');
  }
  if (!(await s.storage.exists(file.relativePath))) return { file, target: null };
  return { file, target: { file, absolutePath: await s.storage.absolutePath(file.relativePath), video } };
}

/** Runs the image or video probe; null when the size cannot be determined. Touches no database. */
export async function probeMeasurement(
  probes: Pick<WorkspaceSession, 'imageProbe' | 'videoProbe'>,
  target: MeasureTarget,
): Promise<MeasuredSize | null> {
  try {
    return target.video === null
      ? await probes.imageProbe.measure(target.absolutePath)
      : validVideoInfo(await probes.videoProbe.measure(target.absolutePath, target.video));
  } catch {
    return null;
  }
}

/**
 * Stores a probed size only while the file is still the one that was probed: present, complete, at the same
 * place, with the same content and still unmeasured. Otherwise writes nothing and answers the current record.
 */
export async function storeMeasurement(s: WorkspaceSession, target: MeasureTarget, size: MeasuredSize): Promise<FileRecord> {
  const current = await s.database.files.get(target.file.id);
  if (current === null) throw new NotFoundError('File not found');
  const unchanged =
    current.status === 'complete' &&
    current.relativePath === target.file.relativePath &&
    current.sha256 === target.file.sha256 &&
    current.width === null &&
    current.height === null;
  return unchanged ? s.database.files.setDimensions(current.id, size) : current;
}

/**
 * Stores the pixel size of a complete, previewable file that has none yet, and for a complete video its
 * displayed size and duration through the video probe. Idempotent: a file that already has dimensions is
 * returned as is. A file whose size cannot be determined stays unchanged. The probe runs outside any
 * database transaction. `WorkspaceManager.measureFile` runs the same steps with the probe outside its queue.
 */
export async function measureFile(s: WorkspaceSession, fileId: string): Promise<FileRecord> {
  const { file, target } = await planMeasurement(s, fileId);
  if (target === null) return file;
  const size = await probeMeasurement(s, target);
  return size === null ? file : storeMeasurement(s, target, size);
}
