import type { FileAnalysis, FileAnalysisRepository, Proposal } from '@assetforge/core';
import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { file, fileAnalysis, fileAnalysisProposal, fileTag } from './schema.js';
import { reindexAssets } from './search-index.js';
import { ensureTag } from './tag-repository.js';

type WriteTx = Pick<BetterSQLite3Database, 'select' | 'insert' | 'delete' | 'run' | 'all' | 'get'>;

/** The file's asset when it exists, is complete, is not in the trash and has this sha256; undefined otherwise. */
function matchingFile(tx: WriteTx, fileId: string, sha256: string): { assetId: string | null } | undefined {
  const row = tx
    .select({ assetId: file.assetId, status: file.status, sha256: file.sha256, deletedAt: file.deletedAt })
    .from(file)
    .where(eq(file.id, fileId))
    .get();
  return row && row.status === 'complete' && row.deletedAt === null && row.sha256 === sha256 ? { assetId: row.assetId } : undefined;
}

/** True when the file exists and is in the trash. */
function inTrash(tx: WriteTx, fileId: string): boolean {
  return tx.select({ deletedAt: file.deletedAt }).from(file).where(eq(file.id, fileId)).get()?.deletedAt != null;
}

/**
 * The write of an analysis result, shared by `apply` and `acceptProposal`: replaces the file's AI
 * assignments with `tags` (a tag the file carries manually stays manual), upserts the analysis row,
 * deletes a waiting proposal and reindexes the file's asset.
 */
function writeAnalysis(
  tx: WriteTx,
  r: {
    fileId: string;
    assetId: string | null;
    tags: readonly { name: string; displayName: string; newId: string }[];
    analysis: Omit<FileAnalysis, 'fileId'>;
  },
): void {
  tx.delete(fileTag)
    .where(and(eq(fileTag.fileId, r.fileId), eq(fileTag.origin, 'ai')))
    .run();
  for (const t of r.tags) {
    const tagId = ensureTag(tx, { ...t, now: r.analysis.analysedAt });
    const manual = tx
      .select({ tagId: fileTag.tagId })
      .from(fileTag)
      .where(and(eq(fileTag.fileId, r.fileId), eq(fileTag.tagId, tagId), eq(fileTag.origin, 'manual')))
      .get();
    if (manual) continue;
    // A name repeated in the answer is inserted once.
    tx.insert(fileTag).values({ fileId: r.fileId, tagId, origin: 'ai', createdAt: r.analysis.analysedAt }).onConflictDoNothing().run();
  }
  tx.insert(fileAnalysis)
    .values({ fileId: r.fileId, ...r.analysis })
    .onConflictDoUpdate({ target: fileAnalysis.fileId, set: r.analysis })
    .run();
  tx.delete(fileAnalysisProposal).where(eq(fileAnalysisProposal.fileId, r.fileId)).run();
  reindexAssets(tx, [r.assetId]);
}

/** The stored tag list; anything but an array of `{ name, displayName }` strings reads as []. */
function parseTags(json: string): Proposal['tags'] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((t: unknown) => {
    if (typeof t !== 'object' || t === null) return [];
    const { name, displayName } = t as { name?: unknown; displayName?: unknown };
    return typeof name === 'string' && typeof displayName === 'string' ? [{ name, displayName }] : [];
  });
}

const toProposal = (row: typeof fileAnalysisProposal.$inferSelect): Proposal => ({
  fileId: row.fileId,
  sha256: row.sha256,
  provider: row.provider,
  model: row.model,
  promptVersion: row.promptVersion,
  tags: parseTags(row.tags),
  createdAt: row.createdAt,
});

export function createFileAnalysisRepository(db: BetterSQLite3Database): FileAnalysisRepository {
  return {
    async get(fileId): Promise<FileAnalysis | null> {
      return db.select().from(fileAnalysis).where(eq(fileAnalysis.fileId, fileId)).get() ?? null;
    },
    async apply(r): Promise<boolean> {
      return db.transaction((tx) => {
        const target = matchingFile(tx, r.fileId, r.sha256);
        if (!target) return false;
        writeAnalysis(tx, {
          fileId: r.fileId,
          assetId: target.assetId,
          tags: r.tags,
          analysis: { sha256: r.sha256, provider: r.provider, model: r.model, promptVersion: r.promptVersion, analysedAt: r.now },
        });
        return true;
      });
    },
    async propose(r): Promise<boolean> {
      return db.transaction((tx) => {
        if (!matchingFile(tx, r.fileId, r.sha256)) return false;
        const row = {
          sha256: r.sha256,
          provider: r.provider,
          model: r.model,
          promptVersion: r.promptVersion,
          tags: JSON.stringify(r.tags.map((t) => ({ name: t.name, displayName: t.displayName }))),
          createdAt: r.createdAt,
        };
        tx.insert(fileAnalysisProposal)
          .values({ fileId: r.fileId, ...row })
          .onConflictDoUpdate({ target: fileAnalysisProposal.fileId, set: row })
          .run();
        return true;
      });
    },
    async getProposal(fileId): Promise<(Proposal & { stale: boolean }) | null> {
      const row = db
        .select({ proposal: fileAnalysisProposal, status: file.status, sha256: file.sha256 })
        .from(fileAnalysisProposal)
        .leftJoin(file, eq(file.id, fileAnalysisProposal.fileId))
        .where(eq(fileAnalysisProposal.fileId, fileId))
        .get();
      if (!row) return null;
      const stale = row.status !== 'complete' || row.sha256 !== row.proposal.sha256;
      return { ...toProposal(row.proposal), stale };
    },
    async acceptProposal(r): Promise<boolean> {
      return db.transaction((tx) => {
        const row = tx.select().from(fileAnalysisProposal).where(eq(fileAnalysisProposal.fileId, r.fileId)).get();
        if (!row) return false;
        // A trashed file keeps its proposal for a restore; nothing is written meanwhile.
        if (inTrash(tx, r.fileId)) return false;
        // A choice outside the stored proposal is refused without touching it.
        if (r.tags.length === 0) return false;
        const proposed = new Set(parseTags(row.tags).map((t) => t.name));
        if (r.tags.some((t) => !proposed.has(t.name))) return false;
        const target = row.sha256 === r.sha256 ? matchingFile(tx, r.fileId, row.sha256) : undefined;
        if (!target) {
          tx.delete(fileAnalysisProposal).where(eq(fileAnalysisProposal.fileId, r.fileId)).run();
          return false;
        }
        writeAnalysis(tx, {
          fileId: r.fileId,
          assetId: target.assetId,
          tags: r.tags,
          analysis: { sha256: row.sha256, provider: row.provider, model: row.model, promptVersion: row.promptVersion, analysedAt: r.now },
        });
        return true;
      });
    },
    async discardProposal(fileId): Promise<void> {
      db.delete(fileAnalysisProposal).where(eq(fileAnalysisProposal.fileId, fileId)).run();
    },
  };
}
