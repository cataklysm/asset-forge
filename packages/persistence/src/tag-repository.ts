import type { FileRecord, TagAssignment, TagSuggestion } from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError, ValidationFailedError, type TagRepository } from '@assetforge/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { toRecords } from './file-records.js';
import { assetTag, file, fileTag, promptTag, tag } from './schema.js';
import { assetOfFile, reindexAsset, reindexAssets, type Tx } from './search-index.js';
import { ensureTag, linkAssetTag, linkFileTags } from './tag-links.js';
import { ASSET_LINKS, FILE_LINKS, affectedAssets, mergeLinks, mergePromptLinks, rewriteProposals } from './tag-rename.js';

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
          union all
          select ${promptTag.tagId} as tag_id from ${promptTag}
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
    async usage(name): Promise<{ displayName: string; assets: number; files: number; prompts: number } | null> {
      const row = db.get<{ displayName: string; assets: number; files: number; prompts: number } | undefined>(sql`
        select t.display_name as displayName,
          (select count(distinct at.asset_id) from asset_tag as at where at.tag_id = t.id) as assets,
          (select count(distinct ft.file_id) from file_tag as ft
            join file as f on f.id = ft.file_id and f.deleted_at is null
            where ft.tag_id = t.id) as files,
          (select count(*) from prompt_tag as pt where pt.tag_id = t.id) as prompts
        from tag as t where t.name = ${name}`);
      return row ?? null;
    },
    async rename(r): Promise<{ merged: boolean }> {
      return db.transaction((tx) => {
        const source = tx.select().from(tag).where(eq(tag.name, r.from)).get();
        if (!source) throw new NotFoundError('Tag does not exist');
        if (r.from === r.name) {
          // Only how the name is written changes; the index holds normalised names.
          if (source.displayName !== r.displayName) {
            tx.update(tag).set({ displayName: r.displayName }).where(eq(tag.id, source.id)).run();
            rewriteProposals(tx, r);
          }
          return { merged: false };
        }
        const target = tx.select().from(tag).where(eq(tag.name, r.name)).get();
        if (target && !r.merge) throw new InvalidOperationError('A tag with this name already exists');

        const affected = affectedAssets(tx, source.id);
        if (target) {
          mergeLinks(tx, ASSET_LINKS, source.id, target.id);
          mergeLinks(tx, FILE_LINKS, source.id, target.id);
          mergePromptLinks(tx, source.id, target.id);
          // The foreign keys have no `on delete`: the links are gone or repointed before this.
          tx.delete(tag).where(eq(tag.id, source.id)).run();
          tx.update(tag).set({ displayName: r.displayName }).where(eq(tag.id, target.id)).run();
        } else {
          tx.update(tag).set({ name: r.name, displayName: r.displayName }).where(eq(tag.id, source.id)).run();
        }
        rewriteProposals(tx, r);
        reindexAssets(tx, affected);
        return { merged: target !== undefined };
      });
    },
  };
}
