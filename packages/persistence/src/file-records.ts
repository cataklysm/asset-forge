import { FileKindSchema } from '@assetforge/contracts';
import type { FileRecord, TagAssignment } from '@assetforge/contracts';
import { hasThumbnail, isOpenable, isPreviewable } from '@assetforge/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { asset, file, fileAnalysisProposal, fileTag, tag } from './schema.js';

// File rows as records: the row with its tags, its proposal marker and the name of the asset a trashed file left.

/** A row of the `file` table as Drizzle reads it. */
type FileRow = typeof file.$inferSelect;

/** A handle that can read: the database or a transaction on it. */
type FileReader = Pick<BetterSQLite3Database, 'select'>;

/**
 * One row as a record. Row shape equals FileRecord apart from the tags; spelled out so schema drift fails at
 * compile time.
 *
 * @param row the row
 * @param tags the file's tags
 * @param hasProposal whether a tag proposal waits for the file
 * @param trashedAssetName the name of the asset a trashed file left; null otherwise
 * @returns the record
 */
const toRecord = (row: FileRow, tags: TagAssignment[], hasProposal: boolean, trashedAssetName: string | null): FileRecord => ({
  id: row.id,
  storageId: row.storageId,
  assetId: row.assetId,
  role: row.role,
  originalName: row.originalName,
  relativePath: row.relativePath,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  sha256: row.sha256,
  status: row.status,
  error: row.error,
  importedAt: row.importedAt,
  previewable: isPreviewable(row.mimeType),
  thumbnail: hasThumbnail(row.mimeType),
  openable: row.deletedAt === null && isOpenable(row.relativePath), // a trashed file is never opened
  kind: FileKindSchema.catch('other').parse(row.kind), // the column has no CHECK; an unknown value reads as 'other'
  width: row.width,
  height: row.height,
  durationMs: row.durationMs,
  tags,
  hasProposal,
  deletedAt: row.deletedAt,
  trashedAssetId: row.trashedAssetId,
  trashedAssetName,
  trashedRole: row.trashedRole,
});

/**
 * Turns rows into records; the file tags of all rows come from one query, their proposals from
 * another, and the names of the trashed files' origin assets from a third (only when there are any).
 *
 * @param reader the database or the caller's transaction
 * @param rows the rows
 * @returns the records in row order
 */
export function toRecords(reader: FileReader, rows: FileRow[]): FileRecord[] {
  if (rows.length === 0) return [];
  const tags = tagsByFile(reader, rows);
  const proposed = proposedFiles(reader, rows);
  const originNames = originAssetNames(reader, rows);
  return rows.map((row) =>
    toRecord(
      row,
      tags.get(row.id) ?? [],
      proposed.has(row.id),
      row.trashedAssetId === null ? null : (originNames.get(row.trashedAssetId) ?? null),
    ),
  );
}

/**
 * The tags of the files, by name and origin.
 *
 * @param reader the database or the caller's transaction
 * @param rows the files
 * @returns the tags by file id; a file without tags is missing
 */
function tagsByFile(reader: FileReader, rows: FileRow[]): Map<string, TagAssignment[]> {
  const byFile = new Map<string, TagAssignment[]>();
  const assignments = reader
    .select({ fileId: fileTag.fileId, name: tag.name, displayName: tag.displayName, origin: fileTag.origin })
    .from(fileTag)
    .innerJoin(tag, eq(tag.id, fileTag.tagId))
    .where(
      inArray(
        fileTag.fileId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(tag.name), asc(fileTag.origin))
    .all();
  for (const { fileId, ...assignment } of assignments) {
    const list = byFile.get(fileId);
    if (list) list.push(assignment);
    else byFile.set(fileId, [assignment]);
  }
  return byFile;
}

/**
 * The files a tag proposal waits for.
 *
 * @param reader the database or the caller's transaction
 * @param rows the files
 * @returns their ids
 */
function proposedFiles(reader: FileReader, rows: FileRow[]): Set<string> {
  return new Set(
    reader
      .select({ fileId: fileAnalysisProposal.fileId })
      .from(fileAnalysisProposal)
      .where(
        inArray(
          fileAnalysisProposal.fileId,
          rows.map((row) => row.id),
        ),
      )
      .all()
      .map((proposal) => proposal.fileId),
  );
}

/**
 * The names of the assets the trashed files left; read only when there are any.
 *
 * @param reader the database or the caller's transaction
 * @param rows the files
 * @returns the names by asset id; an asset that is gone is missing
 */
function originAssetNames(reader: FileReader, rows: FileRow[]): Map<string, string> {
  const originIds = [...new Set(rows.flatMap((row) => (row.trashedAssetId === null ? [] : [row.trashedAssetId])))];
  if (originIds.length === 0) return new Map();
  return new Map(
    reader
      .select({ id: asset.id, name: asset.name })
      .from(asset)
      .where(inArray(asset.id, originIds))
      .all()
      .map((origin) => [origin.id, origin.name] as const),
  );
}

/**
 * One row as a record.
 *
 * @param reader the database or the caller's transaction
 * @param row the row
 * @returns the record
 */
export function toRecordWithTags(reader: FileReader, row: FileRow): FileRecord {
  return toRecords(reader, [row])[0]!;
}

/**
 * Clears the chosen cover of every asset other than `assetId` (the file's new asset, or null for
 * the inbox) that uses the file. Leaves `updated_at` alone: this is a side effect, not an edit.
 *
 * @param transaction the caller's transaction
 * @param fileId the file
 * @param assetId the asset that may keep it as its cover; null for none
 * @returns nothing
 */
export function clearCoverOutside(
  transaction: Pick<BetterSQLite3Database, 'update'>,
  fileId: string,
  assetId: string | null,
): void {
  transaction
    .update(asset)
    .set({ coverFileId: null })
    .where(and(eq(asset.coverFileId, fileId), sql`${asset.id} is not ${assetId}`))
    .run();
}
