import type { FileRecord, TagAssignment, TagOrigin, TagSuggestion } from '@assetforge/contracts';
import { InvalidOperationError, NotFoundError, ValidationFailedError, type TagRepository } from '@assetforge/core';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { toRecords } from './file-repository.js';
import { parseTags } from './proposal-tags.js';
import { assetTag, file, fileAnalysisProposal, fileTag, promptTag, tag } from './schema.js';
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

/** Table and owner column of a link table; constants, never user input. */
type LinkTable = { table: SQL; owner: SQL };
const ASSET_LINKS: LinkTable = { table: sql.raw('asset_tag'), owner: sql.raw('asset_id') };
const FILE_LINKS: LinkTable = { table: sql.raw('file_tag'), owner: sql.raw('file_id') };

type RenameTx = Pick<BetterSQLite3Database, 'select' | 'insert' | 'update' | 'delete' | 'run' | 'all' | 'get'>;

/** The assets whose index holds the tag: those carrying it and those with a file carrying it. */
function affectedAssets(tx: RenameTx, tagId: string): string[] {
  return tx
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
 */
function mergeLinks(tx: RenameTx, { table, owner }: LinkTable, sourceId: string, targetId: string): void {
  tx.run(sql`
    update ${table} set origin = 'manual'
    where tag_id = ${targetId} and origin = 'ai'
      and ${owner} in (select s.${owner} from ${table} as s where s.tag_id = ${sourceId} and s.origin = 'manual')
      and ${owner} not in (select m.${owner} from ${table} as m where m.tag_id = ${targetId} and m.origin = 'manual')`);
  tx.run(sql`
    update ${table} set created_at = (
      select min(s.created_at) from ${table} as s where s.tag_id = ${sourceId} and s.${owner} = ${table}.${owner})
    where tag_id = ${targetId}
      and created_at > (select min(s.created_at) from ${table} as s where s.tag_id = ${sourceId} and s.${owner} = ${table}.${owner})`);
  tx.run(sql`
    delete from ${table}
    where tag_id = ${sourceId} and ${owner} in (select t.${owner} from ${table} as t where t.tag_id = ${targetId})`);
  tx.run(sql`update ${table} set tag_id = ${targetId} where tag_id = ${sourceId}`);
}

/**
 * Like `mergeLinks` for prompt links, which have no origin: a prompt carrying both keeps its
 * target link dated to the earlier of the two; a link that only moves keeps its createdAt.
 * Prompts keep their `updated_at`.
 */
function mergePromptLinks(tx: RenameTx, sourceId: string, targetId: string): void {
  tx.run(sql`
    update prompt_tag set created_at = (
      select s.created_at from prompt_tag as s where s.tag_id = ${sourceId} and s.prompt_id = prompt_tag.prompt_id)
    where tag_id = ${targetId}
      and created_at > (select s.created_at from prompt_tag as s where s.tag_id = ${sourceId} and s.prompt_id = prompt_tag.prompt_id)`);
  tx.run(sql`
    delete from prompt_tag
    where tag_id = ${sourceId} and prompt_id in (select t.prompt_id from prompt_tag as t where t.tag_id = ${targetId})`);
  tx.run(sql`update prompt_tag set tag_id = ${targetId} where tag_id = ${sourceId}`);
}

/**
 * Every entry named `from` or `name` in a waiting proposal becomes `name` spelled `displayName`; a
 * list that then holds the name twice keeps the first. `instr` on the JSON text narrows the rows
 * (no LIKE wildcards); only lists that really change are written.
 */
function rewriteProposals(tx: RenameTx, r: { from: string; name: string; displayName: string }): void {
  const rows = tx
    .select({ fileId: fileAnalysisProposal.fileId, tags: fileAnalysisProposal.tags })
    .from(fileAnalysisProposal)
    .where(
      sql`instr(${fileAnalysisProposal.tags}, ${JSON.stringify(r.from)}) > 0 or instr(${fileAnalysisProposal.tags}, ${JSON.stringify(r.name)}) > 0`,
    )
    .all();
  for (const row of rows) {
    const tags = parseTags(row.tags);
    const touched = (t: { name: string }) => t.name === r.from || t.name === r.name;
    if (!tags.some((t) => touched(t) && (t.name !== r.name || t.displayName !== r.displayName))) continue;
    const rewritten: { name: string; displayName: string }[] = [];
    for (const t of tags) {
      const entry = touched(t) ? { name: r.name, displayName: r.displayName } : t;
      if (!rewritten.some((x) => x.name === entry.name)) rewritten.push(entry);
    }
    tx.update(fileAnalysisProposal).set({ tags: JSON.stringify(rewritten) }).where(eq(fileAnalysisProposal.fileId, row.fileId)).run();
  }
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
