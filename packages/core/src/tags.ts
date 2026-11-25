import {
  MAX_TAG_LENGTH,
  cleanTagText,
  normalizeTagName,
  normalizeTagPrefix,
  type AssetDetail,
  type FileRecord,
  type TagSuggestion,
} from '@assetforge/contracts';
import { getAssetDetail } from './asset-cover.js';
import { NotFoundError, ValidationFailedError } from './errors.js';
import type { WorkspaceSession } from './session.js';

/** The key and the display spelling of a tag; throws `validation_failed` for an empty or too long tag. */
export function tagName(input: string): { name: string; displayName: string } {
  const name = normalizeTagName(input);
  if (name === null) {
    throw new ValidationFailedError(`A tag must have 1 to ${MAX_TAG_LENGTH} characters`);
  }
  return { name, displayName: cleanTagText(input) };
}

export function suggestTags(
  s: WorkspaceSession,
  r: { prefix: string; limit: number },
): Promise<TagSuggestion[]> {
  return s.database.tags.suggest({ prefix: normalizeTagPrefix(r.prefix), limit: r.limit });
}

async function requireAsset(s: WorkspaceSession, assetId: string): Promise<void> {
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
  await s.database.tags.removeFromAsset({ assetId: r.assetId, name: tag.name, origin: 'manual' });
  return getAssetDetail(s, r.assetId);
}

export async function addFileTag(
  s: WorkspaceSession,
  r: { fileId: string; name: string },
): Promise<FileRecord> {
  const tag = tagName(r.name);
  const file = await requireFile(s, r.fileId);
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

export async function removeFileTag(
  s: WorkspaceSession,
  r: { fileId: string; name: string },
): Promise<FileRecord> {
  const tag = tagName(r.name);
  await requireFile(s, r.fileId);
  await s.database.tags.removeFromFile({ fileId: r.fileId, name: tag.name, origin: 'manual' });
  return requireFile(s, r.fileId);
}
