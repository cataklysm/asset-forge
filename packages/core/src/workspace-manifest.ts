import path from 'node:path';
import { WORKSPACE_FORMAT_VERSION, WorkspaceManifestSchema, type WorkspaceManifest } from '@assetforge/contracts';
import { InvalidManifestError, UnsupportedFormatVersionError, WorkspaceNotFoundError } from './errors.js';
import { MANIFEST_PATH } from './paths.js';
import type { Storage } from './ports/storage.js';
import type { WorkspaceHost } from './ports/workspace-host.js';

/**
 * Roots that differ only by a trailing separator, `.` segments or (on Windows) letter
 * case name the same folder. Links or different drive mappings are not resolved here.
 */
export function isSameRoot(a: string, b: string): boolean {
  const normalize = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

export async function readManifest(storage: Storage): Promise<WorkspaceManifest> {
  const text = await storage.readText(MANIFEST_PATH);
  if (text === null) throw new WorkspaceNotFoundError('No workspace found there');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new InvalidManifestError('Workspace manifest is not valid JSON', { cause });
  }
  const parsed = WorkspaceManifestSchema.safeParse(json);
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

/** True only if `rootPath` is reachable and has a valid manifest with this id. */
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
