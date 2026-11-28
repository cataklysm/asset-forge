import type { FileOrigin } from '@assetforge/contracts';
import { NotFoundError } from './errors.js';
import type { WorkspaceSession } from './session.js';
import { normalizeDownloadUrl } from './url-import.js';

/** The addresses a file was downloaded from, oldest first; an unknown file answers `not_found`. */
export async function listFileOrigins(s: WorkspaceSession, fileId: string): Promise<FileOrigin[]> {
  if ((await s.database.files.get(fileId)) === null) throw new NotFoundError(`File ${fileId} does not exist`);
  return s.database.fileOrigins.listByFile(fileId);
}

/** The stored URL of an origin of the file, checked by the URL rule again before it is handed out. */
export async function resolveFileOriginUrl(s: WorkspaceSession, r: { fileId: string; originId: string }): Promise<string> {
  const origin = await s.database.fileOrigins.get(r.originId);
  if (origin === null || origin.fileId !== r.fileId) throw new NotFoundError('Origin does not exist');
  return normalizeDownloadUrl(origin.url);
}
