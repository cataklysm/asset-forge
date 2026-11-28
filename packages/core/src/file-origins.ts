import type { FileOrigin } from '@assetforge/contracts';
import { NotFoundError } from './errors.js';
import type { WorkspaceSession } from './session.js';
import { normalizeDownloadUrl } from './url-import.js';

/**
 * The addresses a file was downloaded from, oldest first.
 *
 * @param session the open workspace
 * @param fileId the file
 * @returns the origins
 * @throws NotFoundError for an unknown file
 */
export async function listFileOrigins(session: WorkspaceSession, fileId: string): Promise<FileOrigin[]> {
  if ((await session.database.files.get(fileId)) === null) throw new NotFoundError(`File ${fileId} does not exist`);
  return session.database.fileOrigins.listByFile(fileId);
}

/**
 * The stored URL of an origin of the file, checked by the URL rule again before it is handed out.
 *
 * @param session the open workspace
 * @param request the file and its origin
 * @returns the normalised URL
 * @throws NotFoundError for an unknown origin or one of another file, ValidationFailedError when the rule refuses it
 */
export async function resolveFileOriginUrl(
  session: WorkspaceSession,
  request: { fileId: string; originId: string },
): Promise<string> {
  const origin = await session.database.fileOrigins.get(request.originId);
  if (origin === null || origin.fileId !== request.fileId) throw new NotFoundError('Origin does not exist');
  return normalizeDownloadUrl(origin.url);
}
