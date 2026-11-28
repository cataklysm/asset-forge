import { fileKind, mimeFromFileName } from '@assetforge/core';
import { asc, eq, gt, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { reindexAsset } from './search-index.js';
import { asset, assetSearchMap, file, workspace } from './schema.js';

/**
 * Version of the data derived from stored rows: file kinds, the MIME type of videos and the search
 * index. Raise it whenever the derivation changes (new kind extensions, a different searchable
 * text), so the next open rebuilds everything once. Version 2 added the video kind.
 */
export const DERIVED_DATA_VERSION = 2;

/** Options of `ensureDerivedData`. */
export interface DerivedDataOptions {
  /** Ids per transaction; default 500. */
  batchSize?: number;
  /** Called after each committed batch of the index rebuild. */
  afterBatch?(batchIndex: number): void;
}

const DEFAULT_BATCH_SIZE = 500;

/**
 * Lets the event loop run between batches, so a long rebuild does not freeze the main process.
 *
 * @returns a promise settled on the next turn of the event loop
 */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Recomputes every file's kind (and a video's MIME type) and rebuilds the search index unless the
 * stored stamp equals `DERIVED_DATA_VERSION`. Each batch is its own transaction and the stamp is written last, so an
 * interrupted run keeps the old stamp and the next open starts over. Each transaction is synchronous;
 * the function yields to the event loop after every batch.
 *
 * @param database the workspace database
 * @param options the batch size and a hook after each index batch
 * @returns nothing
 */
export async function ensureDerivedData(database: BetterSQLite3Database, options: DerivedDataOptions = {}): Promise<void> {
  const stored = database.select({ version: workspace.derivedDataVersion }).from(workspace).limit(1).get();
  if (stored?.version === DERIVED_DATA_VERSION) return;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  await deriveFileKinds(database, batchSize);
  emptySearchIndex(database);
  await rebuildSearchIndex(database, batchSize, options.afterBatch);
  // The stamp, in its own statement.
  database.update(workspace).set({ derivedDataVersion: DERIVED_DATA_VERSION }).run();
}

/**
 * File kinds from the original names, keyset by id; a video row also gets its MIME type from the same name and
 * rule (other rows keep theirs). Only rows whose values differ are written.
 *
 * @param database the workspace database
 * @param batchSize the ids per transaction
 * @returns nothing
 */
async function deriveFileKinds(database: BetterSQLite3Database, batchSize: number): Promise<void> {
  let afterFile: string | null = null;
  for (;;) {
    const from: string | null = afterFile;
    const last: string | null = database.transaction((transaction): string | null => {
      const rows = transaction
        .select({ id: file.id, name: file.originalName, kind: file.kind, mimeType: file.mimeType })
        .from(file)
        .where(from === null ? undefined : gt(file.id, from))
        .orderBy(asc(file.id))
        .limit(batchSize)
        .all();
      for (const row of rows) {
        const kind = fileKind(row.name);
        const mimeType = kind === 'video' ? mimeFromFileName(row.name) : row.mimeType;
        if (kind !== row.kind || mimeType !== row.mimeType) {
          transaction.update(file).set({ kind, mimeType }).where(eq(file.id, row.id)).run();
        }
      }
      return rows.at(-1)?.id ?? null;
    });
    if (last === null) break;
    afterFile = last;
    await yieldToEventLoop();
  }
}

/**
 * Empties the search index in one transaction.
 *
 * @param database the workspace database
 * @returns nothing
 */
function emptySearchIndex(database: BetterSQLite3Database): void {
  database.transaction((transaction) => {
    transaction.run(sql`delete from asset_search`);
    transaction.delete(assetSearchMap).run();
  });
}

/**
 * Rebuilds the index through the function the incremental path uses, keyset by asset id.
 *
 * @param database the workspace database
 * @param batchSize the ids per transaction
 * @param afterBatch called after each committed batch
 * @returns nothing
 */
async function rebuildSearchIndex(
  database: BetterSQLite3Database,
  batchSize: number,
  afterBatch: DerivedDataOptions['afterBatch'],
): Promise<void> {
  let afterAsset: string | null = null;
  for (let batchIndex = 0; ; batchIndex++) {
    const from: string | null = afterAsset;
    const last: string | null = database.transaction((transaction): string | null => {
      const ids = transaction
        .select({ id: asset.id })
        .from(asset)
        .where(from === null ? undefined : gt(asset.id, from))
        .orderBy(asc(asset.id))
        .limit(batchSize)
        .all()
        .map((row) => row.id);
      for (const id of ids) reindexAsset(transaction, id);
      return ids.at(-1) ?? null;
    });
    if (last === null) break;
    afterBatch?.(batchIndex);
    afterAsset = last;
    await yieldToEventLoop();
  }
}
