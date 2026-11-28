import type { Asset, AssetWorkflow, WorkflowStepState } from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError } from './errors.js';
import type { NewAssetWorkflow } from './ports/workflow-repositories.js';
import { requireAsset } from './require-asset.js';
import type { WorkspaceSession } from './session.js';

/** The fields of a step a change writes. */
interface StepWrite {
  /** The new state, when it changes. */
  state?: WorkflowStepState;
  /** The new notes, when they change. */
  notes?: string;
  /** The completion time; left out to keep the stored one. */
  completedAt?: string | null;
  /** The time of the change. */
  updatedAt: string;
}

/**
 * The template a workflow starts from: the given one, else the default of the asset's type.
 *
 * @param session the open workspace
 * @param asset the asset
 * @param templateId the chosen template, if any
 * @returns the template id
 * @throws `NotFoundError` for an unknown chosen template, `InvalidOperationError` when the type has no default
 */
async function resolveTemplateId(session: WorkspaceSession, asset: Asset, templateId?: string): Promise<string> {
  if (templateId !== undefined) {
    if ((await session.database.workflowTemplates.get(templateId)) === null) {
      throw new NotFoundError(`Workflow template ${templateId} does not exist`);
    }
    return templateId;
  }
  const type = await session.database.assetTypes.get(asset.typeId);
  const defaultId = type?.defaultWorkflowTemplateId ?? null;
  if (defaultId === null) throw new InvalidOperationError('The asset type has no default workflow template');
  return defaultId;
}

/**
 * Starts a workflow from the latest version of the given template or of the asset type's default.
 *
 * @param session the open workspace
 * @param assetId the asset
 * @param templateId the chosen template, if any
 * @returns the new workflow
 * @throws `NotFoundError` for an unknown asset or template, `InvalidOperationError` when the asset already has a
 *   workflow, its type has no default or the template has no version
 */
export async function startWorkflow(
  session: WorkspaceSession,
  assetId: string,
  templateId?: string,
): Promise<AssetWorkflow> {
  const asset = await requireAsset(session, assetId);
  if ((await session.database.assetWorkflows.getByAsset(assetId)) !== null) {
    throw new InvalidOperationError(`Asset ${assetId} already has a workflow`);
  }
  const planned = await newWorkflowOf(session, asset, templateId);
  await session.database.assetWorkflows.insert(planned.workflow, planned.steps);
  return (await session.database.assetWorkflows.getByAsset(assetId))!;
}

/**
 * The rows of a new workflow of an asset, from the latest version of the given template or of the asset type's
 * default; nothing is written. The asset need not be stored yet, so `createAsset` can write both in one go.
 *
 * @param session the open workspace
 * @param asset the asset the workflow belongs to
 * @param templateId the chosen template, if any
 * @returns the workflow row and its step rows
 * @throws `NotFoundError` for an unknown template, `InvalidOperationError` when the type has no default or the
 *   template has no version
 */
export async function newWorkflowOf(
  session: WorkspaceSession,
  asset: Asset,
  templateId?: string,
): Promise<NewAssetWorkflow> {
  const resolvedId = await resolveTemplateId(session, asset, templateId);
  const version = await session.database.workflowTemplates.latestVersion(resolvedId);
  if (version === null) throw new InvalidOperationError(`Workflow template ${resolvedId} has no version`);

  const now = session.now().toISOString();
  return {
    workflow: { id: session.newId(), assetId: asset.id, templateVersionId: version.id, createdAt: now },
    steps: version.steps.map((step) => ({ id: session.newId(), stepDefinitionId: step.id, updatedAt: now })),
  };
}

/**
 * The workflow of an asset.
 *
 * @param session the open workspace
 * @param assetId the asset
 * @returns it; null when the asset has none
 * @throws `NotFoundError` for an unknown asset
 */
export async function getWorkflow(session: WorkspaceSession, assetId: string): Promise<AssetWorkflow | null> {
  await requireAsset(session, assetId);
  return session.database.assetWorkflows.getByAsset(assetId);
}

/**
 * The only way a step state changes.
 *
 * @param session the open workspace
 * @param stepId the step
 * @param patch the new state and/or notes
 * @returns the whole workflow
 * @throws `NotFoundError` for an unknown step, `InvalidOperationError` for skipping a mandatory step
 */
export async function updateWorkflowStep(
  session: WorkspaceSession,
  stepId: string,
  patch: { state?: WorkflowStepState; notes?: string },
): Promise<AssetWorkflow> {
  const context = await session.database.assetWorkflows.getStepContext(stepId);
  if (context === null) throw new NotFoundError(`Workflow step ${stepId} does not exist`);
  if (patch.state === 'skipped' && context.mandatory) {
    throw new InvalidOperationError('A mandatory step cannot be skipped');
  }
  const now = session.now().toISOString();
  await session.database.assetWorkflows.updateStep(stepId, stepWrite(patch, context.state, now));
  return (await session.database.assetWorkflows.getByAsset(context.assetId))!;
}

/**
 * The fields a step change writes.
 *
 * @param patch the new state and/or notes
 * @param previous the stored state of the step
 * @param now the time of the change
 * @returns the write
 */
function stepWrite(
  patch: { state?: WorkflowStepState; notes?: string },
  previous: WorkflowStepState,
  now: string,
): StepWrite {
  const write: StepWrite = { updatedAt: now };
  if (patch.notes !== undefined) write.notes = patch.notes;
  if (patch.state !== undefined) {
    write.state = patch.state;
    // Staying `done` keeps the original completion time, so `completedAt` is left out of the write.
    if (patch.state !== 'done') write.completedAt = null;
    else if (previous !== 'done') write.completedAt = now;
  }
  return write;
}

/**
 * Removes the workflow of an asset.
 *
 * @param session the open workspace
 * @param assetId the asset
 * @returns whether there was one
 * @throws `NotFoundError` for an unknown asset
 */
export async function removeWorkflow(session: WorkspaceSession, assetId: string): Promise<boolean> {
  await requireAsset(session, assetId);
  return session.database.assetWorkflows.remove(assetId);
}
