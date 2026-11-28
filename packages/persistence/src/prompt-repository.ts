import type { PromptDetail } from '@assetforge/contracts';
import type { PromptRepository } from '@assetforge/core';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  carriesTag,
  isCurrent,
  matchesWord,
  promptSummaries,
  toVersion,
  variablesColumn,
  type PromptReader,
} from './prompt-rows.js';
import { prompt, promptTag, promptVersion, tag } from './schema.js';
import { ensureTag } from './tag-links.js';

/**
 * The prompt repository over the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createPromptRepository(database: BetterSQLite3Database): PromptRepository {
  return {
    create: (request) => createPrompt(database, request),
    update: (request) => updatePrompt(database, request),
    get: (id) => getPrompt(database, id),
    getVersion: (versionId) => getVersion(database, versionId),
    addVersion: (request) => addVersion(database, request),
    remove: (id) => removePrompt(database, id),
    list: (query) => listPrompts(database, query),
    addTag: (request) => addTag(database, request),
    removeTag: (request) => removeTag(database, request),
  };
}

/**
 * Runs the work in one deferred read transaction.
 *
 * @param database the workspace database
 * @param work the reads
 * @returns what the work returns
 */
function readTransaction<T>(database: BetterSQLite3Database, work: (transaction: PromptReader) => T): T {
  return database.transaction(work, { behavior: 'deferred' });
}

/**
 * Whether the prompt exists.
 *
 * @param reader the caller's transaction
 * @param id the prompt
 * @returns true when it exists
 */
function exists(reader: PromptReader, id: string): boolean {
  return reader.select({ id: prompt.id }).from(prompt).where(eq(prompt.id, id)).get() !== undefined;
}

/**
 * Inserts the prompt with its version 1 unless its title is taken.
 *
 * @param database the workspace database
 * @param request the prompt, its first version and the time
 * @returns false when the title is taken
 */
async function createPrompt(
  database: BetterSQLite3Database,
  request: Parameters<PromptRepository['create']>[0],
): Promise<boolean> {
  return database.transaction((transaction) => {
    const taken = transaction.select({ id: prompt.id }).from(prompt).where(eq(prompt.titleKey, request.titleKey)).get();
    if (taken) return false;
    transaction
      .insert(prompt)
      .values({
        id: request.id,
        title: request.title,
        titleKey: request.titleKey,
        description: request.description,
        createdAt: request.now,
        updatedAt: request.now,
      })
      .run();
    transaction
      .insert(promptVersion)
      .values({
        id: request.version.id,
        promptId: request.id,
        number: 1,
        content: request.version.content,
        variables: variablesColumn(request.version.variables),
        createdAt: request.now,
      })
      .run();
    return true;
  });
}

/**
 * Changes title and description.
 *
 * @param database the workspace database
 * @param request the prompt, the new title and description and the time
 * @returns `missing`, `title_taken` or `ok`
 */
async function updatePrompt(
  database: BetterSQLite3Database,
  request: Parameters<PromptRepository['update']>[0],
): ReturnType<PromptRepository['update']> {
  return database.transaction((transaction) => {
    if (!exists(transaction, request.id)) return 'missing' as const;
    const holder = transaction.select({ id: prompt.id }).from(prompt).where(eq(prompt.titleKey, request.titleKey)).get();
    if (holder && holder.id !== request.id) return 'title_taken' as const;
    transaction
      .update(prompt)
      .set({ title: request.title, titleKey: request.titleKey, description: request.description, updatedAt: request.now })
      .where(eq(prompt.id, request.id))
      .run();
    return 'ok' as const;
  });
}

/**
 * One prompt with every version, newest first.
 *
 * @param database the workspace database
 * @param id the prompt
 * @returns the prompt; null when unknown
 */
async function getPrompt(database: BetterSQLite3Database, id: string): Promise<PromptDetail | null> {
  return readTransaction(database, (transaction) => {
    const row = transaction.select().from(prompt).where(eq(prompt.id, id)).get();
    if (!row) return null;
    const versions = transaction
      .select()
      .from(promptVersion)
      .where(eq(promptVersion.promptId, id))
      .orderBy(desc(promptVersion.number))
      .all()
      .map(toVersion);
    return { ...promptSummaries(transaction, [row])[0]!, versions, createdAt: row.createdAt };
  });
}

/**
 * One version with its prompt's id and title.
 *
 * @param database the workspace database
 * @param versionId the version
 * @returns the version; null when unknown
 */
async function getVersion(database: BetterSQLite3Database, versionId: string): ReturnType<PromptRepository['getVersion']> {
  const row = database
    .select({ version: promptVersion, title: prompt.title })
    .from(promptVersion)
    .innerJoin(prompt, eq(prompt.id, promptVersion.promptId))
    .where(eq(promptVersion.id, versionId))
    .get();
  return row ? { promptId: row.version.promptId, title: row.title, version: toVersion(row.version) } : null;
}

/**
 * Adds the next version when the base is still the current one.
 *
 * @param database the workspace database
 * @param request the prompt, the base version, the new version and the time
 * @returns `missing`, `stale` or `ok`
 */
async function addVersion(
  database: BetterSQLite3Database,
  request: Parameters<PromptRepository['addVersion']>[0],
): ReturnType<PromptRepository['addVersion']> {
  return database.transaction((transaction) => {
    if (!exists(transaction, request.promptId)) return 'missing' as const;
    const current = transaction
      .select()
      .from(promptVersion)
      .where(and(eq(promptVersion.promptId, request.promptId), isCurrent))
      .get()!;
    if (current.id !== request.baseVersionId) return 'stale' as const;
    transaction
      .insert(promptVersion)
      .values({
        id: request.version.id,
        promptId: request.promptId,
        number: current.number + 1,
        content: request.version.content,
        variables: variablesColumn(request.version.variables),
        createdAt: request.now,
      })
      .run();
    transaction.update(prompt).set({ updatedAt: request.now }).where(eq(prompt.id, request.promptId)).run();
    return 'ok' as const;
  });
}

/**
 * Deletes the prompt.
 *
 * @param database the workspace database
 * @param id the prompt
 * @returns whether a prompt was deleted
 */
async function removePrompt(database: BetterSQLite3Database, id: string): Promise<boolean> {
  // Versions and tag links go through their `cascade` rule; generations' `prompt_version_id` through `set null`.
  return database.delete(prompt).where(eq(prompt.id, id)).run().changes > 0;
}

/**
 * One page of the prompts matching every word and carrying every tag, newest change first.
 *
 * @param database the workspace database
 * @param query the folded words, the tag names and the page
 * @returns the page and the total
 */
async function listPrompts(
  database: BetterSQLite3Database,
  query: Parameters<PromptRepository['list']>[0],
): ReturnType<PromptRepository['list']> {
  return readTransaction(database, (transaction) => {
    const where = and(...query.words.map(matchesWord), ...query.tagNames.map(carriesTag));
    const total = transaction.select({ n: count() }).from(prompt).where(where).get()?.n ?? 0;
    const rows = transaction
      .select()
      .from(prompt)
      .where(where)
      .orderBy(desc(prompt.updatedAt), asc(prompt.id))
      .limit(query.limit)
      .offset(query.offset)
      .all();
    return { items: promptSummaries(transaction, rows), total };
  });
}

/**
 * Adds the tag to the prompt unless it carries it or is at the limit.
 *
 * @param database the workspace database
 * @param request the prompt, the tag, the limit and the time
 * @returns `missing`, `limit` or `ok`
 */
async function addTag(
  database: BetterSQLite3Database,
  request: Parameters<PromptRepository['addTag']>[0],
): ReturnType<PromptRepository['addTag']> {
  return database.transaction((transaction) => {
    if (!exists(transaction, request.promptId)) return 'missing' as const;
    const links = transaction
      .select({ name: tag.name })
      .from(promptTag)
      .innerJoin(tag, eq(tag.id, promptTag.tagId))
      .where(eq(promptTag.promptId, request.promptId))
      .all();
    if (links.some((link) => link.name === request.name)) return 'ok' as const;
    if (links.length >= request.max) return 'limit' as const;
    const tagId = ensureTag(transaction, request);
    transaction.insert(promptTag).values({ promptId: request.promptId, tagId, createdAt: request.now }).run();
    transaction.update(prompt).set({ updatedAt: request.now }).where(eq(prompt.id, request.promptId)).run();
    return 'ok' as const;
  });
}

/**
 * Removes the tag from the prompt.
 *
 * @param database the workspace database
 * @param request the prompt, the tag name and the time
 * @returns `missing` or `ok`
 */
async function removeTag(
  database: BetterSQLite3Database,
  request: Parameters<PromptRepository['removeTag']>[0],
): ReturnType<PromptRepository['removeTag']> {
  return database.transaction((transaction) => {
    if (!exists(transaction, request.promptId)) return 'missing' as const;
    const removed = transaction
      .delete(promptTag)
      .where(
        and(
          eq(promptTag.promptId, request.promptId),
          eq(promptTag.tagId, sql`(select ${tag.id} from ${tag} where ${tag.name} = ${request.name})`),
        ),
      )
      .run().changes;
    if (removed > 0) transaction.update(prompt).set({ updatedAt: request.now }).where(eq(prompt.id, request.promptId)).run();
    return 'ok' as const;
  });
}
