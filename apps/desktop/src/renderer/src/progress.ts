import type { WorkflowProgress } from '@assetforge/contracts';

// The workflow progress as text and the template a new workflow starts from.

/**
 * { done: 3, total: 5 } -> '3 / 5'; no workflow -> en dash.
 *
 * @param progress the workflow's progress; null without a workflow
 * @returns the text
 */
export function formatProgress(progress: WorkflowProgress | null): string {
  return progress === null ? '–' : `${progress.done} / ${progress.total}`;
}

/**
 * The user's choice if still available, else the type's default template, else the first template.
 *
 * @param templateIds the available templates
 * @param chosen the user's choice
 * @param typeDefault the asset type's default template
 * @returns the template id; '' when there is none
 */
export function pickTemplate(
  templateIds: readonly string[],
  chosen: string,
  typeDefault: string | null,
): string {
  if (templateIds.includes(chosen)) return chosen;
  if (typeDefault !== null && templateIds.includes(typeDefault)) return typeDefault;
  return templateIds[0] ?? '';
}
