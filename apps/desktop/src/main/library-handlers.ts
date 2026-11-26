import {
  addAssetTag,
  addFileTag,
  addFileTags,
  addRelation,
  assignAsset,
  assignFiles,
  createAsset,
  createProject,
  emptyTrash,
  getAsset,
  getAssetDetail,
  getProject,
  getWorkflow,
  InvalidOperationError,
  listAssets,
  listAssetTypes,
  listAssignmentsOfAsset,
  listMembersOfProject,
  listProjects,
  listRelations,
  listWorkflowTemplates,
  relocateFile,
  removeAssetTag,
  removeAssignment,
  removeFileTag,
  removeFileTags,
  removeRelation,
  removeWorkflow,
  measureFile,
  purgeFiles,
  resolveFilePath,
  restoreFiles,
  setAssetCover,
  startWorkflow,
  suggestTags,
  trashCount,
  trashFiles,
  type FileBatchItem,
  updateAsset,
  updateAssignment,
  updateProject,
  updateWorkflowStep,
  type WorkspaceManager,
} from '@assetforge/core';
import type { FileBatchResult, IpcChannel } from '@assetforge/contracts';
import { toIpcError, type Dialogs, type HostActions, type IpcHandlers } from './ipc.js';
import type { JobHost } from './job-host.js';

// Kept free of Electron imports. Reads bypass the serial queue; every write goes through
// `exclusive` because several use cases check before they write.

export type LibraryHandlers = Pick<
  IpcHandlers,
  | 'files:import'
  | 'files:list'
  | 'files:assign'
  | 'files:unassign'
  | 'files:assignMany'
  | 'files:trashMany'
  | 'files:restoreMany'
  | 'files:purgeMany'
  | 'trash:empty'
  | 'trash:summary'
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
  | 'assets:addTag'
  | 'assets:removeTag'
  | 'files:addTag'
  | 'files:removeTag'
  | 'files:addTagMany'
  | 'files:removeTagMany'
  | 'files:measure'
  | 'files:openExternal'
  | 'files:showInFolder'
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
  host: Pick<HostActions, 'openPath' | 'showItemInFolder'>,
  jobs: Pick<JobHost, 'cancel' | 'changed' | 'wake'>,
): LibraryHandlers {
  /** Runs a channel that may have cancelled jobs; raises the counter and wakes the scheduler even when it fails. */
  const touchingJobs = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } finally {
      jobs.changed();
      jobs.wake();
    }
  };

  return {
    'files:import': (r) => manager.importFiles(r.sourcePaths, r.target ?? null),
    'files:list': (r) => manager.listFiles(r),
    'files:assign': (r) =>
      manager.exclusive((s) => relocateFile(s, r.fileId, { assetId: r.assetId, role: r.role })),
    'files:unassign': (r) => manager.exclusive((s) => relocateFile(s, r.fileId, null)),
    'files:assignMany': async (r) => batch('files:assignMany', await manager.exclusive((s) => assignFiles(s, r))),

    // Deleting and purging cancel the jobs of a file, and a restore makes its finished jobs retryable
    // again, so the job counter goes up and the scheduler looks again afterwards, also when an item failed.
    'files:trashMany': (r) =>
      touchingJobs(async () => batch('files:trashMany', await manager.exclusive((s) => trashFiles(s, jobs, r.fileIds)))),
    'files:restoreMany': (r) =>
      touchingJobs(async () => batch('files:restoreMany', await manager.exclusive((s) => restoreFiles(s, r.fileIds)))),
    'files:purgeMany': (r) =>
      touchingJobs(async () => batch('files:purgeMany', await manager.exclusive((s) => purgeFiles(s, jobs, r.fileIds)))),
    'trash:empty': () => touchingJobs(() => manager.exclusive((s) => emptyTrash(s, jobs))),
    'trash:summary': async () => ({ count: await manager.read((s) => trashCount(s)) }),

    'assetTypes:list': () => manager.read((s) => listAssetTypes(s)),

    'projects:list': (r) => manager.read((s) => listProjects(s, r)),
    'projects:get': (r) => manager.read((s) => getProject(s, r.id)),
    'projects:create': (r) => manager.exclusive((s) => createProject(s, r)),
    'projects:update': (r) => manager.exclusive((s) => updateProject(s, r.id, r.patch)),

    'assets:list': (r) => manager.read((s) => listAssets(s, r)),
    'assets:get': (r) => manager.read((s) => getAssetDetail(s, r.id)),
    'assets:create': (r) => manager.exclusive((s) => createAsset(s, r)),
    'assets:update': (r) =>
      manager.exclusive(async (s) => {
        await updateAsset(s, r.id, r.patch);
        return getAssetDetail(s, r.id);
      }),
    // Validation and the two-step write must not interleave with a file move.
    'assets:setCover': (r) => manager.exclusive((s) => setAssetCover(s, r)),

    'tags:suggest': (r) => manager.read((s) => suggestTags(s, r)),
    'assets:addTag': (r) => manager.exclusive((s) => addAssetTag(s, r)),
    'assets:removeTag': (r) => manager.exclusive((s) => removeAssetTag(s, r)),
    'files:addTag': (r) => manager.exclusive((s) => addFileTag(s, r)),
    'files:removeTag': (r) => manager.exclusive((s) => removeFileTag(s, r)),
    'files:addTagMany': async (r) => ({ items: await manager.exclusive((s) => addFileTags(s, r)) }),
    'files:removeTagMany': async (r) => ({ items: await manager.exclusive((s) => removeFileTags(s, r)) }),

    'files:measure': (r) => manager.exclusive((s) => measureFile(s, r.fileId)),
    'files:openExternal': async (r) => {
      const path = await manager.read((s) => resolveFilePath(s, r.fileId, 'open'));
      // The shell's text may contain paths; it is never forwarded.
      if ((await host.openPath(path)) !== '') {
        throw new InvalidOperationError('No application could open this file');
      }
      return null;
    },
    'files:showInFolder': async (r) => {
      host.showItemInFolder(await manager.read((s) => resolveFilePath(s, r.fileId, 'reveal')));
      return null;
    },

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

/** Per-item results for the renderer: each error mapped like a channel error, so no cause or path leaks. */
function batch(channel: IpcChannel, items: FileBatchItem[]): FileBatchResult {
  return {
    items: items.map(({ fileId, file, error }) => ({
      fileId,
      file,
      error: error === null ? null : toIpcError(error, channel),
    })),
  };
}
