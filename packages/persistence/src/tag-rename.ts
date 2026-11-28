import { InvalidOperationError, NotFoundError, type TagRepository } from '@assetforge/core';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { parseTags } from './proposal-tags.js';
import { fileAnalysisProposal, tag } from './schema.js';
import { reindexAssets } from './search-index.js';

// Renaming a tag: a new display name, a new name, or a merge into the tag that already has the name.

/** Table and owner column of a link table; constants, never user input. */
type LinkTable = { table: SQL; owner: SQL };

/** The links of assets to tags. */
const ASSET_LINKS: LinkTable = { table: sql.raw('asset_tag'), owner: sql.raw('asset_id') };
/** The links of files to tags. */
const FILE_LINKS: LinkTable = { table: sql.raw('file_tag'), owner: sql.raw('file_id') };

/** What a rename needs of a database or transaction handle. */
type RenameTransaction = Pick<BetterSQLite3Database, 'select' | 'insert' | 'update' | 'delete' | 'run' | 'all' | 'get'>;

/** The names of a rename: the source, the target and how the target is spelled. */
type RenameNames = { from: string; name: string; displayName: string };

/**
 * Renames the tag `from` to `name` spelled `displayName`, merging into an existing tag of that name when `merge` is
 * set, in one transaction: every link, every waiting proposal and the index of every affected asset follow.
 *
 * @param database the workspace database
 * @param request the names and whether an existing target may be merged into
 * @returns whether the tag was merged into another; rejects with `NotFoundError` for an unknown source and
 *   `InvalidOperationError` for an existing target without `merge`
 */
export async function renameTag(
  database: BetterSQLite3Database,
  request: Parameters<TagRepository['rename']>[0],
): Promise<{ merged: boolean }> {
  return database.transaction((transaction) => {
    const source = transaction.select().from(tag).where(eq(tag.name, request.from)).get();
    if (!source) throw new NotFoundError('Tag does not exist');
    if (request.from === request.name) {
      // Only how the name is written changes; the index holds normalised names.
      if (source.displayName !== request.displayName) {
        transaction.update(tag).set({ displayName: request.displayName }).where(eq(tag.id, source.id)).run();
        rewriteProposals(transaction, request);
      }
      return { merged: false };
    }
    const target = transaction.select().from(tag).where(eq(tag.name, request.name)).get();
    if (target && !request.merge) throw new InvalidOperationError('A tag with this name already exists');

    const affected = affectedAssets(transaction, source.id);
    if (target) {
      mergeTag(transaction, source.id, target.id, request.displayName);
    } else {
      transaction
        .update(tag)
        .set({ name: request.name, displayName: request.displayName })
        .where(eq(tag.id, source.id))
        .run();
    }
    rewriteProposals(transaction, request);
    reindexAssets(transaction, affected);
    return { merged: target !== undefined };
  });
}

/**
 * Moves every link of the source tag to the target, deletes the source and gives the target the typed spelling.
 *
 * @param transaction the caller's transaction
 * @param sourceId the tag that goes
 * @param targetId the tag that stays
 * @param displayName the spelling the target takes
 * @returns nothing
 */
function mergeTag(transaction: RenameTransaction, sourceId: string, targetId: string, displayName: string): void {
  mergeLinks(transaction, ASSET_LINKS, sourceId, targetId);
  mergeLinks(transaction, FILE_LINKS, sourceId, targetId);
  mergePromptLinks(transaction, sourceId, targetId);
  // The foreign keys have no `on delete`: the links are gone or repointed before this.
  transaction.delete(tag).where(eq(tag.id, sourceId)).run();
  transaction.update(tag).set({ displayName }).where(eq(tag.id, targetId)).run();
}

/**
 * The assets whose index holds the tag: those carrying it and those with a file carrying it.
 *
 * @param transaction the caller's transaction
 * @param tagId the tag
 * @returns their ids
 */
function affectedAssets(transaction: RenameTransaction, tagId: string): string[] {
  return transaction
    .all<{ assetId: string }>(sql`
      select asset_id as assetId from asset_tag where tag_id = ${tagId}
      union
      select f.asset_id from file_tag as ft join file as f on f.id = ft.file_id
      where ft.tag_id = ${tagId} and f.asset_id is not null`)
    .map((row) => row.assetId);
}

/**
 * Moves every link of `sourceId` to `targetId` with set-based statements (no owner id lists, so
 * any number of links fits). An owner carrying both keeps its target link, raised to manual when
 * a source link was manual and dated to the earlier of the two; a link that only moves keeps its
 * origin and createdAt.
 *
 * @param transaction the caller's transaction
 * @param links the link table
 * @param sourceId the tag that goes
 * @param targetId the tag that stays
 * @returns nothing
 */
function mergeLinks(transaction: RenameTransaction, { table, owner }: LinkTable, sourceId: string, targetId: string): void {
  transaction.run(sql`
    update ${table} set origin = 'manual'
    where tag_id = ${targetId} and origin = 'ai'
      and ${owner} in (select s.${owner} from ${table} as s where s.tag_id = ${sourceId} and s.origin = 'manual')
      and ${owner} not in (select m.${owner} from ${table} as m where m.tag_id = ${targetId} and m.origin = 'manual')`);
  transaction.run(sql`
    update ${table} set created_at = (
      select min(s.created_at) from ${table} as s where s.tag_id = ${sourceId} and s.${owner} = ${table}.${owner})
    where tag_id = ${targetId}
      and created_at > (select min(s.created_at) from ${table} as s where s.tag_id = ${sourceId} and s.${owner} = ${table}.${owner})`);
  transaction.run(sql`
    delete from ${table}
    where tag_id = ${sourceId} and ${owner} in (select t.${owner} from ${table} as t where t.tag_id = ${targetId})`);
  transaction.run(sql`update ${table} set tag_id = ${targetId} where tag_id = ${sourceId}`);
}

/**
 * Like `mergeLinks` for prompt links, which have no origin: a prompt carrying both keeps its
 * target link dated to the earlier of the two; a link that only moves keeps its createdAt.
 * Prompts keep their `updated_at`.
 *
 * @param transaction the caller's transaction
 * @param sourceId the tag that goes
 * @param targetId the tag that stays
 * @returns nothing
 */
function mergePromptLinks(transaction: RenameTransaction, sourceId: string, targetId: string): void {
  transaction.run(sql`
    update prompt_tag set created_at = (
      select s.created_at from prompt_tag as s where s.tag_id = ${sourceId} and s.prompt_id = prompt_tag.prompt_id)
    where tag_id = ${targetId}
      and created_at > (select s.created_at from prompt_tag as s where s.tag_id = ${sourceId} and s.prompt_id = prompt_tag.prompt_id)`);
  transaction.run(sql`
    delete from prompt_tag
    where tag_id = ${sourceId} and prompt_id in (select t.prompt_id from prompt_tag as t where t.tag_id = ${targetId})`);
  transaction.run(sql`update prompt_tag set tag_id = ${targetId} where tag_id = ${sourceId}`);
}

/**
 * Every entry named `from` or `name` in a waiting proposal becomes `name` spelled `displayName`; a
 * list that then holds the name twice keeps the first. `instr` on the JSON text narrows the rows
 * (no LIKE wildcards); only lists that really change are written.
 *
 * @param transaction the caller's transaction
 * @param names the source, the target and its spelling
 * @returns nothing
 */
function rewriteProposals(transaction: RenameTransaction, names: RenameNames): void {
  const rows = transaction
    .select({ fileId: fileAnalysisProposal.fileId, tags: fileAnalysisProposal.tags })
    .from(fileAnalysisProposal)
    .where(
      sql`instr(${fileAnalysisProposal.tags}, ${JSON.stringify(names.from)}) > 0 or instr(${fileAnalysisProposal.tags}, ${JSON.stringify(names.name)}) > 0`,
    )
    .all();
  for (const row of rows) {
    const rewritten = rewrittenTags(parseTags(row.tags), names);
    if (rewritten === null) continue;
    transaction
      .update(fileAnalysisProposal)
      .set({ tags: JSON.stringify(rewritten) })
      .where(eq(fileAnalysisProposal.fileId, row.fileId))
      .run();
  }
}

/**
 * One proposal's tags after the rename.
 *
 * @param tags the proposed tags
 * @param names the source, the target and its spelling
 * @returns the rewritten list, the first of a repeated name kept; null when the list does not change
 */
function rewrittenTags(
  tags: { name: string; displayName: string }[],
  names: RenameNames,
): { name: string; displayName: string }[] | null {
  const touched = (entry: { name: string }) => entry.name === names.from || entry.name === names.name;
  const changes = tags.some(
    (entry) => touched(entry) && (entry.name !== names.name || entry.displayName !== names.displayName),
  );
  if (!changes) return null;
  const rewritten: { name: string; displayName: string }[] = [];
  for (const entry of tags) {
    const kept = touched(entry) ? { name: names.name, displayName: names.displayName } : entry;
    if (!rewritten.some((other) => other.name === kept.name)) rewritten.push(kept);
  }
  return rewritten;
}
