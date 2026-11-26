import type { FileAnalysis, FileAnalysisRepository } from '@assetforge/core';
import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { file, fileAnalysis, fileTag } from './schema.js';
import { reindexAssets } from './search-index.js';
import { ensureTag } from './tag-repository.js';

export function createFileAnalysisRepository(db: BetterSQLite3Database): FileAnalysisRepository {
  return {
    async get(fileId): Promise<FileAnalysis | null> {
      return db.select().from(fileAnalysis).where(eq(fileAnalysis.fileId, fileId)).get() ?? null;
    },
    async apply(r): Promise<boolean> {
      return db.transaction((tx) => {
        const row = tx
          .select({ assetId: file.assetId, status: file.status, sha256: file.sha256 })
          .from(file)
          .where(eq(file.id, r.fileId))
          .get();
        if (!row || row.status !== 'complete' || row.sha256 !== r.sha256) return false;

        tx.delete(fileTag)
          .where(and(eq(fileTag.fileId, r.fileId), eq(fileTag.origin, 'ai')))
          .run();
        for (const t of r.tags) {
          const tagId = ensureTag(tx, { ...t, now: r.now });
          const manual = tx
            .select({ tagId: fileTag.tagId })
            .from(fileTag)
            .where(and(eq(fileTag.fileId, r.fileId), eq(fileTag.tagId, tagId), eq(fileTag.origin, 'manual')))
            .get();
          if (manual) continue;
          // A name repeated in the answer is inserted once.
          tx.insert(fileTag).values({ fileId: r.fileId, tagId, origin: 'ai', createdAt: r.now }).onConflictDoNothing().run();
        }

        const analysis = { sha256: r.sha256, provider: r.provider, model: r.model, promptVersion: r.promptVersion, analysedAt: r.now };
        tx.insert(fileAnalysis)
          .values({ fileId: r.fileId, ...analysis })
          .onConflictDoUpdate({ target: fileAnalysis.fileId, set: analysis })
          .run();
        reindexAssets(tx, [row.assetId]);
        return true;
      });
    },
  };
}
