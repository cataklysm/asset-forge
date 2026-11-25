import type { Asset, AssetList, AssetSummary } from '@assetforge/contracts';
import { PREVIEWABLE_MIME_TYPES, type AssetRepository } from '@assetforge/core';
import { and, asc, count, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { containsPattern } from './like.js';
import { qualified } from './qualified.js';
import {
  asset,
  assetTag,
  assetWorkflow,
  assetWorkflowStep,
  file,
  fileTag,
  projectAsset,
  tag,
  workflowStepDefinition,
} from './schema.js';

const toAsset = (row: typeof asset.$inferSelect): Asset => ({
  id: row.id,
  name: row.name,
  typeId: row.typeId,
  description: row.description,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const outerAssetId = qualified(asset, asset.id);
const workflowAssetId = qualified(assetWorkflow, assetWorkflow.assetId);

/** `from ... where ...` over the mandatory step rows of the outer asset's workflow. */
const mandatoryStepsOfOuterAsset = sql`from ${assetWorkflowStep}
  join ${assetWorkflow} on ${qualified(assetWorkflow, assetWorkflow.id)} = ${qualified(assetWorkflowStep, assetWorkflowStep.assetWorkflowId)}
  join ${workflowStepDefinition} on ${qualified(workflowStepDefinition, workflowStepDefinition.id)} = ${qualified(assetWorkflowStep, assetWorkflowStep.stepDefinitionId)}
  where ${workflowAssetId} = ${outerAssetId} and ${qualified(workflowStepDefinition, workflowStepDefinition.mandatory)} = 1`;

/** The outer asset has a complete file that satisfies `predicate` (written against the `file` table). */
const hasCompleteFile = (predicate: SQL): SQL =>
  sql`exists (select 1 from ${file} where ${qualified(file, file.assetId)} = ${outerAssetId} and ${qualified(file, file.status)} = 'complete' and ${predicate})`;

/** The outer asset carries the tag itself or through one of its complete files. */
const carriesTag = (tagId: string): SQL =>
  sql`(exists (select 1 from ${assetTag} where ${qualified(assetTag, assetTag.assetId)} = ${outerAssetId} and ${qualified(assetTag, assetTag.tagId)} = ${tagId})
    or exists (select 1 from ${fileTag} join ${file} on ${qualified(file, file.id)} = ${qualified(fileTag, fileTag.fileId)}
      where ${qualified(file, file.assetId)} = ${outerAssetId} and ${qualified(file, file.status)} = 'complete' and ${qualified(fileTag, fileTag.tagId)} = ${tagId}))`;

/**
 * Automatic cover of each given asset in one statement: its complete, previewable file with the
 * earliest importedAt, ties by id. Assets without such a file are missing from the map.
 */
function automaticCovers(tx: Pick<BetterSQLite3Database, 'select'>, assetIds: readonly string[]): Map<string, string> {
  if (assetIds.length === 0) return new Map();
  const ranked = tx
    .select({
      assetId: file.assetId,
      id: file.id,
      rank: sql<number>`row_number() over (partition by ${file.assetId} order by ${file.importedAt}, ${file.id})`.as('rank'),
    })
    .from(file)
    .where(
      and(
        inArray(file.assetId, [...assetIds]),
        eq(file.status, 'complete'),
        inArray(file.mimeType, [...PREVIEWABLE_MIME_TYPES]),
      ),
    )
    .as('ranked');
  const rows = tx.select({ assetId: ranked.assetId, id: ranked.id }).from(ranked).where(eq(ranked.rank, 1)).all();
  return new Map(rows.flatMap((r) => (r.assetId === null ? [] : [[r.assetId, r.id] as const])));
}

export function createAssetRepository(db: BetterSQLite3Database): AssetRepository {
  return {
    async insert(a) {
      db.insert(asset)
        .values({
          id: a.id,
          name: a.name,
          typeId: a.typeId,
          description: a.description,
          status: a.status,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
        })
        .run();
    },
    async get(id) {
      const row = db.select().from(asset).where(eq(asset.id, id)).get();
      return row ? toAsset(row) : null;
    },
    async update(id, patch) {
      const set: Partial<typeof asset.$inferInsert> = { updatedAt: patch.updatedAt };
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.typeId !== undefined) set.typeId = patch.typeId;
      if (patch.status !== undefined) set.status = patch.status;
      const row = db.update(asset).set(set).where(eq(asset.id, id)).returning().get();
      return row ? toAsset(row) : null;
    },
    async list(q): Promise<AssetList> {
      const conditions: SQL[] = [];
      if (q.typeId !== undefined) conditions.push(eq(asset.typeId, q.typeId));
      if (q.status !== undefined) conditions.push(eq(asset.status, q.status));
      if (q.projectId !== undefined) {
        conditions.push(
          sql`exists (select 1 from ${projectAsset} where ${qualified(projectAsset, projectAsset.assetId)} = ${outerAssetId} and ${qualified(projectAsset, projectAsset.projectId)} = ${q.projectId})`,
        );
      }
      // Temporary bridge until the full-text index answers `query`: substring match on the name.
      if (q.query !== undefined) {
        conditions.push(sql`${asset.name} like ${containsPattern(q.query)} escape '\\'`);
      }
      if (q.fileRole !== undefined) conditions.push(hasCompleteFile(sql`${qualified(file, file.role)} = ${q.fileRole}`));
      if (q.fileKind !== undefined) conditions.push(hasCompleteFile(sql`${qualified(file, file.kind)} = ${q.fileKind}`));
      // One read transaction, so the tag ids, the page and the total describe the same snapshot.
      return db.transaction(
        (tx) => {
          const names = q.tagNames ?? [];
          const tagIds = names.length === 0 ? [] : tx.select({ id: tag.id }).from(tag).where(inArray(tag.name, names)).all();
          if (tagIds.length < names.length) return { items: [], total: 0 };
          const where = and(...conditions, ...tagIds.map(({ id }) => carriesTag(id)));
          const rows = tx
            .select({
              id: asset.id,
              name: asset.name,
              typeId: asset.typeId,
              description: asset.description,
              status: asset.status,
              createdAt: asset.createdAt,
              updatedAt: asset.updatedAt,
              projectCount: sql<number>`(select count(*) from ${projectAsset} where ${qualified(projectAsset, projectAsset.assetId)} = ${outerAssetId})`,
              fileCount: sql<number>`(select count(*) from ${file} where ${qualified(file, file.assetId)} = ${outerAssetId})`,
              hasWorkflow: sql<number>`exists (select 1 from ${assetWorkflow} where ${workflowAssetId} = ${outerAssetId})`,
              workflowDone: sql<number>`(select count(*) ${mandatoryStepsOfOuterAsset} and ${qualified(assetWorkflowStep, assetWorkflowStep.state)} = 'done')`,
              workflowTotal: sql<number>`(select count(*) ${mandatoryStepsOfOuterAsset})`,
              chosenCover: asset.coverFileId,
            })
            .from(asset)
            .where(where)
            .orderBy(sql`lower(${asset.name})`, asc(asset.id))
            .limit(q.limit)
            .offset(q.offset)
            .all();
          // One statement for the whole page, not one per asset.
          const automatic = automaticCovers(
            tx,
            rows.filter((r) => r.chosenCover === null).map((r) => r.id),
          );
          const items: AssetSummary[] = rows.map(({ hasWorkflow, workflowDone, workflowTotal, chosenCover, ...row }) => ({
            ...row,
            workflowProgress: hasWorkflow ? { done: workflowDone, total: workflowTotal } : null,
            coverFileId: chosenCover ?? automatic.get(row.id) ?? null,
          }));
          const total = tx.select({ n: count() }).from(asset).where(where).get()?.n ?? 0;
          return { items, total };
        },
        { behavior: 'deferred' },
      );
    },
    async getCover(assetId) {
      // One read transaction, so the chosen and the automatic cover describe the same snapshot.
      return db.transaction(
        (tx) => {
          const row = tx.select({ chosen: asset.coverFileId }).from(asset).where(eq(asset.id, assetId)).get();
          if (!row) return null;
          if (row.chosen !== null) return { coverFileId: row.chosen, coverIsChosen: true };
          return { coverFileId: automaticCovers(tx, [assetId]).get(assetId) ?? null, coverIsChosen: false };
        },
        { behavior: 'deferred' },
      );
    },
    async setCover(assetId, fileId, updatedAt) {
      db.update(asset).set({ coverFileId: fileId, updatedAt }).where(eq(asset.id, assetId)).run();
    },
  };
}
