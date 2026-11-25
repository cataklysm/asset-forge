import { useState } from 'react';
import { WorkflowStepStateSchema, type AssetWorkflow } from '@assetforge/contracts';
import { call, describeError } from '../api';
import { useLoad } from '../hooks/useLoad';
import { label } from '../labels';
import { formatProgress, pickTemplate } from '../progress';
import { ALERT, BORDER, BUTTON, INPUT, MUTED } from '../ui';
import { CommitInput } from './CommitInput';

interface Props {
  assetId: string;
  assetTypeId: string;
}

export function WorkflowSection({ assetId, assetTypeId }: Props) {
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
    } catch (e) {
      setError(describeError(e));
      return false;
    }
  }

  const updateStep = (
    stepId: string,
    patch: { state?: AssetWorkflow['steps'][number]['state']; notes?: string },
  ) =>
    run(async () => {
      const updated = await call('workflows:updateStep', { stepId, patch });
      setOverride({ assetId, workflow: updated });
    });

  const templateItems = templates.data ?? [];
  const typeDefault =
    (types.data ?? []).find((t) => t.id === assetTypeId)?.defaultWorkflowTemplateId ?? null;
  // Until both lists have settled (success or failure) nothing is preselected or startable.
  const ready = !templates.loading && !types.loading;
  const effectiveTemplate = ready
    ? pickTemplate(
        templateItems.map((t) => t.id),
        chosen,
        typeDefault,
      )
    : '';

  const loadErrors = [loaded, templates, types]
    .map((l) => l.error)
    .filter((e): e is string => e !== null);

  return (
    <section className="space-y-2" aria-label="Workflow">
      <h2 className="text-lg font-semibold">Workflow</h2>
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
      {loadErrors.map((message) => (
        <p key={message} role="alert" className={ALERT}>
          {message}
        </p>
      ))}

      {workflow ? (
        <>
          <p>
            {workflow.templateName} <span className={MUTED}>v{workflow.templateVersion}</span>{' '}
            {formatProgress(workflow.progress)}
          </p>
          <progress
            aria-label="Workflow progress"
            value={workflow.progress.done}
            max={workflow.progress.total}
          />
          <ul className="space-y-2">
            {workflow.steps.map((step) => (
              <li
                key={step.id}
                className={`flex flex-wrap items-center gap-2 border-b pb-2 ${BORDER}`}
              >
                <span>{step.name}</span>
                {!step.mandatory && <span className={MUTED}>Optional</span>}
                <select
                  className={INPUT}
                  aria-label={`State of ${step.name}`}
                  value={step.state}
                  onChange={(e) =>
                    void updateStep(step.id, {
                      state: WorkflowStepStateSchema.parse(e.target.value),
                    })
                  }
                >
                  {WorkflowStepStateSchema.options
                    .filter((s) => s !== 'skipped' || !step.mandatory || step.state === 'skipped')
                    .map((s) => (
                      <option key={s} value={s}>
                        {label(s)}
                      </option>
                    ))}
                </select>
                <CommitInput
                  label={`Notes for ${step.name}`}
                  multiline
                  value={step.notes}
                  maxLength={5000}
                  onCommit={(notes) => updateStep(step.id, { notes })}
                />
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={BUTTON}
            title="Step states and notes are deleted; asks first"
            onClick={() =>
              void run(async () => {
                const { removed } = await call('workflows:remove', { assetId });
                if (!removed) return;
                setOverride({ assetId, workflow: null });
              })
            }
          >
            Remove workflow
          </button>
        </>
      ) : (
        !resolved && <p className={MUTED}>Loading…</p>
      )}

      {!workflow && resolved && loaded.error === null && (
        <div className="flex items-center gap-2">
          <select
            className={INPUT}
            aria-label="Workflow template"
            value={effectiveTemplate}
            disabled={!ready}
            onChange={(e) => setChosen(e.target.value)}
          >
            {templateItems.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={BUTTON}
            disabled={effectiveTemplate === ''}
            onClick={() =>
              void run(async () => {
                const started = await call('workflows:start', {
                  assetId,
                  templateId: effectiveTemplate,
                });
                setOverride({ assetId, workflow: started });
              })
            }
          >
            Start workflow
          </button>
        </div>
      )}
    </section>
  );
}
