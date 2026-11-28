import { WorkflowStepStateSchema, type AssetWorkflow, type WorkflowTemplate } from '@assetforge/contracts';
import { useWorkflow, type StepPatch } from '../hooks/useWorkflow';
import {
  label,
  LOADING_LABEL,
  NOTES_LABEL,
  notesForLabel,
  OPTIONAL_STEP_LABEL,
  REMOVE_WORKFLOW_LABEL,
  REMOVE_WORKFLOW_TITLE,
  START_WORKFLOW_LABEL,
  stepStateLabel,
  WORKFLOW_PROGRESS_LABEL,
  WORKFLOW_SECTION_LABEL,
  WORKFLOW_TEMPLATE_LABEL,
} from '../labels';
import { formatProgress } from '../progress';
import { ALERT, BORDER, BUTTON, MUTED, SELECT } from '../ui';
import { CommitInput } from './CommitInput';

/** The props of `WorkflowSection`. */
interface Props {
  assetId: string;
  /** The asset's type, whose default template is preselected. */
  assetTypeId: string;
}

/** One step of a workflow. */
type Step = AssetWorkflow['steps'][number];

/**
 * The Workflow tab of the asset screen: the running workflow with its steps, or the template
 * select to start one.
 *
 * @param props the asset and its type
 * @returns the section
 */
export function WorkflowSection({ assetId, assetTypeId }: Props) {
  const state = useWorkflow(assetId, assetTypeId);
  const { workflow, resolved, error } = state;

  return (
    <section className="space-y-3" aria-label={WORKFLOW_SECTION_LABEL}>
      {error !== null && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
      {/* Two loads can fail with the same message, so the position is the key. */}
      {state.loadErrors.map((message, index) => (
        <p key={index} role="alert" className={ALERT}>
          {message}
        </p>
      ))}

      {workflow ? (
        <RunningWorkflow workflow={workflow} updateStep={state.updateStep} remove={state.remove} />
      ) : (
        !resolved && <p className={MUTED}>{LOADING_LABEL}</p>
      )}

      {!workflow && resolved && state.loadError === null && (
        <StartWorkflow
          templates={state.templates}
          effectiveTemplate={state.effectiveTemplate}
          ready={state.ready}
          choose={state.choose}
          start={state.start}
        />
      )}
    </section>
  );
}

/** The props of `RunningWorkflow`. */
interface RunningWorkflowProps {
  workflow: AssetWorkflow;
  updateStep(stepId: string, patch: StepPatch): Promise<boolean>;
  remove(): Promise<boolean>;
}

/**
 * The template, the progress, the steps and Remove workflow.
 *
 * @param props the workflow and its actions
 * @returns the workflow parts
 */
function RunningWorkflow({ workflow, updateStep, remove }: RunningWorkflowProps) {
  return (
    <>
      <p>
        {workflow.templateName} <span className={MUTED}>v{workflow.templateVersion}</span>{' '}
        {formatProgress(workflow.progress)}
      </p>
      {workflow.progress.total > 0 && (
        <progress aria-label={WORKFLOW_PROGRESS_LABEL} value={workflow.progress.done} max={workflow.progress.total} />
      )}
      <ul className="space-y-2">
        {workflow.steps.map((step) => (
          <StepItem key={step.id} step={step} updateStep={updateStep} />
        ))}
      </ul>
      <button type="button" className={BUTTON} title={REMOVE_WORKFLOW_TITLE} onClick={() => void remove()}>
        {REMOVE_WORKFLOW_LABEL}
      </button>
    </>
  );
}

/**
 * One step: its name, Optional, the state select and the notes. `skipped` is offered only for an
 * optional step, or for a mandatory one that already is skipped.
 *
 * @param props the step and the update
 * @returns the list entry
 */
function StepItem({ step, updateStep }: { step: Step; updateStep: RunningWorkflowProps['updateStep'] }) {
  return (
    <li className={`flex flex-wrap items-center gap-2 border-b pb-2 ${BORDER}`}>
      <span>{step.name}</span>
      {!step.mandatory && <span className={MUTED}>{OPTIONAL_STEP_LABEL}</span>}
      <select
        className={SELECT}
        aria-label={stepStateLabel(step.name)}
        value={step.state}
        onChange={(event) =>
          void updateStep(step.id, {
            state: WorkflowStepStateSchema.parse(event.target.value),
          })
        }
      >
        {WorkflowStepStateSchema.options
          .filter((state) => state !== 'skipped' || !step.mandatory || step.state === 'skipped')
          .map((state) => (
            <option key={state} value={state}>
              {label(state)}
            </option>
          ))}
      </select>
      <CommitInput
        label={notesForLabel(step.name)}
        multiline
        variant="inline"
        placeholder={NOTES_LABEL}
        className="min-w-64 flex-1"
        value={step.notes}
        maxLength={5000}
        onCommit={(notes) => updateStep(step.id, { notes })}
      />
    </li>
  );
}

/** The props of `StartWorkflow`. */
interface StartWorkflowProps {
  templates: WorkflowTemplate[];
  effectiveTemplate: string;
  /** Whether templates and asset types have settled. */
  ready: boolean;
  choose(templateId: string): void;
  start(): Promise<boolean>;
}

/**
 * The template select and Start workflow.
 *
 * @param props the templates, the effective choice and the actions
 * @returns the start row
 */
function StartWorkflow({ templates, effectiveTemplate, ready, choose, start }: StartWorkflowProps) {
  return (
    <div className="flex items-center gap-2">
      <select
        className={SELECT}
        aria-label={WORKFLOW_TEMPLATE_LABEL}
        value={effectiveTemplate}
        disabled={!ready}
        onChange={(event) => choose(event.target.value)}
      >
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
          </option>
        ))}
      </select>
      <button type="button" className={BUTTON} disabled={effectiveTemplate === ''} onClick={() => void start()}>
        {START_WORKFLOW_LABEL}
      </button>
    </div>
  );
}
