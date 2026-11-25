import type { WorkflowProgress } from '@assetforge/contracts';

/** { done: 3, total: 5 } -> '3 / 5'; no workflow -> en dash. */
export function formatProgress(p: WorkflowProgress | null): string {
  return p === null ? '–' : `${p.done} / ${p.total}`;
}
