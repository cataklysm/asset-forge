import type { FileRecord } from '@assetforge/contracts';
import { call } from './api';
import type { ResultFailure } from './components/ResultStrip';
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

/** Stand-in model name until the renderer offers the model choice. */
// phase 4b stub: Task 12 (removed with the model choice)
export const TEMP_MODEL = 'unset';

/** Calls analysis:enqueue for the files in apply mode; the title is "<n> queued, <m> skipped". */
export async function startAnalysis(files: readonly FileRecord[]): Promise<{ title: string; failures: ResultFailure[] }> {
  const { enqueued, skipped } = await call('analysis:enqueue', {
    target: { kind: 'files', fileIds: files.map((f) => f.id) },
    model: TEMP_MODEL,
    mode: 'apply',
    force: true,
  });
  const skippedCount = skipped.notFound + skipped.notAnalysable + skipped.alreadyQueued + skipped.alreadyAnalysed;
  return { title: `${enqueued} queued, ${skippedCount} skipped`, failures: [] };
}
