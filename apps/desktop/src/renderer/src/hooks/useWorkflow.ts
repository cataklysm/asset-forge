import type { AssetWorkflow, WorkflowTemplate } from '@assetforge/contracts';
import { useState } from 'react';
import { call, describeError } from '../api';
import { pickTemplate } from '../progress';
import { useLoad } from './useLoad';

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
  const [override, setOverride] = useState<{
    assetId: string;
    workflow: AssetWorkflow | null;
  } | null>(null);

  const loaded = useLoad(() => call('workflows:get', { assetId }), [assetId]);
  const templates = useLoad(() => call('workflowTemplates:list', {}), []);
  const types = useLoad(() => call('assetTypes:list', {}), []);

  const workflow = override?.assetId === assetId ? override.workflow : loaded.data;
  const resolved = override?.assetId === assetId || !loaded.loading;

  async function run(action: () => Promise<void>): Promise<boolean> {
    setError(null);
    try {
      await action();
      return true;
    } catch (failure) {
      setError(describeError(failure));
      return false;
    }
  }

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
    loadErrors: [loaded, templates, types].map((load) => load.error).filter((message): message is string => message !== null),
    error,
    templates: templateItems,
    ready,
    effectiveTemplate,
    choose: setChosen,
    updateStep: (stepId, patch) =>
      run(async () => {
        const updated = await call('workflows:updateStep', { stepId, patch });
        setOverride({ assetId, workflow: updated });
      }),
    remove: () =>
      run(async () => {
        const { removed } = await call('workflows:remove', { assetId });
        if (!removed) return;
        setOverride({ assetId, workflow: null });
      }),
    start: () =>
      run(async () => {
        const started = await call('workflows:start', { assetId, templateId: effectiveTemplate });
        setOverride({ assetId, workflow: started });
      }),
  };
}
