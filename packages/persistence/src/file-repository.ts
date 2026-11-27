import { FileKindSchema } from '@assetforge/contracts';
import type { FileList, FileRecord, FileScope, ImportStatus, TagAssignment } from '@assetforge/contracts';
import {
  InvalidOperationError,
  NotFoundError,
  foldSearchWord,
  hasThumbnail,
  isOpenable,
  isPreviewable,
  searchWords,
  type FileQuery,
  type FileRepository,
} from '@assetforge/core';
import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { qualified } from './qualified.js';
import { asset, file, fileAnalysis, fileAnalysisProposal, fileMove, fileOrigin, filePurge, fileTag, job, tag } from './schema.js';
import { assetOfFile, reindexAssets } from './search-index.js';

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

/**
 * Not in the trash. The unary `+` keeps `file_deleted_at_idx` out of the plan: nearly every row is
 * live, and without statistics SQLite would otherwise prefer it to the scope's `asset_id` key.
 */
const live = () => sql`+${qualified(file, file.deletedAt)} is null`;

/**
 * In the trash. `unlikely` tells the planner that few rows are, so `file_deleted_at_idx` drives the
 * trash list even under expensive filters (it would otherwise scan `file`).
 */
const trashed = () => sql`unlikely(${qualified(file, file.deletedAt)} is not null)`;

/**
 * The scope condition. A trashed file has no asset (the repositories keep that invariant), so the
 * asset scope excludes it without a condition; every scope that reads files without an asset does not.
 */
const scopeMatches = (scope: FileScope) => {
  switch (scope.kind) {
    case 'all':
      return live();
    case 'inbox':
      return and(isNull(file.assetId), live());
    case 'asset':
      return eq(file.assetId, scope.assetId);
    case 'trash':
      return trashed();
  }
};

type ListTx = Pick<BetterSQLite3Database, 'select'>;

/**
 * The WHERE of a file list: scope, role, kind, a waiting proposal or none, every tag on the file
 * itself, and every query word a substring of the folded file name or a word prefix of one of the
 * file's tags (Plan decision 2). Null when a requested tag does not exist, so nothing can match.
 * Written against the outer `file` row; also the file filter of analysis targets.
 */
export function fileListWhere(tx: ListTx, q: Omit<FileQuery, 'limit' | 'offset'>): { where: SQL | undefined } | null {
  const fileId = qualified(file, file.id);
  const conditions: (SQL | undefined)[] = [scopeMatches(q.scope)];
  if (q.role !== undefined) conditions.push(eq(file.role, q.role));
  if (q.kind !== undefined) conditions.push(eq(file.kind, q.kind));
  if (q.hasProposal !== undefined) {
    const proposed = sql`exists (select 1 from ${fileAnalysisProposal} where ${qualified(fileAnalysisProposal, fileAnalysisProposal.fileId)} = ${fileId})`;
    conditions.push(q.hasProposal ? proposed : sql`not ${proposed}`);
  }
  const names = [...new Set(q.tagNames ?? [])];
  if (names.length > 0) {
    const tagIds = tx.select({ id: tag.id }).from(tag).where(inArray(tag.name, names)).all();
    if (tagIds.length < names.length) return null;
    for (const { id } of tagIds) {
      conditions.push(
        sql`exists (select 1 from ${fileTag} where ${qualified(fileTag, fileTag.fileId)} = ${fileId} and ${qualified(fileTag, fileTag.tagId)} = ${id})`,
      );
    }
  }
  for (const word of (q.query === undefined ? [] : searchWords(q.query)).map(foldSearchWord)) {
    conditions.push(
      sql`(instr(af_fold(${qualified(file, file.originalName)}), ${word}) > 0 or exists (
        select 1 from ${fileTag} ft join ${tag} t on t.id = ft.tag_id
        where ft.file_id = ${fileId} and af_word_prefix(t.name, ${word})))`,
    );
  }
  return { where: and(...conditions) };
}

/** Newest import first; in the trash newest deletion first. */
const pageQuery = (tx: ListTx, q: FileQuery, where: SQL | undefined) =>
  tx
    .select()
    .from(file)
    .where(where)
    .orderBy(...(q.scope.kind === 'trash' ? [desc(file.deletedAt), desc(file.id)] : [desc(file.importedAt), desc(file.id)]))
    .limit(q.limit)
    .offset(q.offset);

const countQuery = (tx: ListTx, where: SQL | undefined) => tx.select({ n: count() }).from(file).where(where);

/** The page and count statements of a file list; null when a requested tag does not exist. Exported for the query plan test. */
export function fileListSql(tx: ListTx, q: FileQuery): { page: SQL; count: SQL } | null {
  const filter = fileListWhere(tx, q);
  if (filter === null) return null;
  return { page: pageQuery(tx, q, filter.where).getSQL(), count: countQuery(tx, filter.where).getSQL() };
}

export function createFileRepository(db: BetterSQLite3Database): FileRepository {
  return {
    async insertPending(r) {
      db.transaction((tx) => {
        tx.insert(file)
          .values({
            id: r.id,
            storageId: r.storageId,
            originalName: r.originalName,
            relativePath: r.relativePath,
            mimeType: r.mimeType,
            importedAt: r.importedAt,
            kind: r.kind,
            status: 'pending',
          })
          .run();
        if (r.origin !== undefined) {
          tx.insert(fileOrigin).values({ id: r.origin.id, fileId: r.id, url: r.origin.url, createdAt: r.importedAt }).run();
        }
      });
    },
    async deletePending(id) {
      // The origins go by their cascade; a pending row has no other dependents.
      return db
        .delete(file)
        .where(and(eq(file.id, id), eq(file.status, 'pending')))
        .run().changes > 0;
    },
    async listPendingDownloadIds() {
      return db
        .selectDistinct({ id: file.id })
        .from(file)
        .innerJoin(fileOrigin, eq(fileOrigin.fileId, file.id))
        .where(eq(file.status, 'pending'))
        .orderBy(asc(file.id))
        .all()
        .map((r) => r.id);
    },
    async markComplete(id, r) {
      db.transaction((tx) => {
        const row = tx
          .update(file)
          .set({ sizeBytes: r.sizeBytes, sha256: r.sha256, width: r.width, height: r.height, status: 'complete', error: null })
          .where(eq(file.id, id))
          .returning({ assetId: file.assetId })
          .get();
        if (!row) throw new NotFoundError(`File ${id} does not exist`);
        reindexAssets(tx, [row.assetId]);
      });
    },
    async setDimensions(id, size) {
      return db.transaction((tx) => {
        // An undefined duration leaves the column as it is; null clears it.
        const values =
          size.durationMs === undefined
            ? { width: size.width, height: size.height }
            : { width: size.width, height: size.height, durationMs: size.durationMs };
        const row = tx.update(file).set(values).where(eq(file.id, id)).returning().get();
        if (!row) throw new NotFoundError(`File ${id} does not exist`);
        return toRecordWithTags(tx, row);
      });
    },
    async markFailed(id, error) {
      db.transaction((tx) => {
        const row = tx
          .update(file)
          .set({ status: 'failed', error })
          .where(eq(file.id, id))
          .returning({ assetId: file.assetId })
          .get();
        if (!row) throw new NotFoundError(`File ${id} does not exist`);
        reindexAssets(tx, [row.assetId]);
      });
    },
    async findCompleteBySha256(sha256) {
      return db.transaction(
        (tx) =>
          toRecords(
            tx,
            tx
              .select()
              .from(file)
              .where(and(eq(file.sha256, sha256), eq(file.status, 'complete'), live())) // a trashed file is no duplicate
              .orderBy(asc(file.importedAt), asc(file.id))
              .all(),
          ),
        { behavior: 'deferred' },
      );
    },
    async listByStatus(status: ImportStatus) {
      return db.transaction(
        (tx) =>
          toRecords(
            tx,
            tx
              .select()
              .from(file)
              .where(eq(file.status, status))
              .orderBy(asc(file.importedAt), asc(file.id))
              .all(),
          ),
        { behavior: 'deferred' },
      );
    },
    async get(id) {
      return db.transaction(
        (tx) => {
          const row = tx.select().from(file).where(eq(file.id, id)).get();
          return row ? toRecordWithTags(tx, row) : null;
        },
        { behavior: 'deferred' },
      );
    },
    async setPlacement(id, placement) {
      // Throwing inside the transaction rolls back both statements.
      return db.transaction((tx) => {
        // A trashed file has no asset and no role; only a restore move places it again.
        const trashed = tx.select({ deletedAt: file.deletedAt }).from(file).where(eq(file.id, id)).get();
        if (trashed?.deletedAt != null) throw new InvalidOperationError('The file is in the trash');
        const left = assetOfFile(tx, id);
        const row = tx
          .update(file)
          .set({ relativePath: placement.relativePath, assetId: placement.assetId, role: placement.role })
          .where(eq(file.id, id))
          .returning()
          .get();
        if (!row) throw new NotFoundError(`File ${id} does not exist`);
        clearCoverOutside(tx, id, placement.assetId);
        reindexAssets(tx, [left, row.assetId]);
        return toRecordWithTags(tx, row);
      });
    },
    async list(q): Promise<FileList> {
      // One read transaction, so the tag ids, the page and the total describe the same snapshot.
      return db.transaction(
        (tx) => {
          const filter = fileListWhere(tx, q);
          if (filter === null) return { items: [], total: 0 };
          const items = toRecords(tx, pageQuery(tx, q, filter.where).all());
          const total = countQuery(tx, filter.where).get()?.n ?? 0;
          return { items, total };
        },
        { behavior: 'deferred' },
      );
    },
    async purge(id) {
      return db.transaction((tx) => {
        const row = tx.select({ deletedAt: file.deletedAt, status: file.status }).from(file).where(eq(file.id, id)).get();
        if (!row || (row.deletedAt === null && row.status !== 'failed')) return false;
        // An open move may have put the binary outside the trash; it is resolved first, never dropped.
        if (tx.select({ fileId: fileMove.fileId }).from(fileMove).where(eq(fileMove.fileId, id)).get()) {
          throw new InvalidOperationError('The file is being moved');
        }
        // Dependents first, so the foreign keys hold at every statement. A chosen cover is cleared by
        // its `set null` rule (only a failed inbox file could still be one; a trashed file is none), the
        // origins by their cascade.
        tx.delete(fileTag).where(eq(fileTag.fileId, id)).run();
        tx.delete(fileAnalysis).where(eq(fileAnalysis.fileId, id)).run();
        tx.delete(fileAnalysisProposal).where(eq(fileAnalysisProposal.fileId, id)).run();
        tx.delete(job).where(eq(job.fileId, id)).run();
        const left = assetOfFile(tx, id);
        tx.delete(file).where(eq(file.id, id)).run();
        // The tombstone tells the trash sweep that a leftover binary of this id may go.
        if (row.deletedAt !== null) {
          tx.insert(filePurge).values({ fileId: id, purgedAt: new Date().toISOString() }).onConflictDoNothing().run();
        }
        reindexAssets(tx, [left]);
        return true;
      });
    },
    async listPurgedIds() {
      return db
        .select({ id: filePurge.fileId })
        .from(filePurge)
        .orderBy(asc(filePurge.fileId))
        .all()
        .map((r) => r.id);
    },
    async forgetPurge(id) {
      db.delete(filePurge).where(eq(filePurge.fileId, id)).run();
    },
    async countTrashed() {
      return db.select({ n: count() }).from(file).where(trashed()).get()?.n ?? 0;
    },
    async listTrashedIds() {
      return db
        .select({ id: file.id })
        .from(file)
        .where(trashed())
        .orderBy(desc(file.deletedAt), desc(file.id))
        .all()
        .map((r) => r.id);
    },
  };
}
