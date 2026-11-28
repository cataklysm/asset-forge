import type { PromptDetail } from '@assetforge/contracts';
import type { PromptRepository } from '@assetforge/core';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { carriesTag, isCurrent, matchesWord, summaries, toVersion, variablesColumn, type Tx } from './prompt-rows.js';
import { prompt, promptTag, promptVersion, tag } from './schema.js';
import { ensureTag } from './tag-links.js';

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
