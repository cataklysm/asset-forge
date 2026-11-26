import type { FileRecord, TagAssignment, TagSuggestion } from '@assetforge/contracts';
import { NotFoundError, ValidationFailedError, type TagRepository } from '@assetforge/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { toRecords } from './file-repository.js';
import { assetTag, file, fileTag, tag } from './schema.js';
import { assetOfFile, reindexAsset, reindexAssets, type Tx } from './search-index.js';

/**
 * The rows of a batch in request order; throws for an unknown file and then for a file that is
 * not complete, before the caller writes anything.
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

export function createTagRepository(db: BetterSQLite3Database): TagRepository {
  return {
    async suggest({ prefix, limit }): Promise<TagSuggestion[]> {
      // A range over the unique name index; LIKE would treat % and _ in the prefix as wildcards.
      return db.all<TagSuggestion>(sql`
        select ${tag.name} as name, ${tag.displayName} as displayName
        from ${tag}
        join (
          select ${assetTag.tagId} as tag_id from ${assetTag}
          union all
          select ${fileTag.tagId} as tag_id from ${fileTag}
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
        tx.insert(assetTag)
          .values({ assetId: r.assetId, tagId, origin: r.origin, createdAt: r.now })
          .onConflictDoNothing()
          .run();
        reindexAsset(tx, r.assetId);
      });
    },
    async removeFromAsset(r) {
      db.transaction((tx) => {
        tx.delete(assetTag)
          .where(
            and(
              eq(assetTag.assetId, r.assetId),
              eq(assetTag.origin, r.origin),
              eq(assetTag.tagId, sql`(select ${tag.id} from ${tag} where ${tag.name} = ${r.name})`),
            ),
          )
          .run();
        reindexAsset(tx, r.assetId);
      });
    },
    async addToFile(r) {
      db.transaction((tx) => {
        const tagId = ensureTag(tx, r);
        tx.insert(fileTag)
          .values({ fileId: r.fileId, tagId, origin: r.origin, createdAt: r.now })
          .onConflictDoNothing()
          .run();
        reindexAssets(tx, [assetOfFile(tx, r.fileId)]);
      });
    },
    async removeFromFile(r) {
      db.transaction((tx) => {
        tx.delete(fileTag)
          .where(
            and(
              eq(fileTag.fileId, r.fileId),
              eq(fileTag.origin, r.origin),
              eq(fileTag.tagId, sql`(select ${tag.id} from ${tag} where ${tag.name} = ${r.name})`),
            ),
          )
          .run();
        reindexAssets(tx, [assetOfFile(tx, r.fileId)]);
      });
    },
    async addToFiles(r): Promise<FileRecord[]> {
      return db.transaction((tx) => {
        const rows = completeFiles(tx, r.fileIds);
        const tagId = ensureTag(tx, r);
        tx.insert(fileTag)
          .values(rows.map((row) => ({ fileId: row.id, tagId, origin: r.origin, createdAt: r.now })))
          .onConflictDoNothing()
          .run();
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
              eq(fileTag.origin, r.origin),
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
