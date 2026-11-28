import {
  addAssetSource,
  addAssetTag,
  addRelation,
  assignAsset,
  createAsset,
  createProject,
  getAsset,
  getAssetDetail,
  getProject,
  getWorkflow,
  listAssets,
  listAssetTypes,
  listAssignmentsOfAsset,
  listMembersOfProject,
  listProjects,
  listRelations,
  listWorkflowTemplates,
  removeAssetSource,
  removeAssetTag,
  removeAssignment,
  removeRelation,
  removeWorkflow,
  renameTag,
  resolveAssetSourceUrl,
  setAssetCover,
  startWorkflow,
  suggestTags,
  tagUsage,
  updateAsset,
  updateAssignment,
  updateProject,
  updateWorkflowStep,
  type WorkspaceManager,
  type WorkspaceSession,
} from '@assetforge/core';
import { openStoredUrl, type Dialogs, type HostActions } from './host-actions.js';
import type { IpcHandlers, IpcRequest, IpcResponse } from './ipc.js';

// Kept free of Electron imports. Reads bypass the serial queue; every write goes through
// `exclusive` because several use cases check before they write.

/** The channels of asset types, projects, assets, tags, assignments, relations and workflows. */
export type LibraryHandlers = Pick<
  IpcHandlers,
  | 'assetTypes:list'
  | 'projects:list'
  | 'projects:get'
  | 'projects:create'
  | 'projects:update'
  | 'assets:list'
  | 'assets:get'
  | 'assets:create'
  | 'assets:update'
  | 'assets:setCover'
  | 'tags:suggest'
  | 'tags:usage'
  | 'tags:rename'
  | 'assets:addTag'
  | 'assets:removeTag'
  | 'assets:addSource'
  | 'assets:removeSource'
  | 'assets:openSource'
  | 'assignments:listByAsset'
  | 'assignments:listByProject'
  | 'assignments:assign'
  | 'assignments:update'
  | 'assignments:remove'
  | 'relations:list'
  | 'relations:add'
  | 'relations:remove'
  | 'workflowTemplates:list'
  | 'workflows:get'
  | 'workflows:start'
  | 'workflows:updateStep'
  | 'workflows:remove'
>;

/** What the library channels work with. */
export interface LibraryHandlerDependencies {
  /** The workspace manager. */
  manager: WorkspaceManager;
  /** Asks before a workflow is removed. */
  dialogs: Pick<Dialogs, 'confirmRemoveWorkflow'>;
  /** Opens a stored source address. */
  host: Pick<HostActions, 'openExternal'>;
}

/**
 * Builds the library channels.
 *
 * @param dependencies what the channels work with
 * @returns one handler per channel
 */
export function createLibraryHandlers(dependencies: LibraryHandlerDependencies): LibraryHandlers {
  const { manager } = dependencies;
  return {
    'assetTypes:list': () => manager.read((session) => listAssetTypes(session)),

    'projects:list': (request) => manager.read((session) => listProjects(session, request)),
    'projects:get': (request) => manager.read((session) => getProject(session, request.id)),
    'projects:create': (request) => manager.exclusive((session) => createProject(session, request)),
    'projects:update': (request) => manager.exclusive((session) => updateProject(session, request.id, request.patch)),

    'assets:list': (request) => manager.read((session) => listAssets(session, request)),
    'assets:get': (request) => manager.read((session) => getAssetDetail(session, request.id)),
    'assets:create': (request) => manager.exclusive((session) => createAsset(session, request)),
    'assets:update': (request) => manager.exclusive((session) => updateAndRead(session, request)),
    // Validation and the two-step write must not interleave with a file move.
    'assets:setCover': (request) => manager.exclusive((session) => setAssetCover(session, request)),

    'tags:suggest': (request) => manager.read((session) => suggestTags(session, request)),
    'tags:usage': (request) => manager.read((session) => tagUsage(session, request)),
    'tags:rename': (request) => manager.exclusive((session) => renameTag(session, request)),
    'assets:addTag': (request) => manager.exclusive((session) => addAssetTag(session, request)),
    'assets:removeTag': (request) => manager.exclusive((session) => removeAssetTag(session, request)),

    'assets:addSource': (request) => manager.exclusive((session) => addAssetSource(session, request)),
    'assets:removeSource': (request) => manager.exclusive((session) => removeAssetSource(session, request)),
    'assets:openSource': (request) => openSource(dependencies, request),

    'assignments:listByAsset': (request) => manager.read((session) => listAssignmentsOfAsset(session, request.assetId)),
    'assignments:listByProject': ({ projectId, ...page }) =>
      manager.read((session) => listMembersOfProject(session, projectId, page)),
    'assignments:assign': (request) => manager.exclusive((session) => assignAsset(session, request)),
    'assignments:update': ({ patch, ...key }) => manager.exclusive((session) => updateAssignment(session, key, patch)),
    'assignments:remove': (request) => removeAssignmentOf(manager, request),

    'relations:list': (request) => manager.read((session) => listRelations(session, request.assetId)),
    'relations:add': (request) => manager.exclusive((session) => addRelation(session, request)),
    'relations:remove': (request) => removeRelationOf(manager, request),

    'workflowTemplates:list': () => manager.read((session) => listWorkflowTemplates(session)),
    'workflows:get': (request) => manager.read((session) => getWorkflow(session, request.assetId)),
    'workflows:start': (request) =>
      manager.exclusive((session) => startWorkflow(session, request.assetId, request.templateId)),
    'workflows:updateStep': (request) =>
      manager.exclusive((session) => updateWorkflowStep(session, request.stepId, request.patch)),
    'workflows:remove': (request) => removeWorkflowOf(dependencies, request),
  };
}

/**
 * Changes an asset and reads it back in the same queue slot.
 *
 * @param session the open workspace
 * @param request the asset and the patch
 * @returns the changed asset
 */
async function updateAndRead(
  session: WorkspaceSession,
  request: IpcRequest<'assets:update'>,
): Promise<IpcResponse<'assets:update'>> {
  await updateAsset(session, request.id, request.patch);
  return getAssetDetail(session, request.id);
}

/**
 * Opens a stored source of the open workspace, checked by the URL rule again.
 *
 * @param dependencies the manager and the host
 * @param request the asset and its source
 * @returns null
 */
async function openSource(
  dependencies: LibraryHandlerDependencies,
  request: IpcRequest<'assets:openSource'>,
): Promise<IpcResponse<'assets:openSource'>> {
  const url = await dependencies.manager.read((session) => resolveAssetSourceUrl(session, request));
  await openStoredUrl(dependencies.host, url);
  return null;
}

/**
 * Removes an asset from a project.
 *
 * @param manager the workspace manager
 * @param request the assignment
 * @returns null
 */
async function removeAssignmentOf(
  manager: WorkspaceManager,
  request: IpcRequest<'assignments:remove'>,
): Promise<IpcResponse<'assignments:remove'>> {
  await manager.exclusive((session) => removeAssignment(session, request));
  return null;
}

/**
 * Removes a relation between two assets.
 *
 * @param manager the workspace manager
 * @param request the relation
 * @returns null
 */
async function removeRelationOf(
  manager: WorkspaceManager,
  request: IpcRequest<'relations:remove'>,
): Promise<IpcResponse<'relations:remove'>> {
  await manager.exclusive((session) => removeRelation(session, request));
  return null;
}

/**
 * Removes the workflow of an asset after the user agreed.
 *
 * @param dependencies the manager and the dialogs
 * @param request the asset
 * @returns whether the workflow was removed
 */
async function removeWorkflowOf(
  dependencies: LibraryHandlerDependencies,
  request: IpcRequest<'workflows:remove'>,
): Promise<IpcResponse<'workflows:remove'>> {
  const { manager, dialogs } = dependencies;
  const { name, hasWorkflow } = await manager.read((session) => workflowOfAsset(session, request.assetId));
  if (!hasWorkflow) return { removed: false };
  if (!(await dialogs.confirmRemoveWorkflow(name))) return { removed: false };
  return { removed: await manager.exclusive((session) => removeWorkflow(session, request.assetId)) };
}

/**
 * The asset's name and whether it has a workflow.
 *
 * @param session the open workspace
 * @param assetId the asset
 * @returns the name and the answer
 */
async function workflowOfAsset(
  session: WorkspaceSession,
  assetId: string,
): Promise<{ name: string; hasWorkflow: boolean }> {
  return {
    name: (await getAsset(session, assetId)).name,
    hasWorkflow: (await getWorkflow(session, assetId)) !== null,
  };
}
