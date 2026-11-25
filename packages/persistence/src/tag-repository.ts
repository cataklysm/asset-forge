import type { TagAssignment, TagSuggestion } from '@assetforge/contracts';
import type { TagRepository } from '@assetforge/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { assetTag, fileTag, tag } from './schema.js';

/** Highest code point; sorts after every character that can follow a prefix in a name. */
const PREFIX_END = String.fromCodePoint(0x10ffff);

export function createTagRepository(db: BetterSQLite3Database): TagRepository {
  /** Inserts the tag unless its name exists and returns the id of the tag with that name. */
  const ensureTag = (
    tx: Pick<BetterSQLite3Database, 'insert' | 'select'>,
    r: { name: string; displayName: string; newId: string; now: string },
  ): string => {
    tx.insert(tag)
      .values({ id: r.newId, name: r.name, displayName: r.displayName, createdAt: r.now })
      .onConflictDoNothing({ target: tag.name })
      .run();
    return tx.select({ id: tag.id }).from(tag).where(eq(tag.name, r.name)).get()!.id;
  };

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
      });
    },
    async removeFromAsset(r) {
      db.delete(assetTag)
        .where(
          and(
            eq(assetTag.assetId, r.assetId),
            eq(assetTag.origin, r.origin),
            eq(assetTag.tagId, sql`(select ${tag.id} from ${tag} where ${tag.name} = ${r.name})`),
          ),
        )
        .run();
    },
    async addToFile(r) {
      db.transaction((tx) => {
        const tagId = ensureTag(tx, r);
        tx.insert(fileTag)
          .values({ fileId: r.fileId, tagId, origin: r.origin, createdAt: r.now })
          .onConflictDoNothing()
          .run();
      });
    },
    async removeFromFile(r) {
      db.delete(fileTag)
        .where(
          and(
            eq(fileTag.fileId, r.fileId),
            eq(fileTag.origin, r.origin),
            eq(fileTag.tagId, sql`(select ${tag.id} from ${tag} where ${tag.name} = ${r.name})`),
          ),
        )
        .run();
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
