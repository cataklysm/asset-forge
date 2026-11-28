import type { AssetSummary, MatchedTag } from '@assetforge/contracts';
import { renameInTags, type TagRename } from '../tag-rename';

/**
 * `from` becomes the new tag in the tags that matched a tag filter; two entries collapse to one at
 * the first position, matched on the asset or on files when either was. The same array when
 * nothing changes.
 *
 * @param matched the matched tags of one asset
 * @param change the finished rename
 * @returns the renamed matched tags, or `matched` itself when nothing changes
 */
export function renameInMatched(matched: readonly MatchedTag[], change: TagRename): readonly MatchedTag[] {
  const touched = (tag: MatchedTag) => tag.name === change.from || tag.name === change.name;
  const hits = matched.filter(touched);
  if (hits.length === 0) return matched;
  const merged: MatchedTag = {
    name: change.name,
    displayName: change.displayName,
    onAsset: hits.some((tag) => tag.onAsset),
    onFiles: hits.some((tag) => tag.onFiles),
  };
  if (hits.length === 1) {
    const [hit] = hits as [MatchedTag];
    if (hit.name === merged.name && hit.displayName === merged.displayName) return matched;
    return matched.map((tag) => (tag === hit ? merged : tag));
  }
  const first = matched.findIndex(touched);
  return matched.flatMap((tag, index) => (index === first ? [merged] : touched(tag) ? [] : [tag]));
}

/**
 * Applies a rename to the asset tags, cover tags and matched tags of one asset summary.
 *
 * @param asset the summary
 * @param change the finished rename
 * @returns a copy with renamed tags, or the same summary when nothing changes
 */
export function renameInSummary(asset: AssetSummary, change: TagRename): AssetSummary {
  const tags = renameInTags(asset.tags, change);
  const coverTags = renameInTags(asset.coverTags, change);
  const matchedTags = asset.matchedTags === undefined ? undefined : renameInMatched(asset.matchedTags, change);
  if (tags === asset.tags && coverTags === asset.coverTags && matchedTags === asset.matchedTags) return asset;
  return {
    ...asset,
    tags: [...tags],
    coverTags: [...coverTags],
    ...(matchedTags !== undefined && { matchedTags: [...matchedTags] }),
  };
}
