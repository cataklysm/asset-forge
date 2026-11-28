import type { Asset, AssetList, AssetSummary } from '@assetforge/contracts';
import { PREVIEWABLE_MIME_TYPES, VIDEO_MIME_TYPES, searchWords, type AssetRepository } from '@assetforge/core';
import { and, asc, count, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { assetFilter, outerAssetId } from './asset-filters.js';
import { assetTagsOf, matchedTagsOf } from './list-tags.js';
import { qualified } from './qualified.js';
import { asset, assetWorkflow, assetWorkflowStep, file, projectAsset, tag, workflowStepDefinition } from './schema.js';
import { searchAssets } from './asset-search.js';
import { reindexAsset, type Tx } from './search-index.js';

const toAsset = (row: typeof asset.$inferSelect): Asset => ({
  id: row.id,
  name: row.name,
  typeId: row.typeId,
  description: row.description,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const workflowAssetId = qualified(assetWorkflow, assetWorkflow.assetId);

/** `from ... where ...` over the mandatory step rows of the outer asset's workflow. */
const mandatoryStepsOfOuterAsset = sql`from ${assetWorkflowStep}
  join ${assetWorkflow} on ${qualified(assetWorkflow, assetWorkflow.id)} = ${qualified(assetWorkflowStep, assetWorkflowStep.assetWorkflowId)}
  join ${workflowStepDefinition} on ${qualified(workflowStepDefinition, workflowStepDefinition.id)} = ${qualified(assetWorkflowStep, assetWorkflowStep.stepDefinitionId)}
  where ${workflowAssetId} = ${outerAssetId} and ${qualified(workflowStepDefinition, workflowStepDefinition.mandatory)} = 1`;

/**
 * Automatic cover of each given asset in one statement, the same rule as `automaticCover` in core:
 * its complete, previewable image with the earliest importedAt, ties by id; only when it has none,
 * its complete video by the same order. Assets without such a file are missing from the map.
 */
function automaticCovers(tx: Pick<BetterSQLite3Database, 'select'>, assetIds: readonly string[]): Map<string, string> {
  if (assetIds.length === 0) return new Map();
  const ranked = tx
    .select({
      assetId: file.assetId,
      id: file.id,
      rank: sql<number>`row_number() over (partition by ${file.assetId} order by case when ${inArray(file.mimeType, [...PREVIEWABLE_MIME_TYPES])} then 0 else 1 end, ${file.importedAt}, ${file.id})`.as(
        'rank',
      ),
    })
    .from(file)
    .where(
      and(
        inArray(file.assetId, [...assetIds]),
        eq(file.status, 'complete'),
        inArray(file.mimeType, [...PREVIEWABLE_MIME_TYPES, ...VIDEO_MIME_TYPES]),
      ),
    )
    .as('ranked');
  const rows = tx.select({ assetId: ranked.assetId, id: ranked.id }).from(ranked).where(eq(ranked.rank, 1)).all();
  return new Map(rows.flatMap((r) => (r.assetId === null ? [] : [[r.assetId, r.id] as const])));
}

type BareSummary = Omit<AssetSummary, 'tags' | 'coverTags' | 'matchedTags'>;

/**
 * Summaries (project count, file count, workflow progress, cover) of the assets matching `where`,
 * ordered by name, then id; one page when `page` is given.
 */
function summaries(
  tx: Pick<BetterSQLite3Database, 'select'>,
  where: SQL | undefined,
  page?: { limit: number; offset: number },
): BareSummary[] {
  const query = tx
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
    .orderBy(sql`lower(${asset.name})`, asc(asset.id));
  const rows = page === undefined ? query.all() : query.limit(page.limit).offset(page.offset).all();
  // One statement for the whole page, not one per asset.
  const automatic = automaticCovers(
    tx,
    rows.filter((r) => r.chosenCover === null).map((r) => r.id),
  );
  return rows.map(({ hasWorkflow, workflowDone, workflowTotal, chosenCover, ...row }) => ({
    ...row,
    workflowProgress: hasWorkflow ? { done: workflowDone, total: workflowTotal } : null,
    coverFileId: chosenCover ?? automatic.get(row.id) ?? null,
  }));
}

/**
 * Attaches the asset tags, the tags of the effective cover and, when the list filtered by tags,
 * the matched tags: one statement for the tags, and two more (tag ids, matches) with a tag filter,
 * whatever the page size.
 */
function withTags(tx: Tx, items: BareSummary[], tagNames: readonly string[]): AssetSummary[] {
  if (items.length === 0) return [];
  const ids = items.map((s) => s.id);
  const coverIds = items.flatMap((s) => (s.coverFileId === null ? [] : [s.coverFileId]));
  const tags = assetTagsOf(tx, ids, coverIds);
  const matched = tagNames.length > 0 ? matchedTagsOf(tx, ids, requestedTagIds(tx, tagNames)) : null;
  return items.map((s) => ({
    ...s,
    tags: tags.asset.get(s.id) ?? [],
    coverTags: s.coverFileId === null ? [] : (tags.file.get(s.coverFileId) ?? []),
    ...(matched !== null && { matchedTags: matched.get(s.id) ?? [] }),
  }));
}

/** The ids of the named tags in request order, in one statement like the tag filter; unknown names are left out. */
function requestedTagIds(tx: Tx, names: readonly string[]): string[] {
  const unique = [...new Set(names)];
  const byName = new Map(
    tx.select({ id: tag.id, name: tag.name }).from(tag).where(inArray(tag.name, unique)).all().map((t) => [t.name, t.id]),
  );
  return unique.flatMap((name) => byName.get(name) ?? []);
}

export function createAssetRepository(db: BetterSQLite3Database): AssetRepository {
  return {
    async insert(a) {
      db.transaction((tx) => {
        tx.insert(asset)
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
        reindexAsset(tx, a.id);
      });
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
      return db.transaction((tx) => {
        const row = tx.update(asset).set(set).where(eq(asset.id, id)).returning().get();
        if (!row) return null;
        reindexAsset(tx, id);
        return toAsset(row);
      });
    },
    async list(q): Promise<AssetList> {
      const words = q.query === undefined ? [] : searchWords(q.query);
      // One read transaction, so the tag ids, the page and the total describe the same snapshot.
      return db.transaction(
        (tx) => {
          const tagNames = q.tagNames ?? [];
          if (words.length > 0) {
            const { ids, total } = searchAssets(tx, { ...q, words });
            if (ids.length === 0) return { items: [], total };
            const byId = new Map(summaries(tx, inArray(asset.id, ids)).map((s) => [s.id, s]));
            return { items: withTags(tx, ids.flatMap((id) => byId.get(id) ?? []), tagNames), total };
          }
          const filter = assetFilter(tx, q);
          if (filter === null) return { items: [], total: 0 };
          const items = withTags(tx, summaries(tx, filter.where, { limit: q.limit, offset: q.offset }), tagNames);
          const total = tx.select({ n: count() }).from(asset).where(filter.where).get()?.n ?? 0;
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
