import type { AssetSummary } from '@assetforge/contracts';
import { PREVIEWABLE_MIME_TYPES, VIDEO_MIME_TYPES } from '@assetforge/core';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { outerAssetId } from './asset-filters.js';
import { assetTagsOf, matchedTagsOf } from './list-tags.js';
import { qualified } from './qualified.js';
import { asset, assetWorkflow, assetWorkflowStep, file, projectAsset, workflowStepDefinition } from './schema.js';
import type { IndexTransaction } from './search-index.js';
import { existingTags } from './tag-lookup.js';

// The rows of the asset list: counts, workflow progress, cover and tags of each asset.

/** A mandatory step row counts 1, any other row (including the null row of a workflow without steps) 0. */
const isMandatory = sql`coalesce(${workflowStepDefinition.mandatory}, 0) = 1`;

/**
 * Workflow progress of each given asset in one statement: done and total mandatory steps. Assets without a
 * workflow are missing from the map.
 *
 * @param transaction the database or the caller's transaction
 * @param assetIds the assets
 * @returns the progress by asset id
 */
function workflowProgresses(
  transaction: Pick<BetterSQLite3Database, 'select'>,
  assetIds: readonly string[],
): Map<string, { done: number; total: number }> {
  if (assetIds.length === 0) return new Map();
  const rows = transaction
    .select({
      assetId: assetWorkflow.assetId,
      done: sql<number>`coalesce(sum(${isMandatory} and ${assetWorkflowStep.state} = 'done'), 0)`,
      total: sql<number>`coalesce(sum(${isMandatory}), 0)`,
    })
    .from(assetWorkflow)
    .leftJoin(assetWorkflowStep, eq(assetWorkflowStep.assetWorkflowId, assetWorkflow.id))
    .leftJoin(workflowStepDefinition, eq(workflowStepDefinition.id, assetWorkflowStep.stepDefinitionId))
    .where(inArray(assetWorkflow.assetId, [...assetIds]))
    .groupBy(assetWorkflow.assetId)
    .all();
  return new Map(rows.map((row) => [row.assetId, { done: row.done, total: row.total }] as const));
}

/**
 * Automatic cover of each given asset in one statement, the same rule as `automaticCover` in core:
 * its complete, previewable image with the earliest importedAt, ties by id; only when it has none,
 * its complete video by the same order. Assets without such a file are missing from the map.
 *
 * @param transaction the database or the caller's transaction
 * @param assetIds the assets
 * @returns the cover file id by asset id
 */
export function automaticCovers(
  transaction: Pick<BetterSQLite3Database, 'select'>,
  assetIds: readonly string[],
): Map<string, string> {
  if (assetIds.length === 0) return new Map();
  const ranked = transaction
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
  const rows = transaction
    .select({ assetId: ranked.assetId, id: ranked.id })
    .from(ranked)
    .where(eq(ranked.rank, 1))
    .all();
  return new Map(rows.flatMap((row) => (row.assetId === null ? [] : [[row.assetId, row.id] as const])));
}

/** An asset summary before its tags are attached. */
export type BareSummary = Omit<AssetSummary, 'tags' | 'coverTags' | 'matchedTags'>;

/**
 * Summaries (project count, file count, workflow progress, cover) of the assets matching `where`,
 * ordered by name, then id; one page when `page` is given.
 *
 * @param transaction the list's read transaction
 * @param where the condition over the outer asset row
 * @param page the page; every match without it
 * @returns the summaries
 */
export function summaries(
  transaction: Pick<BetterSQLite3Database, 'select'>,
  where: SQL | undefined,
  page?: { limit: number; offset: number },
): BareSummary[] {
  const query = transaction
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
      chosenCover: asset.coverFileId,
    })
    .from(asset)
    .where(where)
    .orderBy(sql`lower(${asset.name})`, asc(asset.id));
  const rows = page === undefined ? query.all() : query.limit(page.limit).offset(page.offset).all();
  // One statement each for the whole page, not one per asset.
  const progress = workflowProgresses(
    transaction,
    rows.map((row) => row.id),
  );
  const automatic = automaticCovers(
    transaction,
    rows.filter((row) => row.chosenCover === null).map((row) => row.id),
  );
  return rows.map(({ chosenCover, ...row }) => ({
    ...row,
    workflowProgress: progress.get(row.id) ?? null,
    coverFileId: chosenCover ?? automatic.get(row.id) ?? null,
  }));
}

/**
 * Attaches the asset tags, the tags of the effective cover and, when the list filtered by tags,
 * the matched tags: one statement for the tags, and two more (tag ids, matches) with a tag filter,
 * whatever the page size.
 *
 * @param transaction the list's read transaction
 * @param items the summaries of the page
 * @param tagNames the tag filter of the list
 * @returns the summaries with their tags
 */
export function withTags(
  transaction: IndexTransaction,
  items: BareSummary[],
  tagNames: readonly string[],
): AssetSummary[] {
  if (items.length === 0) return [];
  const ids = items.map((summary) => summary.id);
  const coverIds = items.flatMap((summary) => (summary.coverFileId === null ? [] : [summary.coverFileId]));
  const tags = assetTagsOf(transaction, ids, coverIds);
  const matched = tagNames.length > 0 ? matchedTagsOf(transaction, ids, requestedTagIds(transaction, tagNames)) : null;
  return items.map((summary) => ({
    ...summary,
    tags: tags.asset.get(summary.id) ?? [],
    coverTags: summary.coverFileId === null ? [] : (tags.file.get(summary.coverFileId) ?? []),
    ...(matched !== null && { matchedTags: matched.get(summary.id) ?? [] }),
  }));
}

/**
 * The ids of the named tags in request order, in one statement like the tag filter; unknown names are left out.
 *
 * @param transaction the list's read transaction
 * @param names the normalised names
 * @returns the ids
 */
function requestedTagIds(transaction: IndexTransaction, names: readonly string[]): string[] {
  return existingTags(transaction, names).map((existing) => existing.id);
}
