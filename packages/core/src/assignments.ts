import type { ApprovalStatus, AssetAssignment, AssignmentPriority, ProjectAssignment, ProjectMemberList } from '@assetforge/contracts';
import { NotFoundError } from './errors.js';
import type { Page } from './ports/page.js';
import type { AssignmentKey } from './ports/project-repositories.js';
import type { WorkspaceSession } from './session.js';

async function requireProject(s: WorkspaceSession, id: string): Promise<void> {
  if ((await s.database.projects.get(id)) === null) throw new NotFoundError(`Project ${id} does not exist`);
}

async function requireAsset(s: WorkspaceSession, id: string): Promise<void> {
  if ((await s.database.assets.get(id)) === null) throw new NotFoundError(`Asset ${id} does not exist`);
}

export async function assignAsset(s: WorkspaceSession, key: AssignmentKey): Promise<ProjectAssignment> {
  await requireProject(s, key.projectId);
  await requireAsset(s, key.assetId);
  const existing = await s.database.projectAssets.get(key);
  if (existing !== null) return existing;
  const now = s.now().toISOString();
  const assignment: ProjectAssignment = {
    projectId: key.projectId,
    assetId: key.assetId,
    priority: 'normal',
    intendedUse: '',
    approvalStatus: 'pending',
    notes: '',
    assignedAt: now,
    updatedAt: now,
  };
  await s.database.projectAssets.insert(assignment);
  return assignment;
}

export async function updateAssignment(
  s: WorkspaceSession,
  key: AssignmentKey,
  patch: { priority?: AssignmentPriority; intendedUse?: string; approvalStatus?: ApprovalStatus; notes?: string },
): Promise<ProjectAssignment> {
  const updated = await s.database.projectAssets.update(key, { ...patch, updatedAt: s.now().toISOString() });
  if (updated === null) {
    throw new NotFoundError(`Asset ${key.assetId} is not assigned to project ${key.projectId}`);
  }
  return updated;
}

export async function removeAssignment(s: WorkspaceSession, key: AssignmentKey): Promise<void> {
  await s.database.projectAssets.remove(key);
}

export async function listAssignmentsOfAsset(s: WorkspaceSession, assetId: string): Promise<AssetAssignment[]> {
  await requireAsset(s, assetId);
  return s.database.projectAssets.listByAsset(assetId);
}

export async function listMembersOfProject(
  s: WorkspaceSession,
  projectId: string,
  q: Page,
): Promise<ProjectMemberList> {
  await requireProject(s, projectId);
  return s.database.projectAssets.listByProject(projectId, q);
}
