import type { AssetDetail } from '@assetforge/contracts';
import { getAssetDetail } from './asset-cover.js';
import { InvalidOperationError, NotFoundError, ValidationFailedError } from './errors.js';
import type { WorkspaceSession } from './session.js';
import { requireAsset } from './tags.js';

/** How many sources one asset can carry. */
export const MAX_ASSET_SOURCES = 50;
/** The longest source URL, before and after normalisation. */
export const MAX_SOURCE_URL_LENGTH = 2000;

/** A source of an asset, as the renderer names it. */
interface SourceRef {
  /** The asset. */
  assetId: string;
  /** The source. */
  sourceId: string;
}

/**
 * The refusal of every input that is not a usable source URL.
 *
 * @throws `ValidationFailedError` always
 */
function notAWebAddress(): never {
  throw new ValidationFailedError('This is not a web address');
}

/**
 * The one rule for a source URL: the trimmed input, at most `MAX_SOURCE_URL_LENGTH` characters before
 * and after normalisation, an `http:` or `https:` URL with a host and without user name or password.
 *
 * @param input the URL as typed or stored
 * @returns the parser's `href`, which is what is stored and compared
 * @throws `ValidationFailedError` (`validation_failed`) otherwise
 */
export function normalizeSourceUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SOURCE_URL_LENGTH) notAWebAddress();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return notAWebAddress();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') notAWebAddress();
  if (url.host === '' || url.username !== '' || url.password !== '') notAWebAddress();
  if (url.href.length > MAX_SOURCE_URL_LENGTH) notAWebAddress();
  return url.href;
}

/**
 * Adds a source URL to an asset; `updatedAt` moves.
 *
 * @param session the open workspace
 * @param request the asset and the URL as typed
 * @returns the asset's detail
 * @throws `ValidationFailedError` for a URL that fails the rule, `NotFoundError` for an unknown asset,
 *   `InvalidOperationError` for a URL the asset already has or a full list
 */
export async function addAssetSource(
  session: WorkspaceSession,
  request: { assetId: string; url: string },
): Promise<AssetDetail> {
  const url = normalizeSourceUrl(request.url);
  await requireAsset(session, request.assetId);
  if ((await session.database.assetSources.countByAsset(request.assetId)) >= MAX_ASSET_SOURCES) {
    throw new InvalidOperationError('This asset cannot take more sources');
  }
  const now = session.now().toISOString();
  const inserted = await session.database.assetSources.insert({
    id: session.newId(),
    assetId: request.assetId,
    url,
    createdAt: now,
  });
  if (!inserted) throw new InvalidOperationError('This source already exists');
  await session.database.assets.update(request.assetId, { updatedAt: now });
  return getAssetDetail(session, request.assetId);
}

/**
 * The stored URL of a source that must belong to the asset.
 *
 * @param session the open workspace
 * @param ref the asset and the source
 * @returns the stored URL
 * @throws `NotFoundError` for an unknown source or one of another asset
 */
async function requireSource(session: WorkspaceSession, ref: SourceRef): Promise<string> {
  const source = await session.database.assetSources.get(ref.sourceId);
  if (source === null || source.assetId !== ref.assetId) throw new NotFoundError('Source does not exist');
  return source.url;
}

/**
 * Removes a source of an asset; `updatedAt` moves.
 *
 * @param session the open workspace
 * @param ref the asset and the source
 * @returns the asset's detail
 * @throws `NotFoundError` for an unknown asset, an unknown source or one of another asset
 */
export async function removeAssetSource(session: WorkspaceSession, ref: SourceRef): Promise<AssetDetail> {
  await requireAsset(session, ref.assetId);
  await requireSource(session, ref);
  await session.database.assetSources.remove(ref.sourceId);
  await session.database.assets.update(ref.assetId, { updatedAt: session.now().toISOString() });
  return getAssetDetail(session, ref.assetId);
}

/**
 * The stored URL of a source of the asset, checked by the URL rule again before it is handed out.
 *
 * @param session the open workspace
 * @param ref the asset and the source
 * @returns the URL
 * @throws `NotFoundError` for an unknown source or one of another asset, `ValidationFailedError` for a stored URL
 *   that fails the rule
 */
export async function resolveAssetSourceUrl(session: WorkspaceSession, ref: SourceRef): Promise<string> {
  return normalizeSourceUrl(await requireSource(session, ref));
}
