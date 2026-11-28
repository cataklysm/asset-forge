import {
  addFileTag,
  addFileTags,
  assignFiles,
  emptyTrash,
  enqueueUrlImport,
  InvalidOperationError,
  listFileOrigins,
  purgeFiles,
  relocateFile,
  removeFileTag,
  removeFileTags,
  resolveFileOriginUrl,
  resolveFilePath,
  restoreFiles,
  trashCount,
  trashFiles,
  type FileBatchItem,
  type WorkspaceManager,
} from '@assetforge/core';
import type { FileBatchResult, IpcChannel } from '@assetforge/contracts';
import { openStoredUrl, type HostActions } from './host-actions.js';
import { toIpcError, type IpcHandlers, type IpcRequest, type IpcResponse } from './ipc.js';
import type { JobHost } from './job-host.js';

// Kept free of Electron imports. Reads bypass the serial queue; every write goes through
// `exclusive` because several use cases check before they write.

/** The `files:*` and `trash:*` channels. */
export type FileHandlers = Pick<
  IpcHandlers,
  | 'files:import'
  | 'files:importProgress'
  | 'files:cancelImport'
  | 'files:importUrls'
  | 'files:origins'
  | 'files:openOrigin'
  | 'files:list'
  | 'files:assign'
  | 'files:unassign'
  | 'files:assignMany'
  | 'files:trashMany'
  | 'files:restoreMany'
  | 'files:purgeMany'
  | 'trash:empty'
  | 'trash:summary'
  | 'files:addTag'
  | 'files:removeTag'
  | 'files:addTagMany'
  | 'files:removeTagMany'
  | 'files:measure'
  | 'files:openExternal'
  | 'files:showInFolder'
>;

/** What the file channels work with. */
export interface FileHandlerDependencies {
  /** The workspace manager. */
  manager: WorkspaceManager;
  /** Opens files, folders and stored addresses. */
  host: Pick<HostActions, 'openPath' | 'showItemInFolder' | 'openExternal'>;
  /** Cancels the jobs of deleted files and learns about job rows changed here. */
  jobs: Pick<JobHost, 'cancel' | 'cancelAll' | 'changed' | 'wake'>;
}

/**
 * Builds the `files:*` and `trash:*` channels.
 *
 * @param dependencies what the channels work with
 * @returns one handler per channel
 */
export function createFileHandlers(dependencies: FileHandlerDependencies): FileHandlers {
  const { manager, jobs } = dependencies;
  return {
    'files:import': (request) =>
      manager.importFiles(request.sourcePaths, request.target ?? null, { unpackArchives: request.unpackArchives }),
    // Both read or mark the running import without the queue, which that import holds; neither needs a workspace.
    'files:importProgress': async () => manager.importProgress(),
    'files:cancelImport': async () => ({ cancelling: manager.cancelImport() }),
    'files:importUrls': (request) => importUrls(dependencies, request),
    'files:origins': (request) => manager.read((session) => listFileOrigins(session, request.fileId)),
    'files:openOrigin': (request) => openOrigin(dependencies, request),
    'files:list': (request) => manager.listFiles(request),
    'files:assign': (request) =>
      manager.exclusive((session) =>
        relocateFile(session, request.fileId, { assetId: request.assetId, role: request.role }),
      ),
    'files:unassign': (request) => manager.exclusive((session) => relocateFile(session, request.fileId, null)),
    'files:assignMany': (request) => assignMany(manager, request),

    // Deleting and purging cancel the jobs of a file, and a restore makes its finished jobs retryable
    // again, so the job counter goes up and the scheduler looks again afterwards, also when an item failed.
    'files:trashMany': (request) => touchingJobs(jobs, () => trashMany(dependencies, request)),
    'files:restoreMany': (request) => touchingJobs(jobs, () => restoreMany(manager, request)),
    'files:purgeMany': (request) => touchingJobs(jobs, () => purgeMany(dependencies, request)),
    'trash:empty': () => touchingJobs(jobs, () => manager.exclusive((session) => emptyTrash(session, jobs))),
    'trash:summary': async () => ({ count: await manager.read((session) => trashCount(session)) }),

    'files:addTag': (request) => manager.exclusive((session) => addFileTag(session, request)),
    'files:removeTag': (request) => manager.exclusive((session) => removeFileTag(session, request)),
    'files:addTagMany': async (request) => ({
      items: await manager.exclusive((session) => addFileTags(session, request)),
    }),
    'files:removeTagMany': async (request) => ({
      items: await manager.exclusive((session) => removeFileTags(session, request)),
    }),

    // The probe runs outside the workspace queue; only storing its result is queued.
    'files:measure': (request) => manager.measureFile(request.fileId),
    'files:openExternal': (request) => openExternally(dependencies, request),
    'files:showInFolder': (request) => showInFolder(dependencies, request),
  };
}

/**
 * Runs a channel that may have cancelled jobs; raises the counter and wakes the scheduler even when it fails.
 *
 * @param jobs the job host
 * @param run the channel's work
 * @returns what the work answered
 */
async function touchingJobs<T>(jobs: Pick<JobHost, 'changed' | 'wake'>, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } finally {
    jobs.changed();
    jobs.wake();
  }
}

/**
 * Queues one download per URL. Only the enqueue runs in the serial queue; the downloads are jobs and never hold it.
 *
 * @param dependencies the manager and the job host
 * @param request the URLs and the target
 * @returns the queued, already imported and invalid entries
 */
async function importUrls(
  dependencies: FileHandlerDependencies,
  request: IpcRequest<'files:importUrls'>,
): Promise<IpcResponse<'files:importUrls'>> {
  const { manager, jobs } = dependencies;
  const result = await manager.exclusive((session) =>
    enqueueUrlImport(session, {
      urls: request.urls,
      target: request.target ?? null,
      skipDuplicates: request.skipDuplicates ?? true,
    }),
  );
  jobs.changed();
  jobs.wake();
  return result;
}

/**
 * Opens a stored origin of the file, checked by the URL rule again; the renderer never sends an address.
 *
 * @param dependencies the manager and the host
 * @param request the file and its origin
 * @returns an empty answer
 */
async function openOrigin(
  dependencies: FileHandlerDependencies,
  request: IpcRequest<'files:openOrigin'>,
): Promise<IpcResponse<'files:openOrigin'>> {
  const url = await dependencies.manager.read((session) => resolveFileOriginUrl(session, request));
  await openStoredUrl(dependencies.host, url);
  return {};
}

/**
 * Assigns several files, one result per item.
 *
 * @param manager the workspace manager
 * @param request the files and the place
 * @returns the per-item results
 */
async function assignMany(
  manager: WorkspaceManager,
  request: IpcRequest<'files:assignMany'>,
): Promise<IpcResponse<'files:assignMany'>> {
  return batch('files:assignMany', await manager.exclusive((session) => assignFiles(session, request)));
}

/**
 * Moves several files into the trash, one result per item.
 *
 * @param dependencies the manager and the job host
 * @param request the files
 * @returns the per-item results
 */
async function trashMany(
  dependencies: FileHandlerDependencies,
  request: IpcRequest<'files:trashMany'>,
): Promise<IpcResponse<'files:trashMany'>> {
  const { manager, jobs } = dependencies;
  return batch('files:trashMany', await manager.exclusive((session) => trashFiles(session, jobs, request.fileIds)));
}

/**
 * Restores several files from the trash, one result per item.
 *
 * @param manager the workspace manager
 * @param request the files
 * @returns the per-item results
 */
async function restoreMany(
  manager: WorkspaceManager,
  request: IpcRequest<'files:restoreMany'>,
): Promise<IpcResponse<'files:restoreMany'>> {
  return batch('files:restoreMany', await manager.exclusive((session) => restoreFiles(session, request.fileIds)));
}

/**
 * Deletes several trashed files permanently, one result per item.
 *
 * @param dependencies the manager and the job host
 * @param request the files
 * @returns the per-item results
 */
async function purgeMany(
  dependencies: FileHandlerDependencies,
  request: IpcRequest<'files:purgeMany'>,
): Promise<IpcResponse<'files:purgeMany'>> {
  const { manager, jobs } = dependencies;
  return batch('files:purgeMany', await manager.exclusive((session) => purgeFiles(session, jobs, request.fileIds)));
}

/**
 * Opens the file in the application the system assigns to it.
 *
 * @param dependencies the manager and the host
 * @param request the file
 * @returns null
 * @throws InvalidOperationError with a fixed message when no application could open it
 */
async function openExternally(
  dependencies: FileHandlerDependencies,
  request: IpcRequest<'files:openExternal'>,
): Promise<IpcResponse<'files:openExternal'>> {
  const path = await dependencies.manager.read((session) => resolveFilePath(session, request.fileId, 'open'));
  // The shell's text may contain paths; it is never forwarded.
  if ((await dependencies.host.openPath(path)) !== '') {
    throw new InvalidOperationError('No application could open this file');
  }
  return null;
}

/**
 * Shows the file in the system's file manager.
 *
 * @param dependencies the manager and the host
 * @param request the file
 * @returns null
 */
async function showInFolder(
  dependencies: FileHandlerDependencies,
  request: IpcRequest<'files:showInFolder'>,
): Promise<IpcResponse<'files:showInFolder'>> {
  dependencies.host.showItemInFolder(
    await dependencies.manager.read((session) => resolveFilePath(session, request.fileId, 'reveal')),
  );
  return null;
}

/**
 * Per-item results for the renderer: each error mapped like a channel error, so no cause or path leaks.
 *
 * @param channel the channel, named in the log line of an unexpected error
 * @param items the per-item results of the use case
 * @returns the answer
 */
function batch(channel: IpcChannel, items: FileBatchItem[]): FileBatchResult {
  return {
    items: items.map(({ fileId, file, error }) => ({
      fileId,
      file,
      error: error === null ? null : toIpcError(error, channel),
    })),
  };
}
