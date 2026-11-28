import type { AssetWorkflow, WorkflowStepState, WorkflowTemplate } from '@assetforge/contracts';

export interface StepDefinitionInput {
  id: string;
  position: number;
  key: string;
  name: string;
  mandatory: boolean;
}

export interface TemplateVersion {
  id: string;
  templateId: string;
  version: number;
  steps: StepDefinitionInput[]; // by position
}

/** Templates, versions and step definitions are immutable: there is no update or delete. */
export interface WorkflowTemplateRepository {
  list(): Promise<WorkflowTemplate[]>; // by name; only templates with at least one version
  get(id: string): Promise<WorkflowTemplate | null>; // null also for a template without a version
  findByKey(key: string): Promise<{ id: string } | null>;
  insertTemplate(t: { id: string; key: string; name: string; builtIn: boolean; createdAt: string }): Promise<void>;
  hasVersion(templateId: string, version: number): Promise<boolean>;
  /** One transaction: the version row and all its step definitions. */
  insertVersion(v: TemplateVersion & { createdAt: string }): Promise<void>;
  latestVersion(templateId: string): Promise<TemplateVersion | null>;
}

export interface NewWorkflowStep {
  id: string;
  stepDefinitionId: string;
  updatedAt: string;
}

export interface StepContext {
  stepId: string;
  assetId: string;
  mandatory: boolean;
  state: WorkflowStepState;
}

export interface AssetWorkflowRepository {
  /** One transaction: the workflow row and one step row per entry, state 'not_started', notes ''. */
  insert(
    w: { id: string; assetId: string; templateVersionId: string; createdAt: string },
    steps: NewWorkflowStep[],
  ): Promise<void>;
  getByAsset(assetId: string): Promise<AssetWorkflow | null>;
  getStepContext(stepId: string): Promise<StepContext | null>;
  /** Writes exactly the given fields; `completedAt` is not derived from `state`. An unknown step id is a no-op. */
  updateStep(
    stepId: string,
    patch: { state?: WorkflowStepState; notes?: string; completedAt?: string | null; updatedAt: string },
  ): Promise<void>;
  remove(assetId: string): Promise<boolean>; // false if the asset had none
}
