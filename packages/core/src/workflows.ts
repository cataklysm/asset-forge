import type { Asset, AssetWorkflow, WorkflowStepState } from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError } from './errors.js';
import type { WorkspaceSession } from './session.js';

async function requireAsset(s: WorkspaceSession, assetId: string): Promise<Asset> {
  const asset = await s.database.assets.get(assetId);
  if (asset === null) throw new NotFoundError(`Asset ${assetId} does not exist`);
  return asset;
}

async function resolveTemplateId(s: WorkspaceSession, asset: Asset, templateId?: string): Promise<string> {
  if (templateId !== undefined) {
    if ((await s.database.workflowTemplates.get(templateId)) === null) {
      throw new NotFoundError(`Workflow template ${templateId} does not exist`);
    }
    return templateId;
  }
  const type = await s.database.assetTypes.get(asset.typeId);
  const defaultId = type?.defaultWorkflowTemplateId ?? null;
  if (defaultId === null) throw new InvalidOperationError('The asset type has no default workflow template');
  return defaultId;
}

/** Starts a workflow from the latest version of the given template or of the asset type's default. */
export async function startWorkflow(s: WorkspaceSession, assetId: string, templateId?: string): Promise<AssetWorkflow> {
  const asset = await requireAsset(s, assetId);
  if ((await s.database.assetWorkflows.getByAsset(assetId)) !== null) {
    throw new InvalidOperationError(`Asset ${assetId} already has a workflow`);
  }
  const resolvedId = await resolveTemplateId(s, asset, templateId);
  const version = await s.database.workflowTemplates.latestVersion(resolvedId);
  if (version === null) throw new InvalidOperationError(`Workflow template ${resolvedId} has no version`);

  const now = s.now().toISOString();
  await s.database.assetWorkflows.insert(
    { id: s.newId(), assetId, templateVersionId: version.id, createdAt: now },
    version.steps.map((step) => ({ id: s.newId(), stepDefinitionId: step.id, updatedAt: now })),
  );
  return (await s.database.assetWorkflows.getByAsset(assetId))!;
}

export async function getWorkflow(s: WorkspaceSession, assetId: string): Promise<AssetWorkflow | null> {
  await requireAsset(s, assetId);
  return s.database.assetWorkflows.getByAsset(assetId);
}

/** The only way a step state changes; returns the whole workflow. */
export async function updateWorkflowStep(
  s: WorkspaceSession,
  stepId: string,
  patch: { state?: WorkflowStepState; notes?: string },
): Promise<AssetWorkflow> {
  const context = await s.database.assetWorkflows.getStepContext(stepId);
  if (context === null) throw new NotFoundError(`Workflow step ${stepId} does not exist`);
  if (patch.state === 'skipped' && context.mandatory) {
    throw new InvalidOperationError('A mandatory step cannot be skipped');
  }

  const now = s.now().toISOString();
  const write: { state?: WorkflowStepState; notes?: string; completedAt?: string | null; updatedAt: string } = {
    updatedAt: now,
  };
  if (patch.notes !== undefined) write.notes = patch.notes;
  if (patch.state !== undefined) {
    write.state = patch.state;
    // Staying `done` keeps the original completion time, so `completedAt` is left out of the write.
    if (patch.state !== 'done') write.completedAt = null;
    else if (context.state !== 'done') write.completedAt = now;
  }
  await s.database.assetWorkflows.updateStep(stepId, write);
  return (await s.database.assetWorkflows.getByAsset(context.assetId))!;
}

export async function removeWorkflow(s: WorkspaceSession, assetId: string): Promise<boolean> {
  await requireAsset(s, assetId);
  return s.database.assetWorkflows.remove(assetId);
}
