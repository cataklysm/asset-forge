import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BACKUP_INFO_FILE } from '@assetforge/contracts';
import {
  BACKUP_TEMPORARY_PATTERN,
  BackupError,
  parseBackupName,
  type BackupFileInfo,
  type BackupLocation,
  type BackupSource,
  type DatabaseSnapshot,
  type WorkspaceBackups,
} from '@assetforge/core';
import { resolveLocation } from './backup-location.js';

/** The temporary file of one write attempt: the backup name, a uuid and `.tmp`, unique per attempt. */
const ATTEMPT_TEMPORARY_PATTERN =
  /^assetforge-[0-9a-f]{12}-\d{8}T\d{6}Z-m\d{1,4}\.sqlite\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/** Where the chosen backup folder of a workspace is stored. */
export interface BackupDirectoryStore {
  /**
   * @param id the workspace
   * @returns the chosen folder; null for the default place
   */
  backupDirectory(id: string): Promise<string | null>;
}

/** The options of `createBackupTarget`. */
export interface BackupTargetOptions {
  /** Gives the chosen folder of a workspace. */
  registry: BackupDirectoryStore;
  /**
   * The free space for a directory that may not exist yet; `statfs` of its nearest existing ancestor by default.
   *
   * @param directory the directory
   * @returns the free bytes; null when they cannot be measured
   */
  freeBytes?: (directory: string) => Promise<number | null>;
}

/** The file side of the workspace backup and the copy a restore reads a regular backup through. */
export type BackupTarget = Pick<WorkspaceBackups, 'locationOf' | 'write' | 'list' | 'remove'> & {
  /**
   * Copies a regular backup to a local file.
   *
   * @param source where the backup lies; its name must be a backup name
   * @param destinationPath the local file to write
   * @param signal aborts the copy
   * @returns resolves once the copy is complete
   */
  copyIn(source: BackupSource, destinationPath: string, signal: AbortSignal): Promise<void>;
};

/** What a write needs to know about the place it writes to. */
interface PlaceFacts {
  /** The workspace id. */
  id: string;
  /** The workspace name, written into `backup-info.json`. */
  name: string;
  /** The folder whose reachability decides `backup_location_unreachable`: the workspace root or the chosen folder. */
  anchor: string;
}

/** The state shared by the operations of one target. */
interface TargetState {
  /** The options. */
  options: BackupTargetOptions;
  /** Per backup directory resolved by `locationOf`, the facts of its place. */
  places: Map<string, PlaceFacts>;
  /** The temporary files of the attempts still running; the sweep never removes them. */
  running: Set<string>;
}

/**
 * The file side of the workspace backup: the place of a workspace, the copy of a snapshot into it, its listing and
 * the removal of one backup, and the copy of a regular backup back for a restore.
 *
 * @param options the registry of chosen folders and the free space measurement
 * @returns the operations
 */
export function createBackupTarget(options: BackupTargetOptions): BackupTarget {
  const state: TargetState = { options, places: new Map(), running: new Set() };
  return {
    locationOf: (workspace) => locationOf(state, workspace),
    write: (snapshot, location, fileName, signal) => writeBackup(state, snapshot, location, fileName, signal),
    list: (directory) => listBackups(state, directory),
    remove: (directory, name) => removeBackup(directory, name),
    copyIn: (source, destinationPath, signal) => copyIn(source, destinationPath, signal),
  };
}

/**
 * The place of a workspace; never throws for a place that is merely unreachable.
 *
 * @param state the target state
 * @param workspace the workspace's id, name and folder
 * @returns the place
 */
async function locationOf(
  state: TargetState,
  workspace: { id: string; name: string; rootPath: string },
): Promise<BackupLocation> {
  const location = resolveLocation(workspace, await state.options.registry.backupDirectory(workspace.id));
  const anchor = location.chosenPath ?? workspace.rootPath;
  state.places.set(location.directory, { id: workspace.id, name: workspace.name, anchor });
  return location;
}

/**
 * Copies a snapshot into its place through a `.tmp` file unique to this attempt and renames it once complete.
 *
 * @param state the target state
 * @param snapshot the checked snapshot
 * @param location the place
 * @param fileName the backup name
 * @param signal aborts the copy
 * @returns resolves once the backup is in place
 * @throws BackupError `backup_location_unreachable`, `backup_no_space` or `backup_failed`
 */
async function writeBackup(
  state: TargetState,
  snapshot: DatabaseSnapshot,
  location: BackupLocation,
  fileName: string,
  signal: AbortSignal,
): Promise<void> {
  const place = placeOf(state, location);
  if (parseBackupName(fileName) === null) throw new BackupError('backup_failed');
  if (!(await isReachable(place.anchor))) throw new BackupError('backup_location_unreachable');
  const free = await (state.options.freeBytes ?? nearestFreeBytes)(location.directory);
  if (free !== null && free < snapshot.sizeBytes) throw new BackupError('backup_no_space');
  const temporary = join(location.directory, `${fileName}.${randomUUID()}.tmp`);
  state.running.add(temporary);
  try {
    await mkdir(location.directory, { recursive: true });
    await sweepTemporary(state, location.directory);
    if (location.kind === 'chosen') await writeInfo(location.directory, place);
    await pipeline(createReadStream(snapshot.path), createWriteStream(temporary, { flags: 'wx' }), { signal });
    await rename(temporary, join(location.directory, fileName));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw writeFailure(error);
  } finally {
    state.running.delete(temporary);
  }
}

/**
 * The facts of a place: those `locationOf` recorded, else what the directory itself tells.
 *
 * @param state the target state
 * @param location the place
 * @returns the facts
 */
function placeOf(state: TargetState, location: BackupLocation): PlaceFacts {
  const known = state.places.get(location.directory);
  if (known !== undefined) return known;
  const id = basename(location.directory);
  return { id, name: id, anchor: location.chosenPath ?? dirname(dirname(location.directory)) };
}

/**
 * The error of a failed write: a backup error stays, a full disk is `backup_no_space`, anything else `backup_failed`.
 *
 * @param error the failure
 * @returns the backup error
 */
function writeFailure(error: unknown): BackupError {
  if (error instanceof BackupError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return new BackupError(code === 'ENOSPC' ? 'backup_no_space' : 'backup_failed', { cause: error });
}

/**
 * Removes the leftover temporary files of earlier attempts, best effort; those of running attempts stay.
 *
 * @param state the target state
 * @param directory the backup directory
 * @returns resolves once every leftover was tried; never rejects
 */
async function sweepTemporary(state: TargetState, directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(directory, name);
    if (state.running.has(path)) continue;
    if (!BACKUP_TEMPORARY_PATTERN.test(name) && !ATTEMPT_TEMPORARY_PATTERN.test(name)) continue;
    await rm(path, { force: true }).catch(() => undefined);
  }
}

/**
 * Writes `backup-info.json` of a chosen place when it is missing or tells something else.
 *
 * @param directory the backup directory
 * @param place the workspace id and name
 * @returns resolves once it is current
 */
async function writeInfo(directory: string, place: PlaceFacts): Promise<void> {
  const path = join(directory, BACKUP_INFO_FILE);
  const text = `${JSON.stringify({ v: 1, id: place.id, name: place.name }, null, 2)}\n`;
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current === text) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The regular files in a backup directory. A place that `locationOf` resolved and that does not exist yet while its
 * folder is reachable has no files.
 *
 * @param state the target state
 * @param directory the backup directory
 * @returns the files
 * @throws BackupError `backup_location_unreachable` when the directory cannot be listed
 */
async function listBackups(state: TargetState, directory: string): Promise<BackupFileInfo[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (await isMissingPlace(state, directory, error)) return [];
    throw new BackupError('backup_location_unreachable', { cause: error });
  }
  const files: BackupFileInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const facts = await stat(join(directory, entry.name));
      files.push({ name: entry.name, sizeBytes: facts.size, modifiedAt: facts.mtime.toISOString() });
    } catch {
      // A file removed between the listing and its stat is no longer there.
    }
  }
  return files;
}

/**
 * Whether a listing failed only because a known place was never written while its folder is reachable.
 *
 * @param state the target state
 * @param directory the backup directory
 * @param error the listing failure
 * @returns true when the place simply has no backups yet
 */
async function isMissingPlace(state: TargetState, directory: string, error: unknown): Promise<boolean> {
  const place = state.places.get(directory);
  if (place === undefined || (error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') return false;
  return isReachable(place.anchor);
}

/**
 * Deletes one regular backup.
 *
 * @param directory the backup directory
 * @param name the backup name
 * @returns resolves once it is gone
 * @throws BackupError `backup_failed` for a name that is not a backup name, or when the delete failed
 */
async function removeBackup(directory: string, name: string): Promise<void> {
  if (!isBackupName(name)) throw new BackupError('backup_failed');
  try {
    await rm(join(directory, name), { force: true });
  } catch (error) {
    throw new BackupError('backup_failed', { cause: error });
  }
}

/**
 * Copies a regular backup to a local file.
 *
 * @param source where the backup lies
 * @param destinationPath the local file
 * @param signal aborts the copy
 * @returns resolves once the copy is complete
 * @throws BackupError `backup_failed` for a source without a directory or a name that is not a backup name; what
 *   the copy threw otherwise
 */
async function copyIn(source: BackupSource, destinationPath: string, signal: AbortSignal): Promise<void> {
  if (source.directory === null || !isBackupName(source.name)) throw new BackupError('backup_failed');
  await pipeline(createReadStream(join(source.directory, source.name)), createWriteStream(destinationPath), {
    signal,
  });
}

/**
 * Whether a name is a backup name and nothing else (no separator, no `..`).
 *
 * @param name the name
 * @returns true when it parses and is a bare file name
 */
function isBackupName(name: string): boolean {
  return !/[\\/]/.test(name) && parseBackupName(name) !== null;
}

/**
 * Whether a folder can be reached.
 *
 * @param path the folder
 * @returns true when `stat` succeeds
 */
async function isReachable(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The free space of the nearest existing ancestor of a directory.
 *
 * @param directory the directory
 * @returns the free bytes for the user; null when no ancestor can be measured
 */
export async function nearestFreeBytes(directory: string): Promise<number | null> {
  let current = directory;
  for (;;) {
    try {
      const facts = await statfs(current);
      return Number(facts.bavail) * Number(facts.bsize);
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}
