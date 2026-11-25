import type { WorkflowProgress } from '@assetforge/contracts';

/** { done: 3, total: 5 } -> '3 / 5'; no workflow -> en dash. */
export function formatProgress(p: WorkflowProgress | null): string {
  return p === null ? '–' : `${p.done} / ${p.total}`;
}

/** The user's choice if still available, else the type's default template, else the first template. */
export function pickTemplate(
  templateIds: readonly string[],
  chosen: string,
  typeDefault: string | null,
): string {
  if (templateIds.includes(chosen)) return chosen;
  if (typeDefault !== null && templateIds.includes(typeDefault)) return typeDefault;
  return templateIds[0] ?? '';
}
