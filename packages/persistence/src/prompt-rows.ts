import { PromptVersionSchema, type PromptSummary, type PromptVariable, type PromptVersion, type TagAssignment } from '@assetforge/contracts';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { prompt, promptTag, promptVersion, tag } from './schema.js';

// Prompt rows as the contracts describe them: versions, tags, summaries and the list conditions.

/** What reading prompts needs of a database or transaction handle. */
export type PromptReader = Pick<BetterSQLite3Database, 'select'>;
/** A `prompt_version` row. */
export type VersionRow = typeof promptVersion.$inferSelect;
/** A `prompt` row. */
export type PromptRow = typeof prompt.$inferSelect;

const VariablesSchema = PromptVersionSchema.shape.variables;

/**
 * The `variables` column as stored.
 *
 * @param items the variables of a version
 * @returns the column text
 */
export const variablesColumn = (items: readonly PromptVariable[]): string => JSON.stringify({ v: 1, items });

/**
 * The variables of a stored column. A column that does not parse reads as an empty list.
 *
 * @param text the column text
 * @returns the variables
 */
function parseVariables(text: string): PromptVariable[] {
  try {
    const column: unknown = JSON.parse(text);
    if (typeof column !== 'object' || column === null || (column as { v?: unknown }).v !== 1) return [];
    const parsed = VariablesSchema.safeParse((column as { items?: unknown }).items);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * The version of a row.
 *
 * @param row the version row
 * @returns the version
 */
export const toVersion = (row: VersionRow): PromptVersion => ({
  id: row.id,
  number: row.number,
  content: row.content,
  variables: parseVariables(row.variables),
  createdAt: row.createdAt,
});

/**
 * The tags of these prompts by prompt id, by name.
 *
 * @param reader the database or the caller's transaction
 * @param promptIds the prompts
 * @returns the tags by prompt id; prompts without tags are missing
 */
function tagsOf(reader: PromptReader, promptIds: readonly string[]): Map<string, TagAssignment[]> {
  const result = new Map<string, TagAssignment[]>();
  if (promptIds.length === 0) return result;
  const rows = reader
    .select({ promptId: promptTag.promptId, name: tag.name, displayName: tag.displayName })
    .from(promptTag)
    .innerJoin(tag, eq(tag.id, promptTag.tagId))
    .where(inArray(promptTag.promptId, [...promptIds]))
    .orderBy(asc(tag.name))
    .all();
  for (const row of rows) {
    const list = result.get(row.promptId) ?? [];
    list.push({ name: row.name, displayName: row.displayName, origin: 'manual' });
    result.set(row.promptId, list);
  }
  return result;
}

/** The highest-numbered version of a prompt, as a correlated subquery condition on `promptVersion`. */
export const isCurrent = sql`${promptVersion.number} = (select max(v.number) from prompt_version as v where v.prompt_id = ${promptVersion.promptId})`;

/**
 * The current version of each of these prompts by prompt id.
 *
 * @param reader the database or the caller's transaction
 * @param promptIds the prompts
 * @returns the versions by prompt id
 */
function currentVersionsOf(reader: PromptReader, promptIds: readonly string[]): Map<string, PromptVersion> {
  if (promptIds.length === 0) return new Map();
  const rows = reader
    .select()
    .from(promptVersion)
    .where(and(inArray(promptVersion.promptId, [...promptIds]), isCurrent))
    .all();
  return new Map(rows.map((row) => [row.promptId, toVersion(row)]));
}

/**
 * The summaries of the prompt rows with their tags and current versions.
 *
 * @param reader the database or the caller's transaction
 * @param rows the prompt rows
 * @returns the summaries in row order
 */
export function promptSummaries(reader: PromptReader, rows: readonly PromptRow[]): PromptSummary[] {
  const ids = rows.map((row) => row.id);
  const tags = tagsOf(reader, ids);
  const current = currentVersionsOf(reader, ids);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    tags: tags.get(row.id) ?? [],
    // Every prompt is written with version 1 in the same transaction.
    currentVersion: current.get(row.id)!,
    updatedAt: row.updatedAt,
  }));
}

/**
 * The folded word as a literal substring of the folded title, description, current content or a tag display name,
 * like the project and file lists (`af_fold` is `foldSearchWord`).
 *
 * @param word a folded search word
 * @returns the condition over the outer prompt row
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

/**
 * The outer prompt carries the tag.
 *
 * @param name the normalised tag name
 * @returns the condition over the outer prompt row
 */
export const carriesTag = (name: string): SQL =>
  sql`exists (select 1 from prompt_tag as pt join tag as t on t.id = pt.tag_id where pt.prompt_id = ${prompt.id} and t.name = ${name})`;
