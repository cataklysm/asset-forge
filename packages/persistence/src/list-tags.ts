import type { MatchedTag, TagAssignment, TagOrigin } from '@assetforge/contracts';
import { sql, type SQL } from 'drizzle-orm';
import { qualified } from './qualified.js';
import { assetTag, file, fileTag, tag } from './schema.js';
import type { IndexTransaction } from './search-index.js';

/** `(?, ?, ...)` for an `in` list; SQLite accepts the empty list `()`. */
const inList = (values: readonly string[]): SQL => sql`(${sql.join(
  values.map((v) => sql`${v}`),
  sql`, `,
)})`;

const tagId = qualified(tag, tag.id);
const tagName = qualified(tag, tag.name);
const tagDisplayName = qualified(tag, tag.displayName);

/**
 * The tags of the given assets and of the given files in one statement, ordered by name, then
 * origin. `kind` says which owner `owner` is. Exported for the query plan test; callers use
 * `assetTagsOf`.
 */
export function assetTagsSql(assetIds: readonly string[], fileIds: readonly string[]): SQL {
  return sql`select 'asset' as kind, ${qualified(assetTag, assetTag.assetId)} as owner, ${tagName} as name,
      ${tagDisplayName} as displayName, ${qualified(assetTag, assetTag.origin)} as origin
    from ${assetTag} cross join ${tag} on ${tagId} = ${qualified(assetTag, assetTag.tagId)}
    where ${qualified(assetTag, assetTag.assetId)} in ${inList(assetIds)}
    union all
    select 'file', ${qualified(fileTag, fileTag.fileId)}, ${tagName}, ${tagDisplayName}, ${qualified(fileTag, fileTag.origin)}
    from ${fileTag} cross join ${tag} on ${tagId} = ${qualified(fileTag, fileTag.tagId)}
    where ${qualified(fileTag, fileTag.fileId)} in ${inList(fileIds)}
    order by name, origin`;
}

/**
 * Asset tags by asset id and file tags by file id (for the cover files of a list page), each list
 * ordered by name, then origin. Owners without tags are missing from the maps.
 */
export function assetTagsOf(
  tx: IndexTransaction,
  assetIds: readonly string[],
  coverFileIds: readonly string[],
): { asset: Map<string, TagAssignment[]>; file: Map<string, TagAssignment[]> } {
  const result = { asset: new Map<string, TagAssignment[]>(), file: new Map<string, TagAssignment[]>() };
  if (assetIds.length === 0 && coverFileIds.length === 0) return result;
  const rows = tx.all<{ kind: 'asset' | 'file'; owner: string; name: string; displayName: string; origin: TagOrigin }>(
    assetTagsSql(assetIds, coverFileIds),
  );
  for (const { kind, owner, ...assignment } of rows) {
    const byOwner = result[kind];
    const assignments = byOwner.get(owner);
    if (assignments) assignments.push(assignment);
    else byOwner.set(owner, [assignment]);
  }
  return result;
}

/**
 * One statement with three parts: the requested tags themselves (`place` 'tag', with name and
 * display name), their assignments on the given assets (`place` 'asset'), and their assignments on
 * complete files of the given assets (`place` 'file'). `cross join` keeps `file` (keyed on the
 * asset) as the outer loop, as in the tag filter. Exported for the query plan test; callers use
 * `matchedTagsOf`.
 */
export function matchedTagsSql(assetIds: readonly string[], tagIds: readonly string[]): SQL {
  return sql`select 'tag' as place, ${tagId} as tagId, null as assetId, ${tagName} as name, ${tagDisplayName} as displayName
    from ${tag} where ${tagId} in ${inList(tagIds)}
    union all
    select 'asset', ${qualified(assetTag, assetTag.tagId)}, ${qualified(assetTag, assetTag.assetId)}, null, null
    from ${assetTag}
    where ${qualified(assetTag, assetTag.assetId)} in ${inList(assetIds)} and ${qualified(assetTag, assetTag.tagId)} in ${inList(tagIds)}
    union all
    select 'file', ${qualified(fileTag, fileTag.tagId)}, ${qualified(file, file.assetId)}, null, null
    from ${file} cross join ${fileTag} on ${qualified(fileTag, fileTag.fileId)} = ${qualified(file, file.id)}
    where ${qualified(file, file.assetId)} in ${inList(assetIds)} and ${qualified(file, file.status)} = 'complete'
      and ${qualified(fileTag, fileTag.tagId)} in ${inList(tagIds)}`;
}

/**
 * For each given asset, one entry per requested tag in request order, saying whether the asset
 * itself or one of its complete files carries it. Tag ids that do not exist are left out.
 */
export function matchedTagsOf(tx: IndexTransaction, assetIds: readonly string[], tagIds: readonly string[]): Map<string, MatchedTag[]> {
  const result = new Map<string, MatchedTag[]>();
  if (assetIds.length === 0) return result;
  const tags = new Map<string, { name: string; displayName: string }>();
  const onAsset = new Set<string>();
  const onFiles = new Set<string>();
  const key = (assetId: string, id: string) => `${assetId}\u0000${id}`;
  if (tagIds.length > 0) {
    const rows = tx.all<{ place: 'tag' | 'asset' | 'file'; tagId: string; assetId: string | null; name: string | null; displayName: string | null }>(
      matchedTagsSql(assetIds, tagIds),
    );
    for (const r of rows) {
      if (r.place === 'tag') tags.set(r.tagId, { name: r.name!, displayName: r.displayName! });
      else (r.place === 'asset' ? onAsset : onFiles).add(key(r.assetId!, r.tagId));
    }
  }
  const requested = [...new Set(tagIds)].flatMap((id) => {
    const t = tags.get(id);
    return t === undefined ? [] : [{ id, ...t }];
  });
  for (const assetId of assetIds) {
    result.set(
      assetId,
      requested.map((t) => ({
        name: t.name,
        displayName: t.displayName,
        onAsset: onAsset.has(key(assetId, t.id)),
        onFiles: onFiles.has(key(assetId, t.id)),
      })),
    );
  }
  return result;
}
