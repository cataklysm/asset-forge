import type { MatchedTag, ProjectList, ProjectSummary } from '@assetforge/contracts';
import { foldSearchWord, type ProjectQuery } from '@assetforge/core';
import { and, asc, count, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { carriesTag, hasAssetTag, hasFileTag } from './asset-filters.js';
import { qualified } from './qualified.js';
import { file, project, projectAsset, tag } from './schema.js';

// The project list: its filter, its statements and the matched tags of a tag filter.

/** What the list needs of a database or transaction handle. */
export type ListTransaction = Pick<BetterSQLite3Database, 'select' | 'all'>;

/** A requested tag of the filter. */
interface FilterTag {
  id: string;
  name: string;
  displayName: string;
}

/** One row of `projectMatchedTagsSql`. */
type MatchRow = { projectId: string; tagId: string; onAsset: number; onFiles: number };

const projectId = qualified(project, project.id);
const memberProjectId = qualified(projectAsset, projectAsset.projectId);
const memberAssetId = qualified(projectAsset, projectAsset.assetId);

/**
 * `exists` a member asset of the outer project that carries every tag and satisfies `extra`.
 *
 * @param tagIds the tags every member must carry
 * @param extra a further condition on the member
 * @returns the condition over the outer project row
 */
const hasMember = (tagIds: readonly string[], extra?: SQL): SQL =>
  sql`exists (select 1 from ${projectAsset} where ${memberProjectId} = ${projectId} and ${and(
    ...tagIds.map((id) => carriesTag(memberAssetId, id)),
    extra,
  )})`;

/**
 * The requested tags in request order; null when one does not exist, so nothing can match. Run it
 * in the list's read transaction.
 *
 * @param transaction the list's read transaction
 * @param names the normalised names
 * @returns the tags; null when one does not exist
 */
function filterTags(transaction: ListTransaction, names: readonly string[]): FilterTag[] | null {
  if (names.length === 0) return [];
  const rows = transaction
    .select({ id: tag.id, name: tag.name, displayName: tag.displayName })
    .from(tag)
    .where(inArray(tag.name, [...names]))
    .all();
  const byName = new Map(rows.map((row) => [row.name, row]));
  const tags = [...new Set(names)].map((name) => byName.get(name));
  return tags.every((filterTag) => filterTag !== undefined) ? tags : null;
}

/**
 * The WHERE of a project list: status, the query as a folded substring of name or description
 * (Plan decision 3), and one member asset carrying every tag, each on the asset or on one of its
 * complete files.
 *
 * @param query the list query
 * @param tags the requested tags
 * @returns the condition
 */
function projectListWhere(query: ProjectQuery, tags: readonly FilterTag[]): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];
  if (query.status !== undefined) conditions.push(eq(project.status, query.status));
  if (query.query !== undefined) {
    const text = foldSearchWord(query.query);
    conditions.push(
      sql`(instr(af_fold(${qualified(project, project.name)}), ${text}) > 0 or instr(af_fold(${qualified(project, project.description)}), ${text}) > 0)`,
    );
  }
  if (tags.length > 0) conditions.push(hasMember(tags.map((filterTag) => filterTag.id)));
  return and(...conditions);
}

/**
 * The page statement of a project list, by name, then id.
 *
 * @param transaction the list's read transaction
 * @param query the list query
 * @param where the condition
 * @returns the statement
 */
const pageQuery = (transaction: ListTransaction, query: ProjectQuery, where: SQL | undefined) =>
  transaction
    .select({
      id: project.id,
      name: project.name,
      description: project.description,
      status: project.status,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      assetCount: sql<number>`(select count(*) from ${projectAsset} where ${memberProjectId} = ${projectId})`,
      // `file` is reached through `file_asset_id_kind_idx` for each member; the unary `+` keeps
      // SQLite from picking the less selective `file_asset_id_status_idx` instead.
      imageCount: sql<number>`(select count(*) from ${projectAsset} cross join ${file} on ${qualified(file, file.assetId)} = ${memberAssetId}
        where ${memberProjectId} = ${projectId} and ${qualified(file, file.kind)} = 'image' and +${qualified(file, file.status)} = 'complete')`,
    })
    .from(project)
    .where(where)
    .orderBy(sql`lower(${project.name})`, asc(project.id))
    .limit(query.limit)
    .offset(query.offset);

/**
 * The count statement of a project list.
 *
 * @param transaction the list's read transaction
 * @param where the condition
 * @returns the statement
 */
const countQuery = (transaction: ListTransaction, where: SQL | undefined) =>
  transaction.select({ n: count() }).from(project).where(where);

/**
 * The page and count statements of a project list; null when a requested tag does not exist. Exported for the query plan test.
 *
 * @param transaction the list's read transaction
 * @param query the list query
 * @returns the statements; null when a requested tag does not exist
 */
export function projectListSql(transaction: ListTransaction, query: ProjectQuery): { page: SQL; count: SQL } | null {
  const tags = filterTags(transaction, query.tagNames ?? []);
  if (tags === null) return null;
  const where = projectListWhere(query, tags);
  return { page: pageQuery(transaction, query, where).getSQL(), count: countQuery(transaction, where).getSQL() };
}

/**
 * One page of the project list with the total and, with a tag filter, the matched tags.
 *
 * @param transaction the list's read transaction
 * @param query the list query
 * @returns the page and the total
 */
export function projectPage(transaction: ListTransaction, query: ProjectQuery): ProjectList {
  const tags = filterTags(transaction, query.tagNames ?? []);
  if (tags === null) return { items: [], total: 0 };
  const where = projectListWhere(query, tags);
  const rows: ProjectSummary[] = pageQuery(transaction, query, where).all();
  const total = countQuery(transaction, where).get()?.n ?? 0;
  if (tags.length === 0) return { items: rows, total };
  const matched = projectMatchedTagsOf(
    transaction,
    rows.map((row) => row.id),
    tags,
  );
  return { items: rows.map((row) => ({ ...row, matchedTags: matched.get(row.id)! })), total };
}

/**
 * One row per (project, tag) for the given projects and tags: whether a member asset that carries
 * every one of the tags has the tag itself (`onAsset`) or on one of its complete files (`onFiles`).
 * Exported for the query plan test; callers use `projectMatchedTagsOf`.
 *
 * @param projectIds the projects
 * @param tagIds the requested tags
 * @returns the statement
 */
export function projectMatchedTagsSql(projectIds: readonly string[], tagIds: readonly string[]): SQL {
  const ids = sql.join(
    projectIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return sql.join(
    tagIds.map(
      (tagId) => sql`select ${projectId} as projectId, ${tagId} as tagId,
        ${hasMember(tagIds, hasAssetTag(memberAssetId, tagId))} as onAsset,
        ${hasMember(tagIds, hasFileTag(memberAssetId, tagId))} as onFiles
      from ${project} where ${projectId} in (${ids})`,
    ),
    sql` union all `,
  );
}

/**
 * The key of a tag on a project in the found map.
 *
 * @param projectRowId the project
 * @param tagId the tag
 * @returns the key
 */
const matchKey = (projectRowId: string, tagId: string) => `${projectRowId}\u0000${tagId}`;

/**
 * For each given project, one entry per requested tag in request order.
 *
 * @param transaction the list's read transaction
 * @param projectIds the projects of the page
 * @param tags the requested tags
 * @returns the matches by project id
 */
function projectMatchedTagsOf(
  transaction: ListTransaction,
  projectIds: readonly string[],
  tags: readonly FilterTag[],
): Map<string, MatchedTag[]> {
  const result = new Map<string, MatchedTag[]>();
  if (projectIds.length === 0 || tags.length === 0) return result;
  const found = new Map<string, { onAsset: boolean; onFiles: boolean }>();
  const rows = transaction.all<MatchRow>(
    projectMatchedTagsSql(
      projectIds,
      tags.map((filterTag) => filterTag.id),
    ),
  );
  for (const row of rows) {
    found.set(matchKey(row.projectId, row.tagId), { onAsset: row.onAsset === 1, onFiles: row.onFiles === 1 });
  }
  for (const id of projectIds) {
    result.set(
      id,
      tags.map((filterTag) => ({
        name: filterTag.name,
        displayName: filterTag.displayName,
        ...(found.get(matchKey(id, filterTag.id)) ?? { onAsset: false, onFiles: false }),
      })),
    );
  }
  return result;
}
