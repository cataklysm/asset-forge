import type { Project, ProjectList, ProjectSummary } from '@assetforge/contracts';
import type { ProjectRepository } from '@assetforge/core';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { countQuery, filterTags, pageQuery, projectListWhere, projectMatchedTagsOf } from './project-list.js';
import { project } from './schema.js';

const toProject = (row: typeof project.$inferSelect): Project => ({
  id: row.id,
  name: row.name,
  description: row.description,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

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
