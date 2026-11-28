import type { AssetWorkflow, WorkflowStepState, WorkflowTemplate } from '@assetforge/contracts';

// The workflows of a workspace: the immutable, versioned templates and the one workflow instance per asset.

/** One step of a template version as it is written. */
export interface StepDefinitionInput {
  /** The id of the step definition. */
  id: string;
  /** The place of the step within the version. */
  position: number;
  /** The stable key of the step. */
  key: string;
  /** The name shown. */
  name: string;
  /** Whether the step counts for the progress. */
  mandatory: boolean;
}

/** One version of a workflow template with its steps. */
export interface TemplateVersion {
  /** The id of the version. */
  id: string;
  /** The template it belongs to. */
  templateId: string;
  /** The version number. */
  version: number;
  /** The steps by position. */
  steps: StepDefinitionInput[];
}

/** Templates, versions and step definitions are immutable: there is no update or delete. */
export interface WorkflowTemplateRepository {
  /**
   * Every template that can be used.
   *
   * @returns the templates by name; only templates with at least one version
   */
  list(): Promise<WorkflowTemplate[]>;
  /**
   * One template.
   *
   * @param id the template
   * @returns the template; null for an unknown id and also for a template without a version
   */
  get(id: string): Promise<WorkflowTemplate | null>;
  /**
   * Finds a template by its stable key.
   *
   * @param key the key
   * @returns the template's id; null when there is none
   */
  findByKey(key: string): Promise<{ id: string } | null>;
  /**
   * Inserts a template row without a version.
   *
   * @param template the row
   */
  insertTemplate(template: {
    id: string;
    key: string;
    name: string;
    builtIn: boolean;
    createdAt: string;
  }): Promise<void>;
  /**
   * Whether a template already has a version.
   *
   * @param templateId the template
   * @param version the version number
   * @returns true when that version exists
   */
  hasVersion(templateId: string, version: number): Promise<boolean>;
  /**
   * One transaction: the version row and all its step definitions.
   *
   * @param version the version with its steps and its creation time
   */
  insertVersion(version: TemplateVersion & { createdAt: string }): Promise<void>;
  /**
   * The newest version of a template.
   *
   * @param templateId the template
   * @returns the version with the highest number; null when there is none
   */
  latestVersion(templateId: string): Promise<TemplateVersion | null>;
}

/** One step row of a new workflow instance. */
export interface NewWorkflowStep {
  /** The id of the step row. */
  id: string;
  /** The step definition of the template version. */
  stepDefinitionId: string;
  /** The step's initial updated_at. */
  updatedAt: string;
}

/** The workflow row of a new workflow instance. */
export interface NewWorkflow {
  /** The id of the workflow row. */
  id: string;
  /** The asset the workflow belongs to. */
  assetId: string;
  /** The template version the workflow follows. */
  templateVersionId: string;
  /** When the workflow started. */
  createdAt: string;
}

/** A new workflow instance: its row and one step row per step of the template version. */
export interface NewAssetWorkflow {
  /** The workflow row. */
  workflow: NewWorkflow;
  /** One entry per step of the template version. */
  steps: NewWorkflowStep[];
}

/** What a change of one step has to know about it. */
export interface StepContext {
  /** The step row. */
  stepId: string;
  /** The asset whose workflow holds the step. */
  assetId: string;
  /** Whether the step counts for the progress. */
  mandatory: boolean;
  /** The step's current state. */
  state: WorkflowStepState;
}

/** The workflow instances of assets, one per asset, with their step states and notes. */
export interface AssetWorkflowRepository {
  /**
   * One transaction: the workflow row and one step row per entry, state 'not_started', notes ''.
   *
   * @param workflow the workflow row
   * @param steps one entry per step of the template version
   */
  insert(workflow: NewWorkflow, steps: NewWorkflowStep[]): Promise<void>;
  /**
   * The workflow of an asset.
   *
   * @param assetId the asset
   * @returns the workflow with its steps; null when the asset has none
   */
  getByAsset(assetId: string): Promise<AssetWorkflow | null>;
  /**
   * What a step change has to know about the step.
   *
   * @param stepId the step row
   * @returns its asset, whether it is mandatory and its state; null for an unknown id
   */
  getStepContext(stepId: string): Promise<StepContext | null>;
  /**
   * Writes exactly the given fields; `completedAt` is not derived from `state`. An unknown step id is a no-op.
   *
   * @param stepId the step row
   * @param patch the changed fields and the new updated_at
   */
  updateStep(
    stepId: string,
    patch: { state?: WorkflowStepState; notes?: string; completedAt?: string | null; updatedAt: string },
  ): Promise<void>;
  /**
   * Deletes the workflow of an asset.
   *
   * @param assetId the asset
   * @returns false if the asset had none
   */
  remove(assetId: string): Promise<boolean>;
}
