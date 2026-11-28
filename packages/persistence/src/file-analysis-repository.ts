import type { FileAnalysis, FileAnalysisRepository, Proposal } from '@assetforge/core';
import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { parseTags } from './proposal-tags.js';
import { file, fileAnalysis, fileAnalysisProposal, fileTag } from './schema.js';
import { reindexAssets } from './search-index.js';
import { ensureTag, linkFileTags } from './tag-links.js';

/** What writing an analysis needs of a transaction handle. */
type WriteTransaction = Pick<BetterSQLite3Database, 'select' | 'insert' | 'delete' | 'run' | 'all' | 'get'>;

/** The analysis write shared by `apply` and `acceptProposal`. */
interface AnalysisWrite {
  fileId: string;
  assetId: string | null;
  tags: readonly { name: string; displayName: string; newId: string }[];
  analysis: Omit<FileAnalysis, 'fileId'>;
}

/**
 * The file analysis repository over the workspace database.
 *
 * @param database the workspace database
 * @returns the repository
 */
export function createFileAnalysisRepository(database: BetterSQLite3Database): FileAnalysisRepository {
  return {
    get: (fileId) => getAnalysis(database, fileId),
    apply: (request) => applyAnalysis(database, request),
    propose: (request) => proposeTags(database, request),
    getProposal: (fileId) => getProposal(database, fileId),
    acceptProposal: (request) => acceptProposal(database, request),
    discardProposal: (fileId) => discardProposal(database, fileId),
  };
}

/**
 * The file's asset when it exists, is complete, is not in the trash and has this sha256.
 *
 * @param transaction the caller's transaction
 * @param fileId the file
 * @param sha256 the expected checksum
 * @returns the file's asset; undefined otherwise
 */
function matchingFile(
  transaction: WriteTransaction,
  fileId: string,
  sha256: string,
): { assetId: string | null } | undefined {
  const row = transaction
    .select({ assetId: file.assetId, status: file.status, sha256: file.sha256, deletedAt: file.deletedAt })
    .from(file)
    .where(eq(file.id, fileId))
    .get();
  return row && row.status === 'complete' && row.deletedAt === null && row.sha256 === sha256
    ? { assetId: row.assetId }
    : undefined;
}

/**
 * Whether the file exists and is in the trash.
 *
 * @param transaction the caller's transaction
 * @param fileId the file
 * @returns true when it is in the trash
 */
function inTrash(transaction: WriteTransaction, fileId: string): boolean {
  return (
    transaction.select({ deletedAt: file.deletedAt }).from(file).where(eq(file.id, fileId)).get()?.deletedAt != null
  );
}

/**
 * The write of an analysis result, shared by `apply` and `acceptProposal`: replaces the file's AI
 * assignments with `tags` (a tag the file carries manually stays manual), upserts the analysis row,
 * deletes a waiting proposal and reindexes the file's asset.
 *
 * @param transaction the caller's transaction
 * @param write the file, its asset, the tags and the analysis row
 * @returns nothing
 */
function writeAnalysis(transaction: WriteTransaction, write: AnalysisWrite): void {
  transaction
    .delete(fileTag)
    .where(and(eq(fileTag.fileId, write.fileId), eq(fileTag.origin, 'ai')))
    .run();
  // Only manual links are left, so the shared rule (an ai link yields to any link) keeps a manual tag manual and
  // inserts a name repeated in the answer once.
  for (const typed of write.tags) {
    const tagId = ensureTag(transaction, { ...typed, now: write.analysis.analysedAt });
    linkFileTags(transaction, [write.fileId], tagId, 'ai', write.analysis.analysedAt);
  }
  transaction
    .insert(fileAnalysis)
    .values({ fileId: write.fileId, ...write.analysis })
    .onConflictDoUpdate({ target: fileAnalysis.fileId, set: write.analysis })
    .run();
  transaction.delete(fileAnalysisProposal).where(eq(fileAnalysisProposal.fileId, write.fileId)).run();
  reindexAssets(transaction, [write.assetId]);
}

/**
 * The proposal of a row.
 *
 * @param row the proposal row
 * @returns the proposal
 */
const toProposal = (row: typeof fileAnalysisProposal.$inferSelect): Proposal => ({
  fileId: row.fileId,
  sha256: row.sha256,
  provider: row.provider,
  model: row.model,
  promptVersion: row.promptVersion,
  tags: parseTags(row.tags),
  promptName: row.promptName,
  createdAt: row.createdAt,
});

/**
 * The stored analysis of a file.
 *
 * @param database the workspace database
 * @param fileId the file
 * @returns the analysis; null when none is stored
 */
async function getAnalysis(database: BetterSQLite3Database, fileId: string): Promise<FileAnalysis | null> {
  return database.select().from(fileAnalysis).where(eq(fileAnalysis.fileId, fileId)).get() ?? null;
}

/**
 * Applies an analysis result when the file still matches its checksum.
 *
 * @param database the workspace database
 * @param request the file, its checksum, the tags, provider, model, prompt and the time
 * @returns false when the file no longer matches
 */
async function applyAnalysis(
  database: BetterSQLite3Database,
  request: Parameters<FileAnalysisRepository['apply']>[0],
): Promise<boolean> {
  return database.transaction((transaction) => {
    const target = matchingFile(transaction, request.fileId, request.sha256);
    if (!target) return false;
    writeAnalysis(transaction, {
      fileId: request.fileId,
      assetId: target.assetId,
      tags: request.tags,
      analysis: {
        sha256: request.sha256,
        provider: request.provider,
        model: request.model,
        promptVersion: request.promptVersion,
        promptName: request.promptName,
        analysedAt: request.now,
      },
    });
    return true;
  });
}

/**
 * Stores the tags as the file's proposal when the file still matches its checksum.
 *
 * @param database the workspace database
 * @param request the file, its checksum, the tags, provider, model, prompt and the time
 * @returns false when the file no longer matches
 */
async function proposeTags(
  database: BetterSQLite3Database,
  request: Parameters<FileAnalysisRepository['propose']>[0],
): Promise<boolean> {
  return database.transaction((transaction) => {
    if (!matchingFile(transaction, request.fileId, request.sha256)) return false;
    const row = {
      sha256: request.sha256,
      provider: request.provider,
      model: request.model,
      promptVersion: request.promptVersion,
      tags: JSON.stringify(
        request.tags.map((proposed) => ({ name: proposed.name, displayName: proposed.displayName })),
      ),
      promptName: request.promptName,
      createdAt: request.createdAt,
    };
    transaction
      .insert(fileAnalysisProposal)
      .values({ fileId: request.fileId, ...row })
      .onConflictDoUpdate({ target: fileAnalysisProposal.fileId, set: row })
      .run();
    return true;
  });
}

/**
 * The file's waiting proposal, marked stale when the file is no longer complete or changed.
 *
 * @param database the workspace database
 * @param fileId the file
 * @returns the proposal; null when none waits
 */
async function getProposal(
  database: BetterSQLite3Database,
  fileId: string,
): Promise<(Proposal & { stale: boolean }) | null> {
  const row = database
    .select({ proposal: fileAnalysisProposal, status: file.status, sha256: file.sha256 })
    .from(fileAnalysisProposal)
    .leftJoin(file, eq(file.id, fileAnalysisProposal.fileId))
    .where(eq(fileAnalysisProposal.fileId, fileId))
    .get();
  if (!row) return null;
  const stale = row.status !== 'complete' || row.sha256 !== row.proposal.sha256;
  return { ...toProposal(row.proposal), stale };
}

/**
 * Applies the chosen tags of the stored proposal; a stale proposal is deleted.
 *
 * @param database the workspace database
 * @param request the file, its checksum, the chosen tags and the time
 * @returns false when nothing was applied
 */
async function acceptProposal(
  database: BetterSQLite3Database,
  request: Parameters<FileAnalysisRepository['acceptProposal']>[0],
): Promise<boolean> {
  return database.transaction((transaction) => {
    const row = transaction
      .select()
      .from(fileAnalysisProposal)
      .where(eq(fileAnalysisProposal.fileId, request.fileId))
      .get();
    if (!row) return false;
    // A trashed file keeps its proposal for a restore; nothing is written meanwhile.
    if (inTrash(transaction, request.fileId)) return false;
    // A choice outside the stored proposal is refused without touching it.
    if (request.tags.length === 0) return false;
    const proposed = new Set(parseTags(row.tags).map((proposedTag) => proposedTag.name));
    if (request.tags.some((chosen) => !proposed.has(chosen.name))) return false;
    const target = row.sha256 === request.sha256 ? matchingFile(transaction, request.fileId, row.sha256) : undefined;
    if (!target) {
      transaction.delete(fileAnalysisProposal).where(eq(fileAnalysisProposal.fileId, request.fileId)).run();
      return false;
    }
    writeAnalysis(transaction, {
      fileId: request.fileId,
      assetId: target.assetId,
      tags: request.tags,
      analysis: {
        sha256: row.sha256,
        provider: row.provider,
        model: row.model,
        promptVersion: row.promptVersion,
        promptName: row.promptName,
        analysedAt: request.now,
      },
    });
    return true;
  });
}

/**
 * Deletes the file's waiting proposal.
 *
 * @param database the workspace database
 * @param fileId the file
 * @returns nothing
 */
async function discardProposal(database: BetterSQLite3Database, fileId: string): Promise<void> {
  database.delete(fileAnalysisProposal).where(eq(fileAnalysisProposal.fileId, fileId)).run();
}
