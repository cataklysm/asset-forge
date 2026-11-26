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
import type { WorkspaceSession } from './session.js';

/** The key and the display spelling of a tag; throws `validation_failed` for a tag without a letter or digit or a too long one. */
export function tagName(input: string): { name: string; displayName: string } {
  const name = normalizeTagName(input);
  if (name === null) {
    throw new ValidationFailedError(`A tag needs a letter or digit and at most ${MAX_TAG_LENGTH} characters`);
  }
  return { name, displayName: cleanTagText(input) };
}

/** How much the tag named by `r.name` (free text) touches; a text that is no valid tag name answers `exists: false`. */
export async function tagUsage(s: WorkspaceSession, r: { name: string }): Promise<TagUsage> {
  const name = normalizeTagName(r.name);
  if (name === null) return { exists: false, name: '', displayName: '', assets: 0, files: 0 };
  const usage = await s.database.tags.usage(name);
  if (usage === null) return { exists: false, name, displayName: '', assets: 0, files: 0 };
  return { exists: true, name, ...usage };
}

/**
 * Renames the tag `r.from` workspace-wide to `r.to`; onto an existing other tag only with `merge`
 * (otherwise `invalid_operation`). An unknown `from` fails with `not_found`, an invalid `to` with `validation_failed`.
 */
export async function renameTag(
  s: WorkspaceSession,
  r: { from: string; to: string; merge: boolean },
): Promise<TagRenameResult> {
  const from = normalizeTagName(r.from);
  if (from === null) throw new NotFoundError('Tag does not exist');
  const tag = tagName(r.to);
  const { merged } = await s.database.tags.rename({ from, ...tag, merge: r.merge });
  return { ...tag, merged };
}

export function suggestTags(
  s: WorkspaceSession,
  r: { prefix: string; limit: number },
): Promise<TagSuggestion[]> {
  return s.database.tags.suggest({ prefix: normalizeTagPrefix(r.prefix), limit: r.limit });
}

/** Throws `not_found` for an unknown asset. */
export async function requireAsset(s: WorkspaceSession, assetId: string): Promise<void> {
  if ((await s.database.assets.get(assetId)) === null) throw new NotFoundError(`Asset ${assetId} does not exist`);
}

async function requireFile(s: WorkspaceSession, fileId: string): Promise<FileRecord> {
  const file = await s.database.files.get(fileId);
  if (file === null) throw new NotFoundError(`File ${fileId} does not exist`);
  return file;
}

export async function addAssetTag(
  s: WorkspaceSession,
  r: { assetId: string; name: string },
): Promise<AssetDetail> {
  const tag = tagName(r.name);
  await requireAsset(s, r.assetId);
  await s.database.tags.addToAsset({
    assetId: r.assetId,
    ...tag,
    origin: 'manual',
    newId: s.newId(),
    now: s.now().toISOString(),
  });
  return getAssetDetail(s, r.assetId);
}

export async function removeAssetTag(
  s: WorkspaceSession,
  r: { assetId: string; name: string },
): Promise<AssetDetail> {
  const tag = tagName(r.name);
  await requireAsset(s, r.assetId);
  await s.database.tags.removeFromAsset({ assetId: r.assetId, name: tag.name });
  return getAssetDetail(s, r.assetId);
}

export async function addFileTag(
  s: WorkspaceSession,
  r: { fileId: string; name: string },
): Promise<FileRecord> {
  const tag = tagName(r.name);
  const file = await requireFile(s, r.fileId);
  requireLiveFile(file);
  if (file.status !== 'complete') throw new ValidationFailedError(`File ${r.fileId} is not completely imported`);
  await s.database.tags.addToFile({
    fileId: r.fileId,
    ...tag,
    origin: 'manual',
    newId: s.newId(),
    now: s.now().toISOString(),
  });
  return requireFile(s, r.fileId);
}

/**
 * Adds one manual tag to several files, all or nothing: an unknown file fails with `not_found`
 * and a file that is not completely imported with `validation_failed`, and then no file is tagged.
 * Returns the records in request order.
 */
export async function addFileTags(
  s: WorkspaceSession,
  r: { fileIds: readonly string[]; name: string },
): Promise<FileRecord[]> {
  const tag = tagName(r.name);
  return s.database.tags.addToFiles({
    fileIds: r.fileIds,
    ...tag,
    origin: 'manual',
    newId: s.newId(),
    now: s.now().toISOString(),
  });
}

/** Removes one manual tag from several files, all or nothing like `addFileTags`; an AI assignment of the tag goes too. */
export async function removeFileTags(
  s: WorkspaceSession,
  r: { fileIds: readonly string[]; name: string },
): Promise<FileRecord[]> {
  const tag = tagName(r.name);
  return s.database.tags.removeFromFiles({ fileIds: r.fileIds, name: tag.name });
}

export async function removeFileTag(
  s: WorkspaceSession,
  r: { fileId: string; name: string },
): Promise<FileRecord> {
  const tag = tagName(r.name);
  requireLiveFile(await requireFile(s, r.fileId));
  await s.database.tags.removeFromFile({ fileId: r.fileId, name: tag.name });
  return requireFile(s, r.fileId);
}
