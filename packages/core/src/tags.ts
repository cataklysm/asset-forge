import {
  MAX_TAG_LENGTH,
  cleanTagText,
  normalizeTagName,
  normalizeTagPrefix,
  type AssetDetail,
  type FileRecord,
  type TagRenameResult,
  type TagSuggestion,
  type TagUsage,
} from '@assetforge/contracts';
import { getAssetDetail } from './asset-cover.js';
import { NotFoundError, ValidationFailedError } from './errors.js';
import { requireLiveFile } from './file-trash.js';
import { requireAsset } from './require-asset.js';
import type { WorkspaceSession } from './session.js';

/**
 * The key and the display spelling of a tag.
 *
 * @param input the tag as typed
 * @returns the normalised name and the cleaned display name
 * @throws `ValidationFailedError` for a tag without a letter or digit or a too long one
 */
export function tagName(input: string): { name: string; displayName: string } {
  const name = normalizeTagName(input);
  if (name === null) {
    throw new ValidationFailedError(`A tag needs a letter or digit and at most ${MAX_TAG_LENGTH} characters`);
  }
  return { name, displayName: cleanTagText(input) };
}

/**
 * How much the tag named by `request.name` (free text) touches.
 *
 * @param session the open workspace
 * @param request the tag as typed
 * @returns the counts; a text that is no valid tag name or an unknown tag answers `exists: false`
 */
export async function tagUsage(session: WorkspaceSession, request: { name: string }): Promise<TagUsage> {
  const name = normalizeTagName(request.name);
  if (name === null) return { exists: false, name: '', displayName: '', assets: 0, files: 0, prompts: 0 };
  const usage = await session.database.tags.usage(name);
  if (usage === null) return { exists: false, name, displayName: '', assets: 0, files: 0, prompts: 0 };
  return { exists: true, name, ...usage };
}

/**
 * Renames the tag `request.from` workspace-wide to `request.to`; onto an existing other tag only with `merge`
 * (otherwise `invalid_operation`).
 *
 * @param session the open workspace
 * @param request the source tag, the target as typed and whether a merge is allowed
 * @returns the kept tag and whether it was merged
 * @throws `NotFoundError` for an unknown `from`, `ValidationFailedError` for an invalid `to`
 */
export async function renameTag(
  session: WorkspaceSession,
  request: { from: string; to: string; merge: boolean },
): Promise<TagRenameResult> {
  const from = normalizeTagName(request.from);
  if (from === null) throw new NotFoundError('Tag does not exist');
  const tag = tagName(request.to);
  const { merged } = await session.database.tags.rename({ from, ...tag, merge: request.merge });
  return { ...tag, merged };
}

/**
 * The tags that start with a prefix.
 *
 * @param session the open workspace
 * @param request the prefix as typed and the most suggestions wanted
 * @returns the suggestions
 */
export function suggestTags(
  session: WorkspaceSession,
  request: { prefix: string; limit: number },
): Promise<TagSuggestion[]> {
  return session.database.tags.suggest({ prefix: normalizeTagPrefix(request.prefix), limit: request.limit });
}

/**
 * A file that must exist.
 *
 * @param session the open workspace
 * @param fileId the file
 * @returns its record
 * @throws `NotFoundError` otherwise
 */
async function requireFile(session: WorkspaceSession, fileId: string): Promise<FileRecord> {
  const file = await session.database.files.get(fileId);
  if (file === null) throw new NotFoundError(`File ${fileId} does not exist`);
  return file;
}

/**
 * Adds a manual tag to an asset.
 *
 * @param session the open workspace
 * @param request the asset and the tag as typed
 * @returns the asset's detail
 * @throws `ValidationFailedError` for an invalid tag, `NotFoundError` for an unknown asset
 */
export async function addAssetTag(
  session: WorkspaceSession,
  request: { assetId: string; name: string },
): Promise<AssetDetail> {
  const tag = tagName(request.name);
  await requireAsset(session, request.assetId);
  await session.database.tags.addToAsset({
    assetId: request.assetId,
    ...tag,
    origin: 'manual',
    newId: session.newId(),
    now: session.now().toISOString(),
  });
  return getAssetDetail(session, request.assetId);
}

/**
 * Removes a tag from an asset.
 *
 * @param session the open workspace
 * @param request the asset and the tag as typed
 * @returns the asset's detail
 * @throws `ValidationFailedError` for an invalid tag, `NotFoundError` for an unknown asset
 */
export async function removeAssetTag(
  session: WorkspaceSession,
  request: { assetId: string; name: string },
): Promise<AssetDetail> {
  const tag = tagName(request.name);
  await requireAsset(session, request.assetId);
  await session.database.tags.removeFromAsset({ assetId: request.assetId, name: tag.name });
  return getAssetDetail(session, request.assetId);
}

/**
 * Adds a manual tag to a complete file outside the trash.
 *
 * @param session the open workspace
 * @param request the file and the tag as typed
 * @returns the file's record
 * @throws `ValidationFailedError` for an invalid tag or an incomplete file, `NotFoundError` for an unknown file,
 *   the trash refusal for a trashed one
 */
export async function addFileTag(
  session: WorkspaceSession,
  request: { fileId: string; name: string },
): Promise<FileRecord> {
  const tag = tagName(request.name);
  const file = await requireFile(session, request.fileId);
  requireLiveFile(file);
  if (file.status !== 'complete') throw new ValidationFailedError(`File ${request.fileId} is not completely imported`);
  await session.database.tags.addToFile({
    fileId: request.fileId,
    ...tag,
    origin: 'manual',
    newId: session.newId(),
    now: session.now().toISOString(),
  });
  return requireFile(session, request.fileId);
}

/**
 * Adds one manual tag to several files, all or nothing: an unknown file fails with `not_found`
 * and a file that is not completely imported with `validation_failed`, and then no file is tagged.
 *
 * @param session the open workspace
 * @param request the files and the tag as typed
 * @returns the records in request order
 */
export async function addFileTags(
  session: WorkspaceSession,
  request: { fileIds: readonly string[]; name: string },
): Promise<FileRecord[]> {
  const tag = tagName(request.name);
  return session.database.tags.addToFiles({
    fileIds: request.fileIds,
    ...tag,
    origin: 'manual',
    newId: session.newId(),
    now: session.now().toISOString(),
  });
}

/**
 * Removes one manual tag from several files, all or nothing like `addFileTags`; an AI assignment of the tag goes too.
 *
 * @param session the open workspace
 * @param request the files and the tag as typed
 * @returns the records in request order
 */
export async function removeFileTags(
  session: WorkspaceSession,
  request: { fileIds: readonly string[]; name: string },
): Promise<FileRecord[]> {
  const tag = tagName(request.name);
  return session.database.tags.removeFromFiles({ fileIds: request.fileIds, name: tag.name });
}

/**
 * Removes a tag from a file outside the trash.
 *
 * @param session the open workspace
 * @param request the file and the tag as typed
 * @returns the file's record
 * @throws `ValidationFailedError` for an invalid tag, `NotFoundError` for an unknown file, the trash refusal for a
 *   trashed one
 */
export async function removeFileTag(
  session: WorkspaceSession,
  request: { fileId: string; name: string },
): Promise<FileRecord> {
  const tag = tagName(request.name);
  requireLiveFile(await requireFile(session, request.fileId));
  await session.database.tags.removeFromFile({ fileId: request.fileId, name: tag.name });
  return requireFile(session, request.fileId);
}
