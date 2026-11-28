import type { AssetWorkflow, WorkflowTemplate } from '@assetforge/contracts';
import { useState } from 'react';
import { call, describeError } from '../api';
import { pickTemplate } from '../progress';
import { latestOnly, useLoad, type LatestResult } from './useLoad';

/** The fields `workflows:updateStep` takes. */
export type StepPatch = { state?: AssetWorkflow['steps'][number]['state']; notes?: string };

/** What `useWorkflow` hands to the workflow section. */
interface WorkflowState {
  /** The workflow of the asset, or null when it has none (or while loading). */
  workflow: AssetWorkflow | null;
  /** Whether the workflow is known: loaded, failed, or replaced by a mutation. */
  resolved: boolean;
  /** The message of a failed workflow load. */
  loadError: string | null;
  /** The messages of every failed load. */
  loadErrors: string[];
  /** The message of the last failed action. */
  error: string | null;
  templates: WorkflowTemplate[];
  /** Whether templates and asset types have settled. */
  ready: boolean;
  /** The template to start: the chosen one, else the asset type's default, else the first; '' until ready. */
  effectiveTemplate: string;
  choose(templateId: string): void;
  updateStep(stepId: string, patch: StepPatch): Promise<boolean>;
  /** Removes the workflow; nothing changes when the main process answers that nothing was removed. */
  remove(): Promise<boolean>;
  start(): Promise<boolean>;
}

/** The workflow a mutation answered, for the asset it belongs to. */
interface WorkflowOverride {
  assetId: string;
  workflow: AssetWorkflow | null;
}

/** What a workflow mutation works with. */
interface MutationContext {
  assetId: string;
  setError(message: string | null): void;
  setOverride(override: WorkflowOverride): void;
  /** Reports whether a later mutation was started meanwhile. */
  track(promise: Promise<AssetWorkflow | null | undefined>): Promise<LatestResult<AssetWorkflow | null | undefined>>;
}

/**
 * Runs one mutation and shows the workflow it answers. Only the answer of the mutation started last is shown: the
 * main process writes in the order the requests were sent, so that answer holds every earlier change too.
 *
 * @param context the asset, the state setters and the tracker
 * @param request the mutation; resolves to the workflow to show, or undefined when nothing changed
 * @returns false when the mutation failed, true otherwise (also when a later one superseded it)
 */
async function mutate(
  context: MutationContext,
  request: () => Promise<AssetWorkflow | null | undefined>,
): Promise<boolean> {
  context.setError(null);
  const result = await context.track(request());
  if (result.stale) return true;
  if ('error' in result) {
    context.setError(describeError(result.error));
    return false;
  }
  if (result.value !== undefined) context.setOverride({ assetId: context.assetId, workflow: result.value });
  return true;
}

/**
 * Removes the asset's workflow (the main process asks first) and reads back what it holds afterwards.
 *
 * @param assetId the asset
 * @returns the workflow after the removal, or undefined when nothing was removed
 */
async function removeAndReload(assetId: string): Promise<AssetWorkflow | null | undefined> {
  const { removed } = await call('workflows:remove', { assetId });
  if (!removed) return undefined;
  try {
    return await call('workflows:get', { assetId });
  } catch {
    // The removal is done; a failed read must not keep the removed workflow on screen.
    return null;
  }
}

/**
 * The workflow of one asset with its templates, and the actions on it. The workflow a mutation
 * answers replaces the loaded one without a reload.
 *
 * @param assetId the asset
 * @param assetTypeId its type, whose default template is preselected
 * @returns the workflow, the template choice, the errors and the actions
 */
export function useWorkflow(assetId: string, assetTypeId: string): WorkflowState {
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState('');
  // The workflow returned by a mutation replaces the loaded one without a reload.
  const [override, setOverride] = useState<WorkflowOverride | null>(null);
  const [track] = useState(() => latestOnly<AssetWorkflow | null | undefined>());

  const loaded = useLoad(() => call('workflows:get', { assetId }), [assetId]);
  const templates = useLoad(() => call('workflowTemplates:list', {}), []);
  const types = useLoad(() => call('assetTypes:list', {}), []);

  const workflow = override?.assetId === assetId ? override.workflow : loaded.data;
  const resolved = override?.assetId === assetId || !loaded.loading;
  const context: MutationContext = { assetId, setError, setOverride, track };

  const templateItems = templates.data ?? [];
  const typeDefault = (types.data ?? []).find((type) => type.id === assetTypeId)?.defaultWorkflowTemplateId ?? null;
  // Until both lists have settled (success or failure) nothing is preselected or startable.
  const ready = !templates.loading && !types.loading;
  const effectiveTemplate = ready
    ? pickTemplate(
        templateItems.map((template) => template.id),
        chosen,
        typeDefault,
      )
    : '';

  return {
    workflow: workflow ?? null,
    resolved,
    loadError: loaded.error,
    loadErrors: [loaded, templates, types]
      .map((load) => load.error)
      .filter((message): message is string => message !== null),
    error,
    templates: templateItems,
    ready,
    effectiveTemplate,
    choose: setChosen,
    updateStep: (stepId, patch) => mutate(context, () => call('workflows:updateStep', { stepId, patch })),
    remove: () => mutate(context, () => removeAndReload(assetId)),
    start: () => mutate(context, () => call('workflows:start', { assetId, templateId: effectiveTemplate })),
  };
}
