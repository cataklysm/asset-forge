import type { Project, ProjectList, ProjectSummary } from '@assetforge/contracts';
import type { ProjectRepository } from '@assetforge/core';
import { asc, count, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { project, projectAsset } from './schema.js';

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
    async list({ limit, offset }): Promise<ProjectList> {
      // One read transaction, so the page and the total describe the same snapshot.
      return db.transaction(
        (tx) => {
          const items: ProjectSummary[] = tx
            .select({
              id: project.id,
              name: project.name,
              description: project.description,
              status: project.status,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              assetCount: sql<number>`(select count(*) from ${projectAsset} where ${projectAsset.projectId} = ${project.id})`,
            })
            .from(project)
            .orderBy(sql`lower(${project.name})`, asc(project.id))
            .limit(limit)
            .offset(offset)
            .all();
          const total = tx.select({ n: count() }).from(project).get()?.n ?? 0;
          return { items, total };
        },
        { behavior: 'deferred' },
      );
    },
  };
}
