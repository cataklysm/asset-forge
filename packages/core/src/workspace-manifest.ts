import path from 'node:path';
import { WORKSPACE_FORMAT_VERSION, WorkspaceManifestSchema, type WorkspaceManifest } from '@assetforge/contracts';
import { InvalidManifestError, UnsupportedFormatVersionError, WorkspaceNotFoundError } from './errors.js';
import { MANIFEST_PATH } from './paths.js';
import type { Storage } from './ports/storage.js';
import type { WorkspaceHost } from './ports/workspace-host.js';

/**
 * Whether two roots name the same folder. Roots that differ only by a trailing separator, `.` segments or (on
 * Windows) letter case name the same folder. Links or different drive mappings are not resolved here.
 *
 * @param first one root path
 * @param second the other root path
 * @returns true when both name the same folder
 */
export function isSameRoot(first: string, second: string): boolean {
  return comparableRoot(first) === comparableRoot(second);
}

/**
 * The form of a root path that `isSameRoot` compares.
 *
 * @param rootPath a root path
 * @returns the resolved path, lower-cased on Windows
 */
export function comparableRoot(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * The manifest of a new workspace.
 *
 * @param host gives the id and the creation time
 * @param name the workspace name
 * @returns the manifest in the current format version
 */
export function newManifest(host: WorkspaceHost, name: string): WorkspaceManifest {
  return {
    id: host.newId(),
    formatVersion: WORKSPACE_FORMAT_VERSION,
    name,
    createdAt: host.now().toISOString(),
  };
}

/**
 * Writes the manifest into the workspace folder as indented JSON.
 *
 * @param storage the storage of the workspace folder
 * @param manifest the manifest
 * @returns resolves once it is written
 */
export async function writeManifest(storage: Storage, manifest: WorkspaceManifest): Promise<void> {
  await storage.writeText(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Reads and checks the manifest of a workspace folder.
 *
 * @param storage the storage of the workspace folder
 * @returns the manifest
 * @throws `WorkspaceNotFoundError` without a manifest, `InvalidManifestError` for one that is not valid JSON or not
 *   a manifest, `UnsupportedFormatVersionError` for a format newer than this app supports
 */
export async function readManifest(storage: Storage): Promise<WorkspaceManifest> {
  const text = await storage.readText(MANIFEST_PATH);
  if (text === null) throw new WorkspaceNotFoundError('No workspace found there');
  const parsed = WorkspaceManifestSchema.safeParse(parseManifestJson(text));
  if (!parsed.success) {
    throw new InvalidManifestError('Workspace manifest is invalid', { cause: parsed.error });
  }
  if (parsed.data.formatVersion > WORKSPACE_FORMAT_VERSION) {
    throw new UnsupportedFormatVersionError(
      `Workspace format ${parsed.data.formatVersion} is newer than supported ${WORKSPACE_FORMAT_VERSION}`,
    );
  }
  return parsed.data;
}

/**
 * The JSON value of a manifest text.
 *
 * @param text the manifest file's text
 * @returns the parsed value
 * @throws `InvalidManifestError` when the text is not valid JSON
 */
function parseManifestJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new InvalidManifestError('Workspace manifest is not valid JSON', { cause });
  }
}

/**
 * Whether a folder still holds a workspace. Never throws.
 *
 * @param host gives the storage of the folder
 * @param rootPath the folder
 * @param id the workspace id
 * @returns true only if `rootPath` is reachable and has a valid manifest with this id
 */
export async function holdsWorkspace(host: WorkspaceHost, rootPath: string, id: string): Promise<boolean> {
  try {
    const storage = host.createStorage(rootPath);
    if (!(await storage.isReachable())) return false;
    const text = await storage.readText(MANIFEST_PATH);
    if (text === null) return false;
    const parsed = WorkspaceManifestSchema.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.id === id;
  } catch {
    return false;
  }
}
