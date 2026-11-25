import {
  addRelation,
  assignAsset,
  createAsset,
  createProject,
  getAsset,
  getProject,
  getWorkflow,
  listAssets,
  listAssetTypes,
  listAssignmentsOfAsset,
  listMembersOfProject,
  listProjects,
  listRelations,
  listWorkflowTemplates,
  relocateFile,
  removeAssignment,
  removeRelation,
  removeWorkflow,
  startWorkflow,
  updateAsset,
  updateAssignment,
  updateProject,
  updateWorkflowStep,
  type WorkspaceManager,
} from '@assetforge/core';
import type { Dialogs, IpcHandlers } from './ipc.js';

// Kept free of Electron imports. Reads bypass the serial queue; every write goes through
// `exclusive` because several use cases check before they write.

export type LibraryHandlers = Pick<
  IpcHandlers,
  | 'files:import'
  | 'files:list'
  | 'files:assign'
  | 'files:unassign'
  | 'assetTypes:list'
  | 'projects:list'
  | 'projects:get'
  | 'projects:create'
  | 'projects:update'
  | 'assets:list'
  | 'assets:get'
  | 'assets:create'
  | 'assets:update'
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

export function createLibraryHandlers(
  manager: WorkspaceManager,
  dialogs: Pick<Dialogs, 'confirmRemoveWorkflow'>,
): LibraryHandlers {
  return {
    'files:import': (r) => manager.importFiles(r.sourcePaths, r.target ?? null),
    'files:list': (r) => manager.listFiles(r),
    'files:assign': (r) =>
      manager.exclusive((s) => relocateFile(s, r.fileId, { assetId: r.assetId, role: r.role })),
    'files:unassign': (r) => manager.exclusive((s) => relocateFile(s, r.fileId, null)),

    'assetTypes:list': () => manager.read((s) => listAssetTypes(s)),

    'projects:list': (r) => manager.read((s) => listProjects(s, r)),
    'projects:get': (r) => manager.read((s) => getProject(s, r.id)),
    'projects:create': (r) => manager.exclusive((s) => createProject(s, r)),
    'projects:update': (r) => manager.exclusive((s) => updateProject(s, r.id, r.patch)),

    'assets:list': (r) => manager.read((s) => listAssets(s, r)),
    'assets:get': (r) => manager.read((s) => getAsset(s, r.id)),
    'assets:create': (r) => manager.exclusive((s) => createAsset(s, r)),
    'assets:update': (r) => manager.exclusive((s) => updateAsset(s, r.id, r.patch)),

    'assignments:listByAsset': (r) => manager.read((s) => listAssignmentsOfAsset(s, r.assetId)),
    'assignments:listByProject': ({ projectId, ...page }) =>
      manager.read((s) => listMembersOfProject(s, projectId, page)),
    'assignments:assign': (r) => manager.exclusive((s) => assignAsset(s, r)),
    'assignments:update': ({ patch, ...key }) =>
      manager.exclusive((s) => updateAssignment(s, key, patch)),
    'assignments:remove': async (r) => {
      await manager.exclusive((s) => removeAssignment(s, r));
      return null;
    },

    'relations:list': (r) => manager.read((s) => listRelations(s, r.assetId)),
    'relations:add': (r) => manager.exclusive((s) => addRelation(s, r)),
    'relations:remove': async (r) => {
      await manager.exclusive((s) => removeRelation(s, r));
      return null;
    },

    'workflowTemplates:list': () => manager.read((s) => listWorkflowTemplates(s)),
    'workflows:get': (r) => manager.read((s) => getWorkflow(s, r.assetId)),
    'workflows:start': (r) => manager.exclusive((s) => startWorkflow(s, r.assetId, r.templateId)),
    'workflows:updateStep': (r) => manager.exclusive((s) => updateWorkflowStep(s, r.stepId, r.patch)),
    'workflows:remove': async (r) => {
      const { name, hasWorkflow } = await manager.read(async (s) => ({
        name: (await getAsset(s, r.assetId)).name,
        hasWorkflow: (await getWorkflow(s, r.assetId)) !== null,
      }));
      if (!hasWorkflow) return { removed: false };
      if (!(await dialogs.confirmRemoveWorkflow(name))) return { removed: false };
      return { removed: await manager.exclusive((s) => removeWorkflow(s, r.assetId)) };
    },
  };
}
