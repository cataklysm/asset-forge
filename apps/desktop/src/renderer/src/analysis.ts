import type { EnqueueAnalysisResult, FileRecord } from '@assetforge/contracts';
import { SKIP_LABELS } from './labels';
import type { FileSelection } from './selection';

/** Tooltip of the Analyse button when the selection holds no analysable image. */
export const NONE_ANALYSABLE = 'None of the selected files is an image that can be analysed';

/**
 * Whether the vision model can tag a file: a completely imported image with a preview.
 *
 * @param file the file
 * @returns true when an analysis can act on it
 */
export function analysable(file: FileRecord): boolean {
  return file.status === 'complete' && file.previewable;
}

/**
 * The selected files an analysis can act on, in selection order.
 *
 * @param selection the file selection
 * @returns the analysable selected files
 */
export function analysableFiles(selection: FileSelection): FileRecord[] {
  return [...selection.selected.values()].filter(analysable);
}

/**
 * The only selected file when the selection is exactly one analysable image.
 *
 * @param selection the file selection
 * @returns that file, else null
 */
export function singleAnalysable(selection: FileSelection): FileRecord | null {
  if (selection.selected.size !== 1) return null;
  const [file] = selection.selected.values();
  return file !== undefined && analysable(file) ? file : null;
}

/** The order in which the skip reasons of a start are named. */
const SKIP_ORDER = ['alreadyAnalysed', 'alreadyQueued', 'notAnalysable', 'notFound'] as const;

/**
 * The result strip title of a start: "<n> queued" and each skip reason that is not zero.
 *
 * @param result the answer of `analysis:enqueue`
 * @returns the title
 */
export function enqueueTitle(result: EnqueueAnalysisResult): string {
  const parts = [`${result.enqueued} queued`];
  for (const reason of SKIP_ORDER) {
    const count = result.skipped[reason];
    if (count > 0) parts.push(`${count} ${SKIP_LABELS[reason]}`);
  }
  return parts.join(', ');
}
