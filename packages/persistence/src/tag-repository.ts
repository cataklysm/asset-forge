import type { FileRecord, TagAssignment, TagOrigin, TagSuggestion } from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError, ValidationFailedError, type TagRepository } from '@assetforge/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { toRecords } from './file-repository.js';
import { assetTag, file, fileTag, tag } from './schema.js';
import { assetOfFile, reindexAsset, reindexAssets, type Tx } from './search-index.js';

/**
 * The rows of a batch in request order; throws for an unknown file, then for a file that is not
 * complete and then for a file in the trash, before the caller writes anything.
 */
function completeFiles(tx: Pick<BetterSQLite3Database, 'select'>, fileIds: readonly string[]): (typeof file.$inferSelect)[] {
  const byId = new Map(
    tx
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

/** Reindexes each asset of the batch once and returns the records with their current tags. */
function finishBatch(tx: Tx, rows: (typeof file.$inferSelect)[]): FileRecord[] {
  reindexAssets(
    tx,
    rows.map((row) => row.assetId),
  );
  return toRecords(tx, rows);
}

/** Highest code point; sorts after every character that can follow a prefix in a name. */
const PREFIX_END = String.fromCodePoint(0x10ffff);

/** Inserts the tag unless its name exists and returns the id of the tag with that name. */
export function ensureTag(
  tx: Pick<BetterSQLite3Database, 'insert' | 'select'>,
  r: { name: string; displayName: string; newId: string; now: string },
): string {
  tx.insert(tag)
    .values({ id: r.newId, name: r.name, displayName: r.displayName, createdAt: r.now })
    .onConflictDoNothing({ target: tag.name })
    .run();
  return tx.select({ id: tag.id }).from(tag).where(eq(tag.name, r.name)).get()!.id;
}

type Writer = Pick<BetterSQLite3Database, 'insert' | 'delete' | 'select'>;

/** An owner carries a tag at most once and manual wins: a manual add replaces an ai link, an ai add yields to any link. */
function linkAssetTag(tx: Writer, assetId: string, tagId: string, origin: TagOrigin, now: string): void {
  if (origin === 'manual') {
    tx.delete(assetTag).where(and(eq(assetTag.assetId, assetId), eq(assetTag.tagId, tagId), eq(assetTag.origin, 'ai'))).run();
  }
  const carried = tx.select({ tagId: assetTag.tagId }).from(assetTag).where(and(eq(assetTag.assetId, assetId), eq(assetTag.tagId, tagId))).get();
  if (!carried) tx.insert(assetTag).values({ assetId, tagId, origin, createdAt: now }).run();
}

/** Same rule as `linkAssetTag`, for each file of the list. */
function linkFileTags(tx: Writer, fileIds: readonly string[], tagId: string, origin: TagOrigin, now: string): void {
  const ids = [...new Set(fileIds)];
  if (origin === 'manual') {
    tx.delete(fileTag).where(and(inArray(fileTag.fileId, ids), eq(fileTag.tagId, tagId), eq(fileTag.origin, 'ai'))).run();
  }
  const carried = new Set(
    tx
      .select({ fileId: fileTag.fileId })
      .from(fileTag)
      .where(and(inArray(fileTag.fileId, ids), eq(fileTag.tagId, tagId)))
      .all()
      .map((row) => row.fileId),
  );
  const fresh = ids.filter((id) => !carried.has(id));
  if (fresh.length > 0) tx.insert(fileTag).values(fresh.map((fileId) => ({ fileId, tagId, origin, createdAt: now }))).run();
}

export function createTagRepository(db: BetterSQLite3Database): TagRepository {
  return {
    async suggest({ prefix, limit }): Promise<TagSuggestion[]> {
      // A range over the unique name index; LIKE would treat % and _ in the prefix as wildcards.
      // Assignments of files in the trash do not count.
      return db.all<TagSuggestion>(sql`
        select ${tag.name} as name, ${tag.displayName} as displayName
        from ${tag}
        join (
          select ${assetTag.tagId} as tag_id from ${assetTag}
          union all
          select ${fileTag.tagId} as tag_id from ${fileTag}
          join ${file} on ${file.id} = ${fileTag.fileId} and ${file.deletedAt} is null
        ) as u on u.tag_id = ${tag.id}
        where ${tag.name} >= ${prefix} and ${tag.name} < ${prefix + PREFIX_END}
        group by ${tag.id}
        order by count(*) desc, ${tag.name} asc
        limit ${limit}
      `);
    },
    async addToAsset(r) {
      db.transaction((tx) => {
        const tagId = ensureTag(tx, r);
        linkAssetTag(tx, r.assetId, tagId, r.origin, r.now);
        reindexAsset(tx, r.assetId);
      });
    },
    async removeFromAsset(r) {
      db.transaction((tx) => {
        tx.delete(assetTag)
          .where(and(eq(assetTag.assetId, r.assetId), eq(assetTag.tagId, sql`(select ${tag.id} from ${tag} where ${tag.name} = ${r.name})`)))
          .run();
        reindexAsset(tx, r.assetId);
      });
    },
    async addToFile(r) {
      db.transaction((tx) => {
        const tagId = ensureTag(tx, r);
        linkFileTags(tx, [r.fileId], tagId, r.origin, r.now);
        reindexAssets(tx, [assetOfFile(tx, r.fileId)]);
      });
    },
    async removeFromFile(r) {
      db.transaction((tx) => {
        tx.delete(fileTag)
          .where(and(eq(fileTag.fileId, r.fileId), eq(fileTag.tagId, sql`(select ${tag.id} from ${tag} where ${tag.name} = ${r.name})`)))
          .run();
        reindexAssets(tx, [assetOfFile(tx, r.fileId)]);
      });
    },
    async addToFiles(r): Promise<FileRecord[]> {
      return db.transaction((tx) => {
        const rows = completeFiles(tx, r.fileIds);
        const tagId = ensureTag(tx, r);
        linkFileTags(tx, r.fileIds, tagId, r.origin, r.now);
        return finishBatch(tx, rows);
      });
    },
    async removeFromFiles(r): Promise<FileRecord[]> {
      return db.transaction((tx) => {
        const rows = completeFiles(tx, r.fileIds);
        tx.delete(fileTag)
          .where(
            and(
              inArray(fileTag.fileId, [...r.fileIds]),
              eq(fileTag.tagId, sql`(select ${tag.id} from ${tag} where ${tag.name} = ${r.name})`),
            ),
          )
          .run();
        return finishBatch(tx, rows);
      });
    },
    async listForAsset(assetId): Promise<TagAssignment[]> {
      return db
        .select({ name: tag.name, displayName: tag.displayName, origin: assetTag.origin })
        .from(assetTag)
        .innerJoin(tag, eq(tag.id, assetTag.tagId))
        .where(eq(assetTag.assetId, assetId))
        .orderBy(asc(tag.name), asc(assetTag.origin))
        .all();
    },
  };
}
