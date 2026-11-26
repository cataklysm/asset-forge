import type { AnalysisSkipReason, FileRecord } from '@assetforge/contracts';
import { call } from './api';
import type { ResultFailure } from './components/ResultStrip';
import type { FileSelection } from './selection';

/** Tooltip of the Analyse button when the selection holds no analysable image. */
export const NONE_ANALYSABLE = 'None of the selected files is an image that can be analysed';

const SKIP_REASONS: Record<AnalysisSkipReason, string> = {
  not_found: 'File not found',
  not_analysable: 'Not an image that can be analysed',
  already_queued: 'Already queued',
};

/** A completely imported image with a preview: the vision model can tag it. */
export function analysable(file: FileRecord): boolean {
  return file.status === 'complete' && file.previewable;
}

/** The selected files an analysis can act on, in selection order. */
export function analysableFiles(sel: FileSelection): FileRecord[] {
  return [...sel.selected.values()].filter(analysable);
}

/** Calls analysis:enqueue; the title is "<n> queued, <m> skipped" and one failure per skipped file. */
export async function startAnalysis(files: readonly FileRecord[]): Promise<{ title: string; failures: ResultFailure[] }> {
  const { enqueued, skipped } = await call('analysis:enqueue', { fileIds: files.map((f) => f.id) });
  const names = new Map(files.map((f) => [f.id, f.originalName]));
  return {
    title: `${enqueued} queued, ${skipped.length} skipped`,
    failures: skipped.map((s) => ({ key: s.fileId, name: names.get(s.fileId) ?? s.fileId, message: SKIP_REASONS[s.reason] })),
  };
}
