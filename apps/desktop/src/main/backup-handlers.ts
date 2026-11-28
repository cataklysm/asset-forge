import type { BackupStatus } from '@assetforge/contracts';
import {
  InvalidOperationError,
  NoWorkspaceOpenError,
  readManifest,
  type BackupFolderStatus,
  type WorkspaceManager,
} from '@assetforge/core';
import { LocalFileSystemStorage } from '@assetforge/storage';
import { BackupIdTable } from './backup-ids.js';
import { validateChosenDirectory } from './backup-location.js';
import type { Dialogs } from './host-actions.js';
import type { IpcHandlers, IpcRequest, IpcResponse } from './ipc.js';
import { RunningRestores } from './running-restores.js';

// The backup channels: listing and restoring the backups of a workspace, and the backup section of the settings for
// the open workspace. No path ever comes from the renderer; it names backups by the opaque ids of the latest listing.

/** Where the chosen backup folder of a workspace is stored. */
export interface BackupLocationStore {
  /**
   * @param id the workspace
   * @returns the chosen folder; null for the default place
   */
  backupDirectory(id: string): Promise<string | null>;
  /**
   * @param id the workspace
   * @param directory the chosen folder; null returns to the default place
   * @returns when it was written
   */
  setBackupDirectory(id: string, directory: string | null): Promise<void>;
}

/** What the host gives the backup channels. */
export interface BackupWiring {
  /** The registry holding the chosen backup folder of each workspace. */
  registry: BackupLocationStore;
  /** The app's `userData` directory, which a chosen folder must not lie in. */
  userDataPath: string;
  /** The restores in progress, aborted on quit and when the main window closes. */
  restores: RunningRestores;
  /** The opaque backup ids; a fresh table by default. */
  ids?: BackupIdTable;
}

/** What the backup channels need. */
export interface BackupHandlerDependencies {
  /** The workspace manager. */
  manager: WorkspaceManager;
  /** Picks a further folder to list and a chosen backup folder. */
  dialogs: Dialogs;
  /** Runs a restore as a lifecycle step, with the notifications around it. */
  runLifecycle: <T>(step: () => Promise<T>) => Promise<T>;
  /** The host side; without it the place of a workspace cannot be changed. */
  wiring?: BackupWiring;
}

/** The state the backup channels share. */
interface BackupHandlerState {
  /** The dependencies. */
  dependencies: BackupHandlerDependencies;
  /** The opaque backup ids. */
  ids: BackupIdTable;
  /** The restores in progress. */
  restores: RunningRestores;
}

/**
 * Builds the handlers of `workspace:backups`, `workspace:restore` and the six `backup:*` channels.
 *
 * @param dependencies the manager, the dialogs, the lifecycle and the host side
 * @returns the handlers
 */
export function createBackupHandlers(
  dependencies: BackupHandlerDependencies,
): Pick<
  IpcHandlers,
  | 'workspace:backups'
  | 'workspace:restore'
  | 'backup:state'
  | 'backup:status'
  | 'backup:changeLocation'
  | 'backup:resetLocation'
  | 'backup:now'
  | 'backup:delete'
> {
  const { manager, wiring } = dependencies;
  const state: BackupHandlerState = {
    dependencies,
    ids: wiring?.ids ?? new BackupIdTable(),
    restores: wiring?.restores ?? new RunningRestores(),
  };
  return {
    'workspace:backups': (request) => listBackups(state, request),
    'workspace:restore': (request) => restoreBackup(state, request),
    'backup:state': async () => manager.backupState(),
    'backup:status': () => backupStatus(state),
    'backup:changeLocation': () => changeLocation(state),
    'backup:resetLocation': () => resetLocation(state),
    'backup:now': () => manager.backupNow(),
    'backup:delete': (request) => deleteBackup(state, request),
  };
}

/**
 * Lists the backups of a workspace, with a further folder the user picks when asked to.
 *
 * @param state the shared state
 * @param request the workspace by id or folder, and whether to pick a further folder
 * @returns the backups with fresh ids, and whether the place could not be listed
 */
async function listBackups(
  state: BackupHandlerState,
  request: IpcRequest<'workspace:backups'>,
): Promise<IpcResponse<'workspace:backups'>> {
  const { manager, dialogs } = state.dependencies;
  const extraDirectory = request.pickFolder === true ? await dialogs.pickDirectory() : null;
  const workspace = 'id' in request ? { id: request.id } : { rootPath: request.rootPath };
  const listing = await manager.listBackups({ workspace, extraDirectory });
  return {
    backups: state.ids.issue('restore', listing.workspaceId, listing.backups),
    unreachable: listing.unreachable,
  };
}

/**
 * Restores a workspace folder from a backup of its latest listing and opens it. Quitting and closing the main window
 * abort the copy of the backup.
 *
 * @param state the shared state
 * @param request the workspace folder and the backup id
 * @returns the opened workspace
 * @throws InvalidOperationError `Load the backups again` for an id that is not of the folder's latest listing
 */
async function restoreBackup(
  state: BackupHandlerState,
  request: IpcRequest<'workspace:restore'>,
): Promise<IpcResponse<'workspace:restore'>> {
  const { manager, runLifecycle } = state.dependencies;
  const manifest = await readManifest(new LocalFileSystemStorage(request.rootPath));
  const source = state.ids.resolve('restore', manifest.id, request.backupId);
  const summary = await runLifecycle(() =>
    state.restores.run((signal) => manager.restore({ rootPath: request.rootPath, source, signal })),
  );
  state.ids.forget(manifest.id);
  return summary;
}

/**
 * The backup section of the settings for the open workspace.
 *
 * @param state the shared state
 * @returns the place, its counts and the backups of other lineages with fresh ids
 */
async function backupStatus(state: BackupHandlerState): Promise<BackupStatus> {
  const { manager } = state.dependencies;
  const status = await manager.backupStatus();
  const workspaceId = requireOpenId(manager);
  return {
    location: await displayedLocation(state, workspaceId, status),
    reachable: status.location === null ? false : status.reachable,
    running: status.running,
    last: status.last,
    count: status.count,
    totalBytes: status.totalBytes,
    otherLineages: state.ids.issue('status', workspaceId, status.otherLineages),
  };
}

/**
 * The place as the settings show it: the chosen folder, or null for the default place. A place that could not be
 * resolved shows what the registry holds.
 *
 * @param state the shared state
 * @param workspaceId the open workspace
 * @param status the status from the manager
 * @returns the kind and the displayed path
 */
async function displayedLocation(
  state: BackupHandlerState,
  workspaceId: string,
  status: BackupFolderStatus,
): Promise<BackupStatus['location']> {
  if (status.location !== null) return { kind: status.location.kind, path: status.location.chosenPath };
  const chosen = (await state.dependencies.wiring?.registry.backupDirectory(workspaceId)) ?? null;
  return chosen === null ? { kind: 'workspace', path: null } : { kind: 'chosen', path: chosen };
}

/**
 * Lets the user choose another backup folder for the open workspace, checks and stores it.
 *
 * @param state the shared state
 * @returns the new status; null when the user cancelled
 * @throws ValidationFailedError when the folder lies inside a workspace or the app data, or cannot be written
 */
async function changeLocation(state: BackupHandlerState): Promise<BackupStatus | null> {
  const { manager, dialogs } = state.dependencies;
  const wiring = requireWiring(state);
  const workspaceId = requireOpenId(manager);
  const picked = await dialogs.pickDirectory();
  if (picked === null) return null;
  const workspaceRoots = (await manager.list()).map((workspace) => workspace.rootPath);
  await validateChosenDirectory(picked, { workspaceRoots, userDataPath: wiring.userDataPath });
  await wiring.registry.setBackupDirectory(workspaceId, picked);
  return backupStatus(state);
}

/**
 * Returns the open workspace to the default backup place.
 *
 * @param state the shared state
 * @returns the new status
 */
async function resetLocation(state: BackupHandlerState): Promise<BackupStatus> {
  const wiring = requireWiring(state);
  await wiring.registry.setBackupDirectory(requireOpenId(state.dependencies.manager), null);
  return backupStatus(state);
}

/**
 * Deletes a backup of another lineage named by an id of the latest status.
 *
 * @param state the shared state
 * @param request the backup id
 * @returns the new status
 * @throws InvalidOperationError `Load the backups again` for a stale id, `This backup cannot be deleted` for a backup
 *   of the workspace's own lineage
 */
async function deleteBackup(state: BackupHandlerState, request: IpcRequest<'backup:delete'>): Promise<BackupStatus> {
  const { manager } = state.dependencies;
  const source = state.ids.resolve('status', requireOpenId(manager), request.backupId);
  await manager.deleteBackup(source);
  return backupStatus(state);
}

/**
 * The id of the open workspace.
 *
 * @param manager the workspace manager
 * @returns the id
 * @throws NoWorkspaceOpenError when none is open
 */
function requireOpenId(manager: WorkspaceManager): string {
  const open = manager.current();
  if (open === null) throw new NoWorkspaceOpenError('No workspace is open');
  return open.id;
}

/**
 * The host side of the backup channels.
 *
 * @param state the shared state
 * @returns the wiring
 * @throws InvalidOperationError when the host gave none
 */
function requireWiring(state: BackupHandlerState): BackupWiring {
  const wiring = state.dependencies.wiring;
  if (wiring === undefined) throw new InvalidOperationError('The backup folder cannot be changed');
  return wiring;
}
