import { PromptVersionSchema, type PromptSummary, type PromptVariable, type PromptVersion, type TagAssignment } from '@assetforge/contracts';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { prompt, promptTag, promptVersion, tag } from './schema.js';

export type Tx = Pick<BetterSQLite3Database, 'select'>;
export type VersionRow = typeof promptVersion.$inferSelect;
export type PromptRow = typeof prompt.$inferSelect;

const ItemsSchema = PromptVersionSchema.shape.variables;

/** The `variables` column as stored. */
export const variablesColumn = (items: readonly PromptVariable[]): string => JSON.stringify({ v: 1, items });

/** A column that does not parse reads as an empty list. */
function parseVariables(text: string): PromptVariable[] {
  try {
    const column: unknown = JSON.parse(text);
    if (typeof column !== 'object' || column === null || (column as { v?: unknown }).v !== 1) return [];
    const parsed = ItemsSchema.safeParse((column as { items?: unknown }).items);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export const toVersion = (row: VersionRow): PromptVersion => ({
  id: row.id,
  number: row.number,
  content: row.content,
  variables: parseVariables(row.variables),
  createdAt: row.createdAt,
});

/** The tags of these prompts by prompt id, by name. */
export function tagsOf(tx: Tx, promptIds: readonly string[]): Map<string, TagAssignment[]> {
  const result = new Map<string, TagAssignment[]>();
  if (promptIds.length === 0) return result;
  const rows = tx
    .select({ promptId: promptTag.promptId, name: tag.name, displayName: tag.displayName })
    .from(promptTag)
    .innerJoin(tag, eq(tag.id, promptTag.tagId))
    .where(inArray(promptTag.promptId, [...promptIds]))
    .orderBy(asc(tag.name))
    .all();
  for (const r of rows) {
    const list = result.get(r.promptId) ?? [];
    list.push({ name: r.name, displayName: r.displayName, origin: 'manual' });
    result.set(r.promptId, list);
  }
  return result;
}

/** The highest-numbered version of a prompt, as a correlated subquery condition on `promptVersion`. */
export const isCurrent = sql`${promptVersion.number} = (select max(v.number) from prompt_version as v where v.prompt_id = ${promptVersion.promptId})`;

/** The current version of each of these prompts by prompt id. */
export function currentVersionsOf(tx: Tx, promptIds: readonly string[]): Map<string, PromptVersion> {
  if (promptIds.length === 0) return new Map();
  const rows = tx
    .select()
    .from(promptVersion)
    .where(and(inArray(promptVersion.promptId, [...promptIds]), isCurrent))
    .all();
  return new Map(rows.map((row) => [row.promptId, toVersion(row)]));
}

export function summaries(tx: Tx, rows: readonly PromptRow[]): PromptSummary[] {
  const ids = rows.map((r) => r.id);
  const tags = tagsOf(tx, ids);
  const current = currentVersionsOf(tx, ids);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    tags: tags.get(r.id) ?? [],
    // Every prompt is written with version 1 in the same transaction.
    currentVersion: current.get(r.id)!,
    updatedAt: r.updatedAt,
  }));
}

/**
 * The folded word as a literal substring of the folded title, description, current content or a tag display name,
 * like the project and file lists (`af_fold` is `foldSearchWord`).
 */
export function matchesWord(word: string): SQL {
  return sql`(
    instr(af_fold(${prompt.title}), ${word}) > 0
    or instr(af_fold(${prompt.description}), ${word}) > 0
    or instr(af_fold((select v.content from prompt_version as v where v.prompt_id = ${prompt.id} order by v.number desc limit 1)), ${word}) > 0
    or exists (
      select 1 from prompt_tag as pt join tag as t on t.id = pt.tag_id
      where pt.prompt_id = ${prompt.id} and instr(af_fold(t.display_name), ${word}) > 0))`;
}

export const carriesTag = (name: string): SQL =>
  sql`exists (select 1 from prompt_tag as pt join tag as t on t.id = pt.tag_id where pt.prompt_id = ${prompt.id} and t.name = ${name})`;

