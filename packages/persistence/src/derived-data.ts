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

export interface DerivedDataOptions {
  /** Ids per transaction; default 500. */
  batchSize?: number;
  /** Called after each committed batch of the index rebuild. */
  afterBatch?(batchIndex: number): void;
}

const DEFAULT_BATCH_SIZE = 500;

/** Lets the event loop run between batches, so a long rebuild does not freeze the main process. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Recomputes every file's kind (and a video's MIME type) and rebuilds the search index unless the
 * stored stamp equals `DERIVED_DATA_VERSION`. Each batch is its own transaction and the stamp is written last, so an
 * interrupted run keeps the old stamp and the next open starts over. Each transaction is synchronous;
 * the function yields to the event loop after every batch.
 */
export async function ensureDerivedData(db: BetterSQLite3Database, options: DerivedDataOptions = {}): Promise<void> {
  const stored = db.select({ v: workspace.derivedDataVersion }).from(workspace).limit(1).get();
  if (stored?.v === DERIVED_DATA_VERSION) return;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  // (1) File kinds from the original names, keyset by id; a video row also gets its MIME type from the same name and
  // rule (other rows keep theirs). Only rows whose values differ are written.
  let afterFile: string | null = null;
  for (;;) {
    const from: string | null = afterFile;
    const last: string | null = db.transaction((tx): string | null => {
      const rows = tx
        .select({ id: file.id, name: file.originalName, kind: file.kind, mimeType: file.mimeType })
        .from(file)
        .where(from === null ? undefined : gt(file.id, from))
        .orderBy(asc(file.id))
        .limit(batchSize)
        .all();
      for (const row of rows) {
        const kind = fileKind(row.name);
        const mimeType = kind === 'video' ? mimeFromFileName(row.name) : row.mimeType;
        if (kind !== row.kind || mimeType !== row.mimeType) tx.update(file).set({ kind, mimeType }).where(eq(file.id, row.id)).run();
      }
      return rows.at(-1)?.id ?? null;
    });
    if (last === null) break;
    afterFile = last;
    await yieldToEventLoop();
  }

  // (2) Empty the index.
  db.transaction((tx) => {
    tx.run(sql`delete from asset_search`);
    tx.delete(assetSearchMap).run();
  });

  // (3) Rebuild it through the function the incremental path uses, keyset by asset id.
  let afterAsset: string | null = null;
  for (let batchIndex = 0; ; batchIndex++) {
    const from: string | null = afterAsset;
    const last: string | null = db.transaction((tx): string | null => {
      const ids = tx
        .select({ id: asset.id })
        .from(asset)
        .where(from === null ? undefined : gt(asset.id, from))
        .orderBy(asc(asset.id))
        .limit(batchSize)
        .all()
        .map((r) => r.id);
      for (const id of ids) reindexAsset(tx, id);
      return ids.at(-1) ?? null;
    });
    if (last === null) break;
    options.afterBatch?.(batchIndex);
    afterAsset = last;
    await yieldToEventLoop();
  }

  // (4) The stamp, in its own statement.
  db.update(workspace).set({ derivedDataVersion: DERIVED_DATA_VERSION }).run();
}
