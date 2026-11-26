import type { EnqueueAnalysisResult, FileRecord } from '@assetforge/contracts';
import { SKIP_LABELS } from './labels';
import type { FileSelection } from './selection';

/** Tooltip of the Analyse button when the selection holds no analysable image. */
export const NONE_ANALYSABLE = 'None of the selected files is an image that can be analysed';

/** A completely imported image with a preview: the vision model can tag it. */
export function analysable(file: FileRecord): boolean {
  return file.status === 'complete' && file.previewable;
}

/** The selected files an analysis can act on, in selection order. */
export function analysableFiles(sel: FileSelection): FileRecord[] {
  return [...sel.selected.values()].filter(analysable);
}

/** The only selected file when the selection is exactly one analysable image, else null. */
export function singleAnalysable(sel: FileSelection): FileRecord | null {
  if (sel.selected.size !== 1) return null;
  const [file] = sel.selected.values();
  return file !== undefined && analysable(file) ? file : null;
}

const SKIP_ORDER = ['alreadyAnalysed', 'alreadyQueued', 'notAnalysable', 'notFound'] as const;

/** The result strip title of a start: "<n> queued" and each skip reason that is not zero. */
export function enqueueTitle(result: EnqueueAnalysisResult): string {
  const parts = [`${result.enqueued} queued`];
  for (const reason of SKIP_ORDER) {
    const count = result.skipped[reason];
    if (count > 0) parts.push(`${count} ${SKIP_LABELS[reason]}`);
  }
  return parts.join(', ');
}
