import type {
  ApprovalStatus,
  AssetAssignment,
  AssignmentPriority,
  ProjectAssignment,
  ProjectMemberList,
} from '@assetforge/contracts';
import { NotFoundError } from './errors.js';
import type { Page } from './ports/page.js';
import type { AssignmentKey } from './ports/project-repositories.js';
import type { WorkspaceSession } from './session.js';

/**
 * Refuses an unknown project.
 *
 * @param session the open workspace
 * @param id the project
 * @returns resolves when it exists
 * @throws `NotFoundError` otherwise
 */
async function requireProject(session: WorkspaceSession, id: string): Promise<void> {
  if ((await session.database.projects.get(id)) === null) throw new NotFoundError(`Project ${id} does not exist`);
}

/**
 * Refuses an unknown asset.
 *
 * @param session the open workspace
 * @param id the asset
 * @returns resolves when it exists
 * @throws `NotFoundError` otherwise
 */
async function requireAsset(session: WorkspaceSession, id: string): Promise<void> {
  if ((await session.database.assets.get(id)) === null) throw new NotFoundError(`Asset ${id} does not exist`);
}

/**
 * Assigns an asset to a project with the default project data; an existing assignment is returned unchanged.
 *
 * @param session the open workspace
 * @param key the project and the asset
 * @returns the assignment
 * @throws `NotFoundError` for an unknown project or asset
 */
export async function assignAsset(session: WorkspaceSession, key: AssignmentKey): Promise<ProjectAssignment> {
  await requireProject(session, key.projectId);
  await requireAsset(session, key.assetId);
  const existing = await session.database.projectAssets.get(key);
  if (existing !== null) return existing;
  const now = session.now().toISOString();
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
  await session.database.projectAssets.insert(assignment);
  return assignment;
}

/**
 * Changes the project data of an assignment; `updatedAt` moves.
 *
 * @param session the open workspace
 * @param key the project and the asset
 * @param patch the fields to change
 * @returns the changed assignment
 * @throws `NotFoundError` when the asset is not assigned to the project
 */
export async function updateAssignment(
  session: WorkspaceSession,
  key: AssignmentKey,
  patch: { priority?: AssignmentPriority; intendedUse?: string; approvalStatus?: ApprovalStatus; notes?: string },
): Promise<ProjectAssignment> {
  const now = session.now().toISOString();
  const updated = await session.database.projectAssets.update(key, { ...patch, updatedAt: now });
  if (updated === null) {
    throw new NotFoundError(`Asset ${key.assetId} is not assigned to project ${key.projectId}`);
  }
  return updated;
}

/**
 * Removes an assignment; the asset and its files stay. A missing assignment is no error.
 *
 * @param session the open workspace
 * @param key the project and the asset
 * @returns resolves once it is gone
 */
export async function removeAssignment(session: WorkspaceSession, key: AssignmentKey): Promise<void> {
  await session.database.projectAssets.remove(key);
}

/**
 * The projects an asset is assigned to.
 *
 * @param session the open workspace
 * @param assetId the asset
 * @returns its assignments
 * @throws `NotFoundError` for an unknown asset
 */
export async function listAssignmentsOfAsset(session: WorkspaceSession, assetId: string): Promise<AssetAssignment[]> {
  await requireAsset(session, assetId);
  return session.database.projectAssets.listByAsset(assetId);
}

/**
 * One page of the assets assigned to a project.
 *
 * @param session the open workspace
 * @param projectId the project
 * @param page the page
 * @returns the members
 * @throws `NotFoundError` for an unknown project
 */
export async function listMembersOfProject(
  session: WorkspaceSession,
  projectId: string,
  page: Page,
): Promise<ProjectMemberList> {
  await requireProject(session, projectId);
  return session.database.projectAssets.listByProject(projectId, page);
}
