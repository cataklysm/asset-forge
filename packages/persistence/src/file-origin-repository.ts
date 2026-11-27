import { MAX_FILE_ORIGINS } from '@assetforge/contracts';
import type { FileOriginRepository } from '@assetforge/core';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { file, fileOrigin } from './schema.js';

/** Bound parameters per `IN` list, well below SQLite's limit. */
const CHUNK = 500;

export function createFileOriginRepository(db: BetterSQLite3Database): FileOriginRepository {
  return {
    async listByFile(fileId) {
      return db
        .select({ id: fileOrigin.id, url: fileOrigin.url, createdAt: fileOrigin.createdAt })
        .from(fileOrigin)
        .where(eq(fileOrigin.fileId, fileId))
        .orderBy(asc(fileOrigin.createdAt), asc(fileOrigin.id))
        .all();
    },
    async get(id) {
      return db.select().from(fileOrigin).where(eq(fileOrigin.id, id)).get() ?? null;
    },
    async findCompleteFileByUrl(url) {
      const row = db
        .select({ id: file.id })
        .from(fileOrigin)
        .innerJoin(file, eq(file.id, fileOrigin.fileId))
        .where(and(eq(fileOrigin.url, url), eq(file.status, 'complete')))
        .orderBy(asc(file.importedAt), asc(file.id))
        .limit(1)
        .get();
      return row?.id ?? null;
    },
    async knownUrls(urls) {
      const known = new Set<string>();
      const distinct = [...new Set(urls)];
      for (let i = 0; i < distinct.length; i += CHUNK) {
        const rows = db
          .selectDistinct({ url: fileOrigin.url })
          .from(fileOrigin)
          .innerJoin(file, eq(file.id, fileOrigin.fileId))
          .where(and(inArray(fileOrigin.url, distinct.slice(i, i + CHUNK)), eq(file.status, 'complete')))
          .all();
        for (const r of rows) known.add(r.url);
      }
      return known;
    },
    async insert(row) {
      return db.transaction((tx) => {
        const n = tx.select({ n: count() }).from(fileOrigin).where(eq(fileOrigin.fileId, row.fileId)).get()?.n ?? 0;
        if (n >= MAX_FILE_ORIGINS) return false;
        return (
          tx
            .insert(fileOrigin)
            .values(row)
            .onConflictDoNothing({ target: [fileOrigin.fileId, fileOrigin.url] })
            .run().changes > 0
        );
      });
    },
  };
}
