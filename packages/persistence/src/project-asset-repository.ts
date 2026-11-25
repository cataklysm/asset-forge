import type { AssetAssignment, ProjectAssignment, ProjectMemberList } from '@assetforge/contracts';
import type { AssignmentKey, ProjectAssetRepository } from '@assetforge/core';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { asset, project, projectAsset } from './schema.js';

const toAssignment = (row: typeof projectAsset.$inferSelect): ProjectAssignment => ({
  projectId: row.projectId,
  assetId: row.assetId,
  priority: row.priority,
  intendedUse: row.intendedUse,
  approvalStatus: row.approvalStatus,
  notes: row.notes,
  assignedAt: row.assignedAt,
  updatedAt: row.updatedAt,
});

const toAsset = (row: typeof asset.$inferSelect) => ({
  id: row.id,
  name: row.name,
  typeId: row.typeId,
  description: row.description,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toProject = (row: typeof project.$inferSelect) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const keyMatches = (k: AssignmentKey) =>
  and(eq(projectAsset.projectId, k.projectId), eq(projectAsset.assetId, k.assetId));

export function createProjectAssetRepository(db: BetterSQLite3Database): ProjectAssetRepository {
  return {
    async insert(a) {
      db.insert(projectAsset)
        .values({
          projectId: a.projectId,
          assetId: a.assetId,
          priority: a.priority,
          intendedUse: a.intendedUse,
          approvalStatus: a.approvalStatus,
          notes: a.notes,
          assignedAt: a.assignedAt,
          updatedAt: a.updatedAt,
        })
        .run();
    },
    async get(key) {
      const row = db.select().from(projectAsset).where(keyMatches(key)).get();
      return row ? toAssignment(row) : null;
    },
    async update(key, patch) {
      const set: Partial<typeof projectAsset.$inferInsert> = { updatedAt: patch.updatedAt };
      if (patch.priority !== undefined) set.priority = patch.priority;
      if (patch.intendedUse !== undefined) set.intendedUse = patch.intendedUse;
      if (patch.approvalStatus !== undefined) set.approvalStatus = patch.approvalStatus;
      if (patch.notes !== undefined) set.notes = patch.notes;
      const row = db.update(projectAsset).set(set).where(keyMatches(key)).returning().get();
      return row ? toAssignment(row) : null;
    },
    async remove(key) {
      return db.delete(projectAsset).where(keyMatches(key)).run().changes > 0;
    },
    async listByAsset(assetId): Promise<AssetAssignment[]> {
      return db
        .select({ link: projectAsset, project })
        .from(projectAsset)
        .innerJoin(project, eq(project.id, projectAsset.projectId))
        .where(eq(projectAsset.assetId, assetId))
        .orderBy(sql`lower(${project.name})`, asc(project.id))
        .all()
        .map((r) => ({ ...toAssignment(r.link), project: toProject(r.project) }));
    },
    async listByProject(projectId, { limit, offset }): Promise<ProjectMemberList> {
      const where = eq(projectAsset.projectId, projectId);
      // One read transaction, so the page and the total describe the same snapshot.
      return db.transaction(
        (tx) => {
          const items = tx
            .select({ link: projectAsset, asset })
            .from(projectAsset)
            .innerJoin(asset, eq(asset.id, projectAsset.assetId))
            .where(where)
            .orderBy(sql`lower(${asset.name})`, asc(asset.id))
            .limit(limit)
            .offset(offset)
            .all()
            .map((r) => ({ ...toAssignment(r.link), asset: toAsset(r.asset) }));
          const total = tx.select({ n: count() }).from(projectAsset).where(where).get()?.n ?? 0;
          return { items, total };
        },
        { behavior: 'deferred' },
      );
    },
  };
}
