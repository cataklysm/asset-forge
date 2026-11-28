import { randomUUID } from 'node:crypto';
import { realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import {
  BACKUP_FOLDER_NAME,
  LOCATION_IN_APP_DATA_MESSAGE,
  LOCATION_IN_WORKSPACE_MESSAGE,
  LOCATION_NOT_WRITABLE_MESSAGE,
} from '@assetforge/contracts';
import { BackupError, ValidationFailedError, type BackupLocation } from '@assetforge/core';

/** What a chosen backup folder is checked against. */
export interface LocationContext {
  /** The root folder of every registered workspace, the own one included. */
  workspaceRoots: readonly string[];
  /** The app data folder (Electron `userData`). */
  userDataPath: string;
}

/**
 * The place the backups of a workspace go to.
 *
 * @param workspace the workspace id and root folder
 * @param chosen the folder the user chose; null for the default place in the workspace folder
 * @returns `<root>/.assetforge/backups`, or `<chosen>/assetforge-backups/<id>`
 */
export function resolveLocation(workspace: { id: string; rootPath: string }, chosen: string | null): BackupLocation {
  if (chosen === null) {
    return { kind: 'workspace', directory: join(workspace.rootPath, '.assetforge', 'backups'), chosenPath: null };
  }
  return { kind: 'chosen', directory: join(chosen, BACKUP_FOLDER_NAME, workspace.id), chosenPath: chosen };
}

/**
 * Checks a folder the user picked as the backup place: it must exist, lie outside every workspace folder and outside
 * the app data, and be writable. Links and junctions are resolved first.
 *
 * @param candidate the picked folder
 * @param context the workspace roots and the app data folder
 * @returns resolves when the folder may be used
 * @throws ValidationFailedError with a fixed location message when it may not
 */
export async function validateChosenDirectory(candidate: string, context: LocationContext): Promise<void> {
  const resolved = await realpathOrNull(candidate);
  if (resolved === null) throw new ValidationFailedError(LOCATION_NOT_WRITABLE_MESSAGE);
  for (const root of context.workspaceRoots) {
    if (isSameOrInside(resolved, await realpathOrSelf(root))) {
      throw new ValidationFailedError(LOCATION_IN_WORKSPACE_MESSAGE);
    }
  }
  if (isSameOrInside(resolved, await realpathOrSelf(context.userDataPath))) {
    throw new ValidationFailedError(LOCATION_IN_APP_DATA_MESSAGE);
  }
  await probeWritable(resolved);
}

/**
 * Checks the backup directory itself right before it is written to or deleted from: folders below a chosen folder
 * (or the default place) may be links or junctions too. Resolved, it must lie outside every workspace folder and the
 * app data; the default place may lie in the folder of its own workspace (and in a folder holding that one).
 *
 * @param directory the backup directory; it must exist
 * @param ownRoot the root folder of the workspace for the default place; null for a chosen place
 * @param context the workspace roots and the app data folder
 * @returns resolves when the directory may be used
 * @throws BackupError `backup_location_unreachable` when it cannot be resolved or leads into a forbidden folder
 */
export async function requireSafeBackupDirectory(
  directory: string,
  ownRoot: string | null,
  context: LocationContext,
): Promise<void> {
  const resolved = await realpathOrNull(directory);
  if (resolved === null) throw new BackupError('backup_location_unreachable');
  const own = ownRoot === null ? null : await realpathOrSelf(ownRoot);
  for (const root of context.workspaceRoots) {
    const real = await realpathOrSelf(root);
    if (own !== null && isSameOrInside(own, real)) continue;
    if (isSameOrInside(resolved, real)) throw new BackupError('backup_location_unreachable');
  }
  if (isSameOrInside(resolved, await realpathOrSelf(context.userDataPath))) {
    throw new BackupError('backup_location_unreachable');
  }
}

/**
 * Whether a path is a folder itself or lies inside it, compared by path segments; case-insensitive on Windows.
 *
 * @param path the resolved path
 * @param folder the resolved folder
 * @returns true when `path` is `folder` or below it
 */
export function isSameOrInside(path: string, folder: string): boolean {
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const between = relative(fold(folder), fold(path));
  if (between === '') return true;
  return !isAbsolute(between) && between !== '..' && !between.startsWith(`..${pathSeparator()}`);
}

/**
 * The separator `path.relative` writes on this platform.
 *
 * @returns `\` on Windows, `/` elsewhere
 */
function pathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

/**
 * The resolved path, or null when it cannot be resolved.
 *
 * @param path the path
 * @returns the real path, or null
 */
async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * The resolved path, or the path itself when it cannot be resolved (a root that is offline still counts).
 *
 * @param path the path
 * @returns the real path, or the path
 */
async function realpathOrSelf(path: string): Promise<string> {
  return (await realpathOrNull(path)) ?? path;
}

/**
 * Writes and removes a probe file.
 *
 * @param folder the resolved folder
 * @returns resolves when both worked
 * @throws ValidationFailedError with `LOCATION_NOT_WRITABLE_MESSAGE` when either failed
 */
async function probeWritable(folder: string): Promise<void> {
  const probe = join(folder, `.assetforge-probe-${randomUUID()}`);
  try {
    await writeFile(probe, '', { flag: 'wx' });
    await rm(probe);
  } catch (error) {
    await rm(probe, { force: true }).catch(() => undefined);
    throw new ValidationFailedError(LOCATION_NOT_WRITABLE_MESSAGE, { cause: error });
  }
}
