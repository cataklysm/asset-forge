import type { AssetWorkflow, WorkflowProgress, WorkflowStep } from '@assetforge/contracts';
import type { AssetWorkflowRepository, NewWorkflow, NewWorkflowStep } from '@assetforge/core';
import { asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  assetWorkflow,
  assetWorkflowStep,
  workflowStepDefinition,
  workflowTemplate,
  workflowTemplateVersion,
} from './schema.js';

/** What reading a workflow needs of a transaction handle. */
type WorkflowReader = Pick<BetterSQLite3Database, 'select'>;

/** What writing a workflow needs of a transaction handle. */
export type WorkflowWriter = Pick<BetterSQLite3Database, 'insert'>;

/**
 * `done` = mandatory steps in state `done`, `total` = mandatory steps.
 *
 * @param steps the steps of a workflow
 * @returns the progress
 */
const progressOf = (steps: readonly Pick<WorkflowStep, 'mandatory' | 'state'>[]): WorkflowProgress => {
  const mandatory = steps.filter((step) => step.mandatory);
  return { done: mandatory.filter((step) => step.state === 'done').length, total: mandatory.length };
};

/**
 * The asset workflow repository over the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createAssetWorkflowRepository(database: BetterSQLite3Database): AssetWorkflowRepository {
  return {
    insert: (workflow, steps) => insertWorkflow(database, workflow, steps),
    getByAsset: (assetId) => getByAsset(database, assetId),
    getStepContext: (stepId) => getStepContext(database, stepId),
    updateStep: (stepId, patch) => updateStep(database, stepId, patch),
    remove: (assetId) => removeWorkflow(database, assetId),
  };
}

/**
 * Inserts the workflow with its steps, all `not_started`, in one transaction.
 *
 * @param database the workspace database
 * @param workflow the workflow
 * @param steps its steps
 * @returns nothing
 */
async function insertWorkflow(
  database: BetterSQLite3Database,
  workflow: NewWorkflow,
  steps: NewWorkflowStep[],
): Promise<void> {
  database.transaction((transaction) => writeWorkflow(transaction, workflow, steps));
}

/**
 * Writes the workflow row and its step rows, all `not_started`, inside the caller's transaction.
 *
 * @param transaction the open transaction
 * @param workflow the workflow
 * @param steps its steps
 */
export function writeWorkflow(transaction: WorkflowWriter, workflow: NewWorkflow, steps: NewWorkflowStep[]): void {
  transaction
    .insert(assetWorkflow)
    .values({
      id: workflow.id,
      assetId: workflow.assetId,
      templateVersionId: workflow.templateVersionId,
      createdAt: workflow.createdAt,
    })
    .run();
  for (const step of steps) {
    transaction
      .insert(assetWorkflowStep)
      .values({
        id: step.id,
        assetWorkflowId: workflow.id,
        stepDefinitionId: step.stepDefinitionId,
        state: 'not_started',
        notes: '',
        updatedAt: step.updatedAt,
        completedAt: null,
      })
      .run();
  }
}

/**
 * The asset's workflow with its template, steps and progress.
 *
 * @param database the workspace database
 * @param assetId the asset
 * @returns the workflow; null when the asset has none
 */
async function getByAsset(database: BetterSQLite3Database, assetId: string): Promise<AssetWorkflow | null> {
  return database.transaction(
    (transaction) => {
      const head = workflowHead(transaction, assetId);
      if (!head) return null;
      const steps = workflowSteps(transaction, head.id);
      return { ...head, progress: progressOf(steps), steps };
    },
    { behavior: 'deferred' },
  );
}

/**
 * The workflow row of an asset with its template's id, name and version.
 *
 * @param transaction the caller's read transaction
 * @param assetId the asset
 * @returns the head; undefined when the asset has no workflow
 */
function workflowHead(transaction: WorkflowReader, assetId: string) {
  return transaction
    .select({
      id: assetWorkflow.id,
      assetId: assetWorkflow.assetId,
      templateId: workflowTemplate.id,
      templateName: workflowTemplate.name,
      templateVersion: workflowTemplateVersion.version,
      createdAt: assetWorkflow.createdAt,
    })
    .from(assetWorkflow)
    .innerJoin(workflowTemplateVersion, eq(workflowTemplateVersion.id, assetWorkflow.templateVersionId))
    .innerJoin(workflowTemplate, eq(workflowTemplate.id, workflowTemplateVersion.templateId))
    .where(eq(assetWorkflow.assetId, assetId))
    .get();
}

/**
 * The steps of a workflow by position.
 *
 * @param transaction the caller's read transaction
 * @param workflowId the workflow
 * @returns the steps
 */
function workflowSteps(transaction: WorkflowReader, workflowId: string): WorkflowStep[] {
  return transaction
    .select({
      id: assetWorkflowStep.id,
      key: workflowStepDefinition.key,
      name: workflowStepDefinition.name,
      position: workflowStepDefinition.position,
      mandatory: workflowStepDefinition.mandatory,
      state: assetWorkflowStep.state,
      notes: assetWorkflowStep.notes,
      updatedAt: assetWorkflowStep.updatedAt,
      completedAt: assetWorkflowStep.completedAt,
    })
    .from(assetWorkflowStep)
    .innerJoin(workflowStepDefinition, eq(workflowStepDefinition.id, assetWorkflowStep.stepDefinitionId))
    .where(eq(assetWorkflowStep.assetWorkflowId, workflowId))
    .orderBy(asc(workflowStepDefinition.position))
    .all();
}

/**
 * The step with its asset, whether it is mandatory and its state.
 *
 * @param database the workspace database
 * @param stepId the step
 * @returns the context; null when unknown
 */
async function getStepContext(
  database: BetterSQLite3Database,
  stepId: string,
): ReturnType<AssetWorkflowRepository['getStepContext']> {
  return (
    database
      .select({
        stepId: assetWorkflowStep.id,
        assetId: assetWorkflow.assetId,
        mandatory: workflowStepDefinition.mandatory,
        state: assetWorkflowStep.state,
      })
      .from(assetWorkflowStep)
      .innerJoin(assetWorkflow, eq(assetWorkflow.id, assetWorkflowStep.assetWorkflowId))
      .innerJoin(workflowStepDefinition, eq(workflowStepDefinition.id, assetWorkflowStep.stepDefinitionId))
      .where(eq(assetWorkflowStep.id, stepId))
      .get() ?? null
  );
}

/**
 * Changes the given fields of the step and its update time.
 *
 * @param database the workspace database
 * @param stepId the step
 * @param patch the fields to change with the update time
 * @returns nothing
 */
async function updateStep(
  database: BetterSQLite3Database,
  stepId: string,
  patch: Parameters<AssetWorkflowRepository['updateStep']>[1],
): Promise<void> {
  const set: Partial<typeof assetWorkflowStep.$inferInsert> = { updatedAt: patch.updatedAt };
  if (patch.state !== undefined) set.state = patch.state;
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.completedAt !== undefined) set.completedAt = patch.completedAt;
  database.update(assetWorkflowStep).set(set).where(eq(assetWorkflowStep.id, stepId)).run();
}

/**
 * Deletes the asset's workflow.
 *
 * @param database the workspace database
 * @param assetId the asset
 * @returns whether a workflow was deleted
 */
async function removeWorkflow(database: BetterSQLite3Database, assetId: string): Promise<boolean> {
  // The step rows go with the workflow row (on delete cascade).
  const deleted = database.delete(assetWorkflow).where(eq(assetWorkflow.assetId, assetId)).run();
  return deleted.changes > 0;
}
