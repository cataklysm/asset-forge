import { eq, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { parseTags } from './proposal-tags.js';
import { fileAnalysisProposal } from './schema.js';

/** Table and owner column of a link table; constants, never user input. */
type LinkTable = { table: SQL; owner: SQL };
export const ASSET_LINKS: LinkTable = { table: sql.raw('asset_tag'), owner: sql.raw('asset_id') };
export const FILE_LINKS: LinkTable = { table: sql.raw('file_tag'), owner: sql.raw('file_id') };

type RenameTx = Pick<BetterSQLite3Database, 'select' | 'insert' | 'update' | 'delete' | 'run' | 'all' | 'get'>;

/** The assets whose index holds the tag: those carrying it and those with a file carrying it. */
export function affectedAssets(tx: RenameTx, tagId: string): string[] {
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
export function mergeLinks(tx: RenameTx, { table, owner }: LinkTable, sourceId: string, targetId: string): void {
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
export function mergePromptLinks(tx: RenameTx, sourceId: string, targetId: string): void {
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
export function rewriteProposals(tx: RenameTx, r: { from: string; name: string; displayName: string }): void {
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
