import type { FileRecord, TagAssignment, TagSuggestion } from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError, ValidationFailedError, type TagRepository } from '@assetforge/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { toRecords } from './file-records.js';
import { assetTag, file, fileTag, promptTag, tag } from './schema.js';
import { assetOfFile, reindexAsset, reindexAssets, type IndexTransaction } from './search-index.js';
import { ensureTag, linkAssetTag, linkFileTags } from './tag-links.js';
import { renameTag } from './tag-rename.js';

/** Highest code point; sorts after every character that can follow a prefix in a name. */
const PREFIX_END = String.fromCodePoint(0x10ffff);

/** The usage counts of a tag with its display name. */
type TagUsage = { displayName: string; assets: number; files: number; prompts: number };

/**
 * The tag repository over the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createTagRepository(database: BetterSQLite3Database): TagRepository {
  return {
    suggest: (query) => suggestTags(database, query),
    addToAsset: (request) => addToAsset(database, request),
    removeFromAsset: (request) => removeFromAsset(database, request),
    addToFile: (request) => addToFile(database, request),
    removeFromFile: (request) => removeFromFile(database, request),
    addToFiles: (request) => addToFiles(database, request),
    removeFromFiles: (request) => removeFromFiles(database, request),
    listForAsset: (assetId) => listForAsset(database, assetId),
    usage: (name) => tagUsage(database, name),
    rename: (request) => renameTag(database, request),
  };
}

/**
 * The tags whose name starts with the prefix, most used first, then by name.
 *
 * @param database the workspace database
 * @param query the prefix and the limit
 * @returns the suggestions
 */
async function suggestTags(
  database: BetterSQLite3Database,
  { prefix, limit }: Parameters<TagRepository['suggest']>[0],
): Promise<TagSuggestion[]> {
  // A range over the unique name index; LIKE would treat % and _ in the prefix as wildcards.
  // Assignments of files in the trash do not count.
  return database.all<TagSuggestion>(sql`
        select ${tag.name} as name, ${tag.displayName} as displayName
        from ${tag}
        join (
          select ${assetTag.tagId} as tag_id from ${assetTag}
          union all
          select ${fileTag.tagId} as tag_id from ${fileTag}
          join ${file} on ${file.id} = ${fileTag.fileId} and ${file.deletedAt} is null
          union all
          select ${promptTag.tagId} as tag_id from ${promptTag}
        ) as u on u.tag_id = ${tag.id}
        where ${tag.name} >= ${prefix} and ${tag.name} < ${prefix + PREFIX_END}
        group by ${tag.id}
        order by count(*) desc, ${tag.name} asc
        limit ${limit}
      `);
}

/**
 * Adds the tag to the asset, creating it when its name is new, and reindexes the asset.
 *
 * @param database the workspace database
 * @param request the asset, the tag, its origin and the time
 * @returns nothing
 */
async function addToAsset(
  database: BetterSQLite3Database,
  request: Parameters<TagRepository['addToAsset']>[0],
): Promise<void> {
  database.transaction((transaction) => {
    const tagId = ensureTag(transaction, request);
    linkAssetTag(transaction, request.assetId, tagId, request.origin, request.now);
    reindexAsset(transaction, request.assetId);
  });
}

/**
 * Removes the tag from the asset and reindexes the asset.
 *
 * @param database the workspace database
 * @param request the asset and the tag name
 * @returns nothing
 */
async function removeFromAsset(
  database: BetterSQLite3Database,
  request: Parameters<TagRepository['removeFromAsset']>[0],
): Promise<void> {
  database.transaction((transaction) => {
    transaction
      .delete(assetTag)
      .where(and(eq(assetTag.assetId, request.assetId), eq(assetTag.tagId, tagIdOf(request.name))))
      .run();
    reindexAsset(transaction, request.assetId);
  });
}

/**
 * Adds the tag to the file, creating it when its name is new, and reindexes the file's asset.
 *
 * @param database the workspace database
 * @param request the file, the tag, its origin and the time
 * @returns nothing
 */
async function addToFile(
  database: BetterSQLite3Database,
  request: Parameters<TagRepository['addToFile']>[0],
): Promise<void> {
  database.transaction((transaction) => {
    const tagId = ensureTag(transaction, request);
    linkFileTags(transaction, [request.fileId], tagId, request.origin, request.now);
    reindexAssets(transaction, [assetOfFile(transaction, request.fileId)]);
  });
}

/**
 * Removes the tag from the file and reindexes the file's asset.
 *
 * @param database the workspace database
 * @param request the file and the tag name
 * @returns nothing
 */
async function removeFromFile(
  database: BetterSQLite3Database,
  request: Parameters<TagRepository['removeFromFile']>[0],
): Promise<void> {
  database.transaction((transaction) => {
    transaction
      .delete(fileTag)
      .where(and(eq(fileTag.fileId, request.fileId), eq(fileTag.tagId, tagIdOf(request.name))))
      .run();
    reindexAssets(transaction, [assetOfFile(transaction, request.fileId)]);
  });
}

/**
 * Adds the tag to every file of the batch, all or nothing.
 *
 * @param database the workspace database
 * @param request the files, the tag, its origin and the time
 * @returns the records with their current tags, in request order
 */
async function addToFiles(
  database: BetterSQLite3Database,
  request: Parameters<TagRepository['addToFiles']>[0],
): Promise<FileRecord[]> {
  return database.transaction((transaction) => {
    const rows = completeFiles(transaction, request.fileIds);
    const tagId = ensureTag(transaction, request);
    linkFileTags(transaction, request.fileIds, tagId, request.origin, request.now);
    return finishBatch(transaction, rows);
  });
}

/**
 * Removes the tag from every file of the batch, all or nothing.
 *
 * @param database the workspace database
 * @param request the files and the tag name
 * @returns the records with their current tags, in request order
 */
async function removeFromFiles(
  database: BetterSQLite3Database,
  request: Parameters<TagRepository['removeFromFiles']>[0],
): Promise<FileRecord[]> {
  return database.transaction((transaction) => {
    const rows = completeFiles(transaction, request.fileIds);
    transaction
      .delete(fileTag)
      .where(and(inArray(fileTag.fileId, [...request.fileIds]), eq(fileTag.tagId, tagIdOf(request.name))))
      .run();
    return finishBatch(transaction, rows);
  });
}

/**
 * The tags the asset carries itself.
 *
 * @param database the workspace database
 * @param assetId the asset
 * @returns the assignments by name, then origin
 */
async function listForAsset(database: BetterSQLite3Database, assetId: string): Promise<TagAssignment[]> {
  return database
    .select({ name: tag.name, displayName: tag.displayName, origin: assetTag.origin })
    .from(assetTag)
    .innerJoin(tag, eq(tag.id, assetTag.tagId))
    .where(eq(assetTag.assetId, assetId))
    .orderBy(asc(tag.name), asc(assetTag.origin))
    .all();
}

/**
 * How often the tag is used: assets carrying it themselves, files outside the trash and prompts.
 *
 * @param database the workspace database
 * @param name the normalised name
 * @returns the counts with the display name; null for an unknown tag
 */
async function tagUsage(database: BetterSQLite3Database, name: string): Promise<TagUsage | null> {
  const row = database.get<TagUsage | undefined>(sql`
        select t.display_name as displayName,
          (select count(distinct at.asset_id) from asset_tag as at where at.tag_id = t.id) as assets,
          (select count(distinct ft.file_id) from file_tag as ft
            join file as f on f.id = ft.file_id and f.deleted_at is null
            where ft.tag_id = t.id) as files,
          (select count(*) from prompt_tag as pt where pt.tag_id = t.id) as prompts
        from tag as t where t.name = ${name}`);
  return row ?? null;
}

/**
 * A subquery for the id of the tag with the name.
 *
 * @param name the normalised name
 * @returns the subquery
 */
function tagIdOf(name: string) {
  return sql`(select ${tag.id} from ${tag} where ${tag.name} = ${name})`;
}

/**
 * The rows of a batch in request order; throws for an unknown file, then for a file that is not
 * complete and then for a file in the trash, before the caller writes anything.
 *
 * @param transaction the caller's transaction
 * @param fileIds the files of the batch
 * @returns their rows in request order
 */
function completeFiles(
  transaction: Pick<BetterSQLite3Database, 'select'>,
  fileIds: readonly string[],
): (typeof file.$inferSelect)[] {
  const byId = new Map(
    transaction
      .select()
      .from(file)
      .where(inArray(file.id, [...fileIds]))
      .all()
      .map((row) => [row.id, row]),
  );
  const rows = fileIds.map((id) => {
    const row = byId.get(id);
    if (!row) throw new NotFoundError(`File ${id} does not exist`);
    return row;
  });
  const incomplete = rows.find((row) => row.status !== 'complete');
  if (incomplete) throw new ValidationFailedError(`File ${incomplete.id} is not completely imported`);
  if (rows.some((row) => row.deletedAt !== null)) throw new InvalidOperationError('The file is in the trash');
  return rows;
}

/**
 * Reindexes each asset of the batch once.
 *
 * @param transaction the caller's transaction
 * @param rows the rows of the batch
 * @returns the records with their current tags
 */
function finishBatch(transaction: IndexTransaction, rows: (typeof file.$inferSelect)[]): FileRecord[] {
  reindexAssets(
    transaction,
    rows.map((row) => row.assetId),
  );
  return toRecords(transaction, rows);
}
