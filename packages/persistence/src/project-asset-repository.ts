import type { AssetAssignment, ProjectAssignment, ProjectMemberList } from '@assetforge/contracts';
import type { AssignmentKey, ProjectAssetRepository } from '@assetforge/core';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { toAsset } from './asset-rows.js';
import { automaticCovers } from './asset-summaries.js';
import { asset, project, projectAsset } from './schema.js';

/**
 * The assignment of a row.
 *
 * @param row the assignment row
 * @returns the assignment
 */
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

/**
 * The project of a row.
 *
 * @param row the project row
 * @returns the project
 */
const toProject = (row: typeof project.$inferSelect) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * The condition on the assignment's key.
 *
 * @param key the project and the asset
 * @returns the condition
 */
const keyMatches = (key: AssignmentKey) =>
  and(eq(projectAsset.projectId, key.projectId), eq(projectAsset.assetId, key.assetId));

/**
 * The project assignment repository over the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createProjectAssetRepository(database: BetterSQLite3Database): ProjectAssetRepository {
  return {
    insert: (assignment) => insertAssignment(database, assignment),
    get: (key) => getAssignment(database, key),
    update: (key, patch) => updateAssignment(database, key, patch),
    remove: (key) => removeAssignment(database, key),
    listByAsset: (assetId) => listByAsset(database, assetId),
    listByProject: (projectId, page) => listByProject(database, projectId, page),
  };
}

/**
 * Inserts the assignment unless the asset is already assigned to the project.
 *
 * @param database the workspace database
 * @param assignment the assignment
 * @returns whether a row was written; false when the assignment already existed
 */
async function insertAssignment(database: BetterSQLite3Database, assignment: ProjectAssignment): Promise<boolean> {
  const result = database
    .insert(projectAsset)
    .values({
      projectId: assignment.projectId,
      assetId: assignment.assetId,
      priority: assignment.priority,
      intendedUse: assignment.intendedUse,
      approvalStatus: assignment.approvalStatus,
      notes: assignment.notes,
      assignedAt: assignment.assignedAt,
      updatedAt: assignment.updatedAt,
    })
    .onConflictDoNothing({ target: [projectAsset.projectId, projectAsset.assetId] })
    .run();
  return result.changes > 0;
}

/**
 * One assignment.
 *
 * @param database the workspace database
 * @param key the project and the asset
 * @returns the assignment; null when unknown
 */
async function getAssignment(database: BetterSQLite3Database, key: AssignmentKey): Promise<ProjectAssignment | null> {
  const row = database.select().from(projectAsset).where(keyMatches(key)).get();
  return row ? toAssignment(row) : null;
}

/**
 * Changes the given fields and the update time.
 *
 * @param database the workspace database
 * @param key the project and the asset
 * @param patch the fields to change with the update time
 * @returns the changed assignment; null when unknown
 */
async function updateAssignment(
  database: BetterSQLite3Database,
  key: AssignmentKey,
  patch: Parameters<ProjectAssetRepository['update']>[1],
): Promise<ProjectAssignment | null> {
  const set: Partial<typeof projectAsset.$inferInsert> = { updatedAt: patch.updatedAt };
  if (patch.priority !== undefined) set.priority = patch.priority;
  if (patch.intendedUse !== undefined) set.intendedUse = patch.intendedUse;
  if (patch.approvalStatus !== undefined) set.approvalStatus = patch.approvalStatus;
  if (patch.notes !== undefined) set.notes = patch.notes;
  const row = database.update(projectAsset).set(set).where(keyMatches(key)).returning().get();
  return row ? toAssignment(row) : null;
}

/**
 * Deletes the assignment.
 *
 * @param database the workspace database
 * @param key the project and the asset
 * @returns whether an assignment was deleted
 */
async function removeAssignment(database: BetterSQLite3Database, key: AssignmentKey): Promise<boolean> {
  return database.delete(projectAsset).where(keyMatches(key)).run().changes > 0;
}

/**
 * The assignments of an asset with their project, by project name, then id.
 *
 * @param database the workspace database
 * @param assetId the asset
 * @returns the assignments
 */
async function listByAsset(database: BetterSQLite3Database, assetId: string): Promise<AssetAssignment[]> {
  return database
    .select({ link: projectAsset, project })
    .from(projectAsset)
    .innerJoin(project, eq(project.id, projectAsset.projectId))
    .where(eq(projectAsset.assetId, assetId))
    .orderBy(sql`lower(${project.name})`, asc(project.id))
    .all()
    .map((row) => ({ ...toAssignment(row.link), project: toProject(row.project) }));
}

/**
 * One page of a project's members with their asset and its effective cover, by asset name, then id, with the total.
 *
 * @param database the workspace database
 * @param projectId the project
 * @param page the limit and offset
 * @returns the page and the total
 */
async function listByProject(
  database: BetterSQLite3Database,
  projectId: string,
  { limit, offset }: Parameters<ProjectAssetRepository['listByProject']>[1],
): Promise<ProjectMemberList> {
  const where = eq(projectAsset.projectId, projectId);
  // One read transaction, so the page and the total describe the same snapshot.
  return database.transaction(
    (transaction) => {
      const rows = transaction
        .select({ link: projectAsset, asset })
        .from(projectAsset)
        .innerJoin(asset, eq(asset.id, projectAsset.assetId))
        .where(where)
        .orderBy(sql`lower(${asset.name})`, asc(asset.id))
        .limit(limit)
        .offset(offset)
        .all();
      const automatic = automaticCovers(
        transaction,
        rows.filter((row) => row.asset.coverFileId === null).map((row) => row.asset.id),
      );
      const items = rows.map((row) => ({
        ...toAssignment(row.link),
        asset: toAsset(row.asset),
        coverFileId: row.asset.coverFileId ?? automatic.get(row.asset.id) ?? null,
      }));
      const total = transaction.select({ n: count() }).from(projectAsset).where(where).get()?.n ?? 0;
      return { items, total };
    },
    { behavior: 'deferred' },
  );
}
