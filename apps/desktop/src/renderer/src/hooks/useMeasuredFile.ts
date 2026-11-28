import { useEffect, useRef } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { call } from '../api';

// The measurement of a file imported before dimensions were stored, once per dialog.

/** The dimensions of an image or a video. */
interface Dimensions {
  /** The width in pixels. */
  width: number;
  /** The height in pixels. */
  height: number;
}

/** What a measurement adds to the record: the dimensions, for a video also the duration. */
export type Measured = Dimensions & { durationMs?: number | null };

/** The measurements of a dialog by file id: the result, `pending` while asked, `failed` once refused. */
type Measurements = Map<string, Measured | 'pending' | 'failed'>;

/**
 * Whether the file is shown on a stage: a complete previewable image or a complete video.
 *
 * @param file the file
 * @returns true when the stage shows it
 */
export function isStaged(file: FileRecord): boolean {
  const complete = file.status === 'complete';
  return (complete && file.previewable) || (complete && file.kind === 'video');
}

/**
 * The shown record with a remembered measurement merged in, and the measurement of a staged file without
 * dimensions. The result is remembered, so a record without dimensions (the list's, when the viewer steps back to
 * the file) shows it at once; failed measurements are not repeated and show nothing.
 *
 * @param given the record the dialog was given
 * @param onMeasured receives a new measurement
 * @returns the record to show
 */
export function useMeasuredFile(given: FileRecord, onMeasured: (fileId: string, size: Measured) => void): FileRecord {
  const measured = useRef<Measurements>(new Map());
  const remembered = measured.current.get(given.id);
  const file = given.width === null && typeof remembered === 'object' ? { ...given, ...remembered } : given;
  const fileId = file.id;
  const onMeasuredRef = useRef(onMeasured);
  onMeasuredRef.current = onMeasured;
  const unmeasured = isStaged(file) && file.width === null;
  useEffect(() => {
    if (!unmeasured || measured.current.has(fileId)) return;
    measureFile(measured.current, fileId, onMeasuredRef);
  }, [fileId, unmeasured]);
  return file;
}

/**
 * Asks `files:measure` for a file and remembers the outcome.
 *
 * @param results the dialog's measurements
 * @param fileId the file
 * @param onMeasured the current receiver of a new measurement
 */
function measureFile(
  results: Measurements,
  fileId: string,
  onMeasured: { current: (fileId: string, size: Measured) => void },
): void {
  results.set(fileId, 'pending');
  call('files:measure', { fileId }).then(
    (record) => {
      if (record.width === null || record.height === null) {
        results.set(fileId, 'failed');
        return;
      }
      const size: Measured =
        record.kind === 'video'
          ? { width: record.width, height: record.height, durationMs: record.durationMs }
          : { width: record.width, height: record.height };
      results.set(fileId, size);
      onMeasured.current(fileId, size);
    },
    () => results.set(fileId, 'failed'),
  );
}
