import { PromptVersionSchema, type PromptDetail, type PromptSummary, type PromptVariable, type PromptVersion, type TagAssignment } from '@assetforge/contracts';
import type { PromptRepository } from '@assetforge/core';
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { prompt, promptTag, promptVersion, tag } from './schema.js';
import { ensureTag } from './tag-repository.js';

type Tx = Pick<BetterSQLite3Database, 'select'>;
type VersionRow = typeof promptVersion.$inferSelect;
type PromptRow = typeof prompt.$inferSelect;

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

const toVersion = (row: VersionRow): PromptVersion => ({
  id: row.id,
  number: row.number,
  content: row.content,
  variables: parseVariables(row.variables),
  createdAt: row.createdAt,
});

/** The tags of these prompts by prompt id, by name. */
function tagsOf(tx: Tx, promptIds: readonly string[]): Map<string, TagAssignment[]> {
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
const isCurrent = sql`${promptVersion.number} = (select max(v.number) from prompt_version as v where v.prompt_id = ${promptVersion.promptId})`;

/** The current version of each of these prompts by prompt id. */
function currentVersionsOf(tx: Tx, promptIds: readonly string[]): Map<string, PromptVersion> {
  if (promptIds.length === 0) return new Map();
  const rows = tx
    .select()
    .from(promptVersion)
    .where(and(inArray(promptVersion.promptId, [...promptIds]), isCurrent))
    .all();
  return new Map(rows.map((row) => [row.promptId, toVersion(row)]));
}

function summaries(tx: Tx, rows: readonly PromptRow[]): PromptSummary[] {
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
function matchesWord(word: string): SQL {
  return sql`(
    instr(af_fold(${prompt.title}), ${word}) > 0
    or instr(af_fold(${prompt.description}), ${word}) > 0
    or instr(af_fold((select v.content from prompt_version as v where v.prompt_id = ${prompt.id} order by v.number desc limit 1)), ${word}) > 0
    or exists (
      select 1 from prompt_tag as pt join tag as t on t.id = pt.tag_id
      where pt.prompt_id = ${prompt.id} and instr(af_fold(t.display_name), ${word}) > 0))`;
}

const carriesTag = (name: string): SQL =>
  sql`exists (select 1 from prompt_tag as pt join tag as t on t.id = pt.tag_id where pt.prompt_id = ${prompt.id} and t.name = ${name})`;

export function createPromptRepository(db: BetterSQLite3Database): PromptRepository {
  const read = <T>(work: (tx: Tx) => T): T => db.transaction(work, { behavior: 'deferred' });

  const exists = (tx: Tx, id: string): boolean => tx.select({ id: prompt.id }).from(prompt).where(eq(prompt.id, id)).get() !== undefined;

  return {
    async create(r): Promise<boolean> {
      return db.transaction((tx) => {
        const taken = tx.select({ id: prompt.id }).from(prompt).where(eq(prompt.titleKey, r.titleKey)).get();
        if (taken) return false;
        tx.insert(prompt)
          .values({ id: r.id, title: r.title, titleKey: r.titleKey, description: r.description, createdAt: r.now, updatedAt: r.now })
          .run();
        tx.insert(promptVersion)
          .values({
            id: r.version.id,
            promptId: r.id,
            number: 1,
            content: r.version.content,
            variables: variablesColumn(r.version.variables),
            createdAt: r.now,
          })
          .run();
        return true;
      });
    },
    async update(r) {
      return db.transaction((tx) => {
        if (!exists(tx, r.id)) return 'missing' as const;
        const holder = tx.select({ id: prompt.id }).from(prompt).where(eq(prompt.titleKey, r.titleKey)).get();
        if (holder && holder.id !== r.id) return 'title_taken' as const;
        tx.update(prompt)
          .set({ title: r.title, titleKey: r.titleKey, description: r.description, updatedAt: r.now })
          .where(eq(prompt.id, r.id))
          .run();
        return 'ok' as const;
      });
    },
    async get(id): Promise<PromptDetail | null> {
      return read((tx) => {
        const row = tx.select().from(prompt).where(eq(prompt.id, id)).get();
        if (!row) return null;
        const versions = tx
          .select()
          .from(promptVersion)
          .where(eq(promptVersion.promptId, id))
          .orderBy(desc(promptVersion.number))
          .all()
          .map(toVersion);
        return { ...summaries(tx, [row])[0]!, versions, createdAt: row.createdAt };
      });
    },
    async getVersion(versionId) {
      const row = db
        .select({ v: promptVersion, title: prompt.title })
        .from(promptVersion)
        .innerJoin(prompt, eq(prompt.id, promptVersion.promptId))
        .where(eq(promptVersion.id, versionId))
        .get();
      return row ? { promptId: row.v.promptId, title: row.title, version: toVersion(row.v) } : null;
    },
    async addVersion(r) {
      return db.transaction((tx) => {
        if (!exists(tx, r.promptId)) return 'missing' as const;
        const current = tx.select().from(promptVersion).where(and(eq(promptVersion.promptId, r.promptId), isCurrent)).get()!;
        if (current.id !== r.baseVersionId) return 'stale' as const;
        tx.insert(promptVersion)
          .values({
            id: r.version.id,
            promptId: r.promptId,
            number: current.number + 1,
            content: r.version.content,
            variables: variablesColumn(r.version.variables),
            createdAt: r.now,
          })
          .run();
        tx.update(prompt).set({ updatedAt: r.now }).where(eq(prompt.id, r.promptId)).run();
        return 'ok' as const;
      });
    },
    async remove(id): Promise<boolean> {
      // Versions and tag links go through their `cascade` rule; generations' `prompt_version_id` through `set null`.
      return db.delete(prompt).where(eq(prompt.id, id)).run().changes > 0;
    },
    async list(q) {
      return read((tx) => {
        const where = and(...q.words.map(matchesWord), ...q.tagNames.map(carriesTag));
        const total = tx.select({ n: count() }).from(prompt).where(where).get()?.n ?? 0;
        const rows = tx
          .select()
          .from(prompt)
          .where(where)
          .orderBy(desc(prompt.updatedAt), asc(prompt.id))
          .limit(q.limit)
          .offset(q.offset)
          .all();
        return { items: summaries(tx, rows), total };
      });
    },
    async addTag(r) {
      return db.transaction((tx) => {
        if (!exists(tx, r.promptId)) return 'missing' as const;
        const links = tx
          .select({ name: tag.name })
          .from(promptTag)
          .innerJoin(tag, eq(tag.id, promptTag.tagId))
          .where(eq(promptTag.promptId, r.promptId))
          .all();
        if (links.some((l) => l.name === r.name)) return 'ok' as const;
        if (links.length >= r.max) return 'limit' as const;
        const tagId = ensureTag(tx, r);
        tx.insert(promptTag).values({ promptId: r.promptId, tagId, createdAt: r.now }).run();
        tx.update(prompt).set({ updatedAt: r.now }).where(eq(prompt.id, r.promptId)).run();
        return 'ok' as const;
      });
    },
    async removeTag(r) {
      return db.transaction((tx) => {
        if (!exists(tx, r.promptId)) return 'missing' as const;
        const removed = tx
          .delete(promptTag)
          .where(
            and(eq(promptTag.promptId, r.promptId), eq(promptTag.tagId, sql`(select ${tag.id} from ${tag} where ${tag.name} = ${r.name})`)),
          )
          .run().changes;
        if (removed > 0) tx.update(prompt).set({ updatedAt: r.now }).where(eq(prompt.id, r.promptId)).run();
        return 'ok' as const;
      });
    },
  };
}
