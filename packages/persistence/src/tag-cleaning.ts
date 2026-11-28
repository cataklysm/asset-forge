import { cleanTagText, normalizeTagName } from '@assetforge/contracts';
import { asc, eq, gt } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { parseTags } from './proposal-tags.js';
import { assetTag, fileAnalysisProposal, fileTag, promptTag, tag } from './schema.js';
import { dropAllUnusedTags } from './tag-links.js';
import { mergeTag } from './tag-rename.js';

// The derived-data step for stored tags: names and display names written before the current cleaning rule
// (`cleanTagText`, `normalizeTagName`) are brought in line with it. The caller rebuilds the search index afterwards.

/** One stored tag row as the cleaning reads it. */
type TagRow = { id: string; name: string; displayName: string };

/** What the cleaning needs of a transaction. */
type CleaningTransaction = Parameters<Parameters<BetterSQLite3Database['transaction']>[0]>[0];

/**
 * Lets the event loop run between batches.
 *
 * @returns a promise settled on the next turn of the event loop
 */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Cleans every stored tag and every waiting proposal, batch by batch, each batch its own transaction: rows no link
 * holds go first; a tag whose name cleans to nothing is removed with its links; a tag whose name becomes that of
 * another is merged into it by the rule of a merge by rename (an owner keeps one link, manual when either was, with
 * the earlier date); any other changed tag is rewritten in place.
 *
 * @param database the workspace database
 * @param batchSize the rows per transaction
 * @returns nothing
 */
export async function cleanStoredTags(database: BetterSQLite3Database, batchSize: number): Promise<void> {
  database.transaction((transaction) => dropAllUnusedTags(transaction));
  let afterTag: string | null = null;
  for (;;) {
    const from: string | null = afterTag;
    const last: string | null = database.transaction((transaction): string | null =>
      cleanTagBatch(transaction, from, batchSize),
    );
    if (last === null) break;
    afterTag = last;
    await yieldToEventLoop();
  }
  await cleanProposals(database, batchSize);
}

/**
 * Cleans one batch of tag rows, keyset by id.
 *
 * @param transaction the batch's transaction
 * @param after the last id of the previous batch; null for the first
 * @param batchSize the rows to read
 * @returns the last id read; null when no row was left
 */
function cleanTagBatch(transaction: CleaningTransaction, after: string | null, batchSize: number): string | null {
  const rows: TagRow[] = transaction
    .select({ id: tag.id, name: tag.name, displayName: tag.displayName })
    .from(tag)
    .where(after === null ? undefined : gt(tag.id, after))
    .orderBy(asc(tag.id))
    .limit(batchSize)
    .all();
  for (const row of rows) cleanTag(transaction, row);
  return rows.at(-1)?.id ?? null;
}

/**
 * Brings one tag row in line with the cleaning rule.
 *
 * @param transaction the caller's transaction
 * @param row the stored row
 * @returns nothing
 */
function cleanTag(transaction: CleaningTransaction, row: TagRow): void {
  const name = normalizeTagName(row.name);
  if (name === null) {
    removeTag(transaction, row.id);
    return;
  }
  const displayName = cleanDisplayName(row.displayName, name);
  if (name === row.name && displayName === row.displayName) return;
  const other = transaction.select({ id: tag.id }).from(tag).where(eq(tag.name, name)).get();
  if (other !== undefined && other.id !== row.id) {
    const kept = transaction.select({ displayName: tag.displayName }).from(tag).where(eq(tag.id, other.id)).get()!;
    mergeTag(transaction, row.id, other.id, cleanDisplayName(kept.displayName, name));
    return;
  }
  transaction.update(tag).set({ name, displayName }).where(eq(tag.id, row.id)).run();
}

/**
 * The cleaned display name; the name itself when the cleaned text no longer belongs to it.
 *
 * @param displayName the stored display name
 * @param name the cleaned normalised name
 * @returns the display name to store
 */
function cleanDisplayName(displayName: string, name: string): string {
  const cleaned = cleanTagText(displayName);
  return normalizeTagName(cleaned) === name ? cleaned : name;
}

/**
 * Removes a tag with every link to it.
 *
 * @param transaction the caller's transaction
 * @param tagId the tag
 * @returns nothing
 */
function removeTag(transaction: CleaningTransaction, tagId: string): void {
  transaction.delete(assetTag).where(eq(assetTag.tagId, tagId)).run();
  transaction.delete(fileTag).where(eq(fileTag.tagId, tagId)).run();
  transaction.delete(promptTag).where(eq(promptTag.tagId, tagId)).run();
  transaction.delete(tag).where(eq(tag.id, tagId)).run();
}

/**
 * Cleans the tags of every waiting proposal, keyset by file id; only lists that change are written.
 *
 * @param database the workspace database
 * @param batchSize the rows per transaction
 * @returns nothing
 */
async function cleanProposals(database: BetterSQLite3Database, batchSize: number): Promise<void> {
  let afterFile: string | null = null;
  for (;;) {
    const from: string | null = afterFile;
    const last = database.transaction((transaction): string | null => {
      const rows = transaction
        .select({ fileId: fileAnalysisProposal.fileId, tags: fileAnalysisProposal.tags })
        .from(fileAnalysisProposal)
        .where(from === null ? undefined : gt(fileAnalysisProposal.fileId, from))
        .orderBy(asc(fileAnalysisProposal.fileId))
        .limit(batchSize)
        .all();
      for (const row of rows) {
        const cleaned = JSON.stringify(cleanedProposalTags(parseTags(row.tags)));
        if (cleaned === row.tags) continue;
        transaction
          .update(fileAnalysisProposal)
          .set({ tags: cleaned })
          .where(eq(fileAnalysisProposal.fileId, row.fileId))
          .run();
      }
      return rows.at(-1)?.fileId ?? null;
    });
    if (last === null) break;
    afterFile = last;
    await yieldToEventLoop();
  }
}

/**
 * One proposal's tags after cleaning: an entry whose name cleans to nothing goes, a repeated name keeps the first.
 *
 * @param tags the stored entries
 * @returns the cleaned entries
 */
function cleanedProposalTags(tags: { name: string; displayName: string }[]): { name: string; displayName: string }[] {
  const cleaned: { name: string; displayName: string }[] = [];
  for (const entry of tags) {
    const name = normalizeTagName(entry.name);
    if (name === null || cleaned.some((other) => other.name === name)) continue;
    cleaned.push({ name, displayName: cleanDisplayName(entry.displayName, name) });
  }
  return cleaned;
}
