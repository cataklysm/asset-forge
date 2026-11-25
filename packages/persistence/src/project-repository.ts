import type { MatchedTag, Project, ProjectList, ProjectSummary } from '@assetforge/contracts';
import { foldSearchWord, type ProjectQuery, type ProjectRepository } from '@assetforge/core';
import { and, asc, count, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { carriesTag, hasAssetTag, hasFileTag } from './asset-filters.js';
import { qualified } from './qualified.js';
import { file, project, projectAsset, tag } from './schema.js';

const toProject = (row: typeof project.$inferSelect): Project => ({
  id: row.id,
  name: row.name,
  description: row.description,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

type ListTx = Pick<BetterSQLite3Database, 'select' | 'all'>;
interface FilterTag {
  id: string;
  name: string;
  displayName: string;
}

const projectId = qualified(project, project.id);
const memberProjectId = qualified(projectAsset, projectAsset.projectId);
const memberAssetId = qualified(projectAsset, projectAsset.assetId);

/** `exists` a member asset of the outer project that carries every tag and satisfies `extra`. */
const hasMember = (tagIds: readonly string[], extra?: SQL): SQL =>
  sql`exists (select 1 from ${projectAsset} where ${memberProjectId} = ${projectId} and ${and(
    ...tagIds.map((id) => carriesTag(memberAssetId, id)),
    extra,
  )})`;

/**
 * The requested tags in request order; null when one does not exist, so nothing can match. Run it
 * in the list's read transaction.
 */
function filterTags(tx: ListTx, names: readonly string[]): FilterTag[] | null {
  if (names.length === 0) return [];
  const rows = tx
    .select({ id: tag.id, name: tag.name, displayName: tag.displayName })
    .from(tag)
    .where(inArray(tag.name, [...names]))
    .all();
  const byName = new Map(rows.map((r) => [r.name, r]));
  const tags = [...new Set(names)].map((name) => byName.get(name));
  return tags.every((t) => t !== undefined) ? tags : null;
}

/**
 * The WHERE of a project list: status, the query as a folded substring of name or description
 * (Plan decision 3), and one member asset carrying every tag, each on the asset or on one of its
 * complete files.
 */
function projectListWhere(q: ProjectQuery, tags: readonly FilterTag[]): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];
  if (q.status !== undefined) conditions.push(eq(project.status, q.status));
  if (q.query !== undefined) {
    const text = foldSearchWord(q.query);
    conditions.push(
      sql`(instr(af_fold(${qualified(project, project.name)}), ${text}) > 0 or instr(af_fold(${qualified(project, project.description)}), ${text}) > 0)`,
    );
  }
  if (tags.length > 0) conditions.push(hasMember(tags.map((t) => t.id)));
  return and(...conditions);
}

const pageQuery = (tx: ListTx, q: ProjectQuery, where: SQL | undefined) =>
  tx
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
    .limit(q.limit)
    .offset(q.offset);

const countQuery = (tx: ListTx, where: SQL | undefined) => tx.select({ n: count() }).from(project).where(where);

/** The page and count statements of a project list; null when a requested tag does not exist. Exported for the query plan test. */
export function projectListSql(tx: ListTx, q: ProjectQuery): { page: SQL; count: SQL } | null {
  const tags = filterTags(tx, q.tagNames ?? []);
  if (tags === null) return null;
  const where = projectListWhere(q, tags);
  return { page: pageQuery(tx, q, where).getSQL(), count: countQuery(tx, where).getSQL() };
}

/**
 * One row per (project, tag) for the given projects and tags: whether a member asset that carries
 * every one of the tags has the tag itself (`onAsset`) or on one of its complete files (`onFiles`).
 * Exported for the query plan test; callers use `projectMatchedTagsOf`.
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

/** For each given project, one entry per requested tag in request order. */
function projectMatchedTagsOf(tx: ListTx, projectIds: readonly string[], tags: readonly FilterTag[]): Map<string, MatchedTag[]> {
  const result = new Map<string, MatchedTag[]>();
  if (projectIds.length === 0 || tags.length === 0) return result;
  const found = new Map<string, { onAsset: boolean; onFiles: boolean }>();
  const key = (p: string, t: string) => `${p}\u0000${t}`;
  const rows = tx.all<{ projectId: string; tagId: string; onAsset: number; onFiles: number }>(
    projectMatchedTagsSql(
      projectIds,
      tags.map((t) => t.id),
    ),
  );
  for (const r of rows) found.set(key(r.projectId, r.tagId), { onAsset: r.onAsset === 1, onFiles: r.onFiles === 1 });
  for (const p of projectIds) {
    result.set(
      p,
      tags.map((t) => ({
        name: t.name,
        displayName: t.displayName,
        ...(found.get(key(p, t.id)) ?? { onAsset: false, onFiles: false }),
      })),
    );
  }
  return result;
}

export function createProjectRepository(db: BetterSQLite3Database): ProjectRepository {
  return {
    async insert(p) {
      db.insert(project)
        .values({
          id: p.id,
          name: p.name,
          description: p.description,
          status: p.status,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })
        .run();
    },
    async get(id) {
      const row = db.select().from(project).where(eq(project.id, id)).get();
      return row ? toProject(row) : null;
    },
    async update(id, patch) {
      const set: Partial<typeof project.$inferInsert> = { updatedAt: patch.updatedAt };
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.status !== undefined) set.status = patch.status;
      const row = db.update(project).set(set).where(eq(project.id, id)).returning().get();
      return row ? toProject(row) : null;
    },
    async list(q): Promise<ProjectList> {
      // One read transaction, so the page, the matched tags and the total describe the same snapshot.
      return db.transaction(
        (tx) => {
          const tags = filterTags(tx, q.tagNames ?? []);
          if (tags === null) return { items: [], total: 0 };
          const where = projectListWhere(q, tags);
          const rows: ProjectSummary[] = pageQuery(tx, q, where).all();
          const total = countQuery(tx, where).get()?.n ?? 0;
          if (tags.length === 0) return { items: rows, total };
          const matched = projectMatchedTagsOf(
            tx,
            rows.map((r) => r.id),
            tags,
          );
          return { items: rows.map((r) => ({ ...r, matchedTags: matched.get(r.id)! })), total };
        },
        { behavior: 'deferred' },
      );
    },
  };
}
