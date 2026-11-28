import type { MatchedTag, TagAssignment, TagOrigin } from '@assetforge/contracts';
import { sql, type SQL } from 'drizzle-orm';
import { qualified } from './qualified.js';
import { assetTag, file, fileTag, tag } from './schema.js';
import type { IndexTransaction } from './search-index.js';

// The tags shown in a list page: of the assets, of their covers, and the matches of a tag filter.

/**
 * `(?, ?, ...)` for an `in` list; SQLite accepts the empty list `()`.
 *
 * @param values the values
 * @returns the list
 */
const inList = (values: readonly string[]): SQL =>
  sql`(${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;

const tagId = qualified(tag, tag.id);
const tagName = qualified(tag, tag.name);
const tagDisplayName = qualified(tag, tag.displayName);

/** One row of `assetTagsSql`. */
type OwnerTagRow = { kind: 'asset' | 'file'; owner: string; name: string; displayName: string; origin: TagOrigin };

/** One row of `matchedTagsSql`. */
type MatchRow = {
  place: 'tag' | 'asset' | 'file';
  tagId: string;
  assetId: string | null;
  name: string | null;
  displayName: string | null;
};

/** A requested tag that exists. */
type RequestedTag = { id: string; name: string; displayName: string };

/**
 * The tags of the given assets and of the given files in one statement, ordered by name, then
 * origin. `kind` says which owner `owner` is. Exported for the query plan test; callers use
 * `assetTagsOf`.
 *
 * @param assetIds the assets
 * @param fileIds the files
 * @returns the statement
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
 *
 * @param transaction the list's read transaction
 * @param assetIds the assets of the page
 * @param coverFileIds the cover files of the page
 * @returns the tags by owner
 */
export function assetTagsOf(
  transaction: IndexTransaction,
  assetIds: readonly string[],
  coverFileIds: readonly string[],
): { asset: Map<string, TagAssignment[]>; file: Map<string, TagAssignment[]> } {
  const result = { asset: new Map<string, TagAssignment[]>(), file: new Map<string, TagAssignment[]>() };
  if (assetIds.length === 0 && coverFileIds.length === 0) return result;
  const rows = transaction.all<OwnerTagRow>(assetTagsSql(assetIds, coverFileIds));
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
 *
 * @param assetIds the assets
 * @param tagIds the requested tags
 * @returns the statement
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
 * The key of a tag on an asset in the match sets.
 *
 * @param assetId the asset
 * @param id the tag
 * @returns the key
 */
const matchKey = (assetId: string, id: string) => `${assetId}\u0000${id}`;

/**
 * For each given asset, one entry per requested tag in request order, saying whether the asset
 * itself or one of its complete files carries it. Tag ids that do not exist are left out.
 *
 * @param transaction the list's read transaction
 * @param assetIds the assets of the page
 * @param tagIds the requested tags
 * @returns the matches by asset id
 */
export function matchedTagsOf(
  transaction: IndexTransaction,
  assetIds: readonly string[],
  tagIds: readonly string[],
): Map<string, MatchedTag[]> {
  const result = new Map<string, MatchedTag[]>();
  if (assetIds.length === 0) return result;
  const tags = new Map<string, { name: string; displayName: string }>();
  const onAsset = new Set<string>();
  const onFiles = new Set<string>();
  if (tagIds.length > 0) {
    const rows = transaction.all<MatchRow>(matchedTagsSql(assetIds, tagIds));
    for (const row of rows) {
      if (row.place === 'tag') tags.set(row.tagId, { name: row.name!, displayName: row.displayName! });
      else if (row.place === 'asset') onAsset.add(matchKey(row.assetId!, row.tagId));
      else onFiles.add(matchKey(row.assetId!, row.tagId));
    }
  }
  const requested = requestedTags(tagIds, tags);
  for (const assetId of assetIds) {
    result.set(
      assetId,
      requested.map((requestedTag) => ({
        name: requestedTag.name,
        displayName: requestedTag.displayName,
        onAsset: onAsset.has(matchKey(assetId, requestedTag.id)),
        onFiles: onFiles.has(matchKey(assetId, requestedTag.id)),
      })),
    );
  }
  return result;
}

/**
 * The requested tags that exist, in request order, each once.
 *
 * @param tagIds the requested tags
 * @param tags the names of the existing ones by id
 * @returns the tags
 */
function requestedTags(
  tagIds: readonly string[],
  tags: ReadonlyMap<string, { name: string; displayName: string }>,
): RequestedTag[] {
  return [...new Set(tagIds)].flatMap((id) => {
    const names = tags.get(id);
    return names === undefined ? [] : [{ id, ...names }];
  });
}
