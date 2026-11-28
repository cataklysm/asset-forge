import { FileKindSchema } from '@assetforge/contracts';
import type { FileRecord, TagAssignment } from '@assetforge/contracts';
import { hasThumbnail, isOpenable, isPreviewable } from '@assetforge/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { asset, file, fileAnalysisProposal, fileTag, tag } from './schema.js';

// Row shape equals FileRecord apart from the tags; spelled out so schema drift fails at compile time.
const toRecord = (
  row: typeof file.$inferSelect,
  tags: TagAssignment[],
  hasProposal: boolean,
  trashedAssetName: string | null,
): FileRecord => ({
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
 */
export function toRecords(tx: Pick<BetterSQLite3Database, 'select'>, rows: (typeof file.$inferSelect)[]): FileRecord[] {
  if (rows.length === 0) return [];
  const byFile = new Map<string, TagAssignment[]>();
  const assignments = tx
    .select({ fileId: fileTag.fileId, name: tag.name, displayName: tag.displayName, origin: fileTag.origin })
    .from(fileTag)
    .innerJoin(tag, eq(tag.id, fileTag.tagId))
    .where(
      inArray(
        fileTag.fileId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(tag.name), asc(fileTag.origin))
    .all();
  for (const { fileId, ...assignment } of assignments) {
    const list = byFile.get(fileId);
    if (list) list.push(assignment);
    else byFile.set(fileId, [assignment]);
  }
  const proposed = new Set(
    tx
      .select({ fileId: fileAnalysisProposal.fileId })
      .from(fileAnalysisProposal)
      .where(
        inArray(
          fileAnalysisProposal.fileId,
          rows.map((r) => r.id),
        ),
      )
      .all()
      .map((p) => p.fileId),
  );
  const originIds = [...new Set(rows.flatMap((r) => (r.trashedAssetId === null ? [] : [r.trashedAssetId])))];
  const originNames = new Map(
    originIds.length === 0
      ? []
      : tx
          .select({ id: asset.id, name: asset.name })
          .from(asset)
          .where(inArray(asset.id, originIds))
          .all()
          .map((a) => [a.id, a.name] as const),
  );
  return rows.map((row) =>
    toRecord(
      row,
      byFile.get(row.id) ?? [],
      proposed.has(row.id),
      row.trashedAssetId === null ? null : (originNames.get(row.trashedAssetId) ?? null),
    ),
  );
}

export function toRecordWithTags(tx: Pick<BetterSQLite3Database, 'select'>, row: typeof file.$inferSelect): FileRecord {
  return toRecords(tx, [row])[0]!;
}

/**
 * Clears the chosen cover of every asset other than `assetId` (the file's new asset, or null for
 * the inbox) that uses the file. Leaves `updated_at` alone: this is a side effect, not an edit.
 */
export function clearCoverOutside(tx: Pick<BetterSQLite3Database, 'update'>, fileId: string, assetId: string | null): void {
  tx.update(asset)
    .set({ coverFileId: null })
    .where(and(eq(asset.coverFileId, fileId), sql`${asset.id} is not ${assetId}`))
    .run();
}
