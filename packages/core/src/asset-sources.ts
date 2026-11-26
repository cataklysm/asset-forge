import type { AssetDetail } from '@assetforge/contracts';
import { getAssetDetail } from './asset-cover.js';
import { InvalidOperationError, NotFoundError, ValidationFailedError } from './errors.js';
import type { WorkspaceSession } from './session.js';
import { requireAsset } from './tags.js';

/** How many sources one asset can carry. */
export const MAX_ASSET_SOURCES = 50;
/** The longest source URL, before and after normalisation. */
export const MAX_SOURCE_URL_LENGTH = 2000;

/**
 * The one rule for a source URL: the trimmed input, at most `MAX_SOURCE_URL_LENGTH` characters before
 * and after normalisation, an `http:` or `https:` URL with a host and without user name or password.
 * Returns the parser's `href`, which is what is stored and compared; throws `validation_failed` otherwise.
 */
export function normalizeSourceUrl(input: string): string {
  const fail = (): never => {
    throw new ValidationFailedError('This is not a web address');
  };
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SOURCE_URL_LENGTH) fail();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return fail();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail();
  if (url.host === '' || url.username !== '' || url.password !== '') fail();
  if (url.href.length > MAX_SOURCE_URL_LENGTH) fail();
  return url.href;
}

/** Adds a source URL to an asset; a URL it already has or a full list answers `invalid_operation`. */
export async function addAssetSource(
  s: WorkspaceSession,
  r: { assetId: string; url: string },
): Promise<AssetDetail> {
  const url = normalizeSourceUrl(r.url);
  await requireAsset(s, r.assetId);
  if ((await s.database.assetSources.countByAsset(r.assetId)) >= MAX_ASSET_SOURCES) {
    throw new InvalidOperationError('This asset cannot take more sources');
  }
  const now = s.now().toISOString();
  const inserted = await s.database.assetSources.insert({ id: s.newId(), assetId: r.assetId, url, createdAt: now });
  if (!inserted) throw new InvalidOperationError('This source already exists');
  await s.database.assets.update(r.assetId, { updatedAt: now });
  return getAssetDetail(s, r.assetId);
}

async function requireSource(s: WorkspaceSession, r: { assetId: string; sourceId: string }): Promise<string> {
  const source = await s.database.assetSources.get(r.sourceId);
  if (source === null || source.assetId !== r.assetId) throw new NotFoundError('Source does not exist');
  return source.url;
}

/** Removes a source of an asset; an unknown source or one of another asset answers `not_found`. */
export async function removeAssetSource(
  s: WorkspaceSession,
  r: { assetId: string; sourceId: string },
): Promise<AssetDetail> {
  await requireAsset(s, r.assetId);
  await requireSource(s, r);
  await s.database.assetSources.remove(r.sourceId);
  await s.database.assets.update(r.assetId, { updatedAt: s.now().toISOString() });
  return getAssetDetail(s, r.assetId);
}

/** The stored URL of a source of the asset, checked by the URL rule again before it is handed out. */
export async function resolveAssetSourceUrl(
  s: WorkspaceSession,
  r: { assetId: string; sourceId: string },
): Promise<string> {
  return normalizeSourceUrl(await requireSource(s, r));
}
