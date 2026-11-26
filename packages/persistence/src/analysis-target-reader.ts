import type { AnalysisPreview } from '@assetforge/contracts';
import type { AnalysisTargetEntry, AnalysisTargetReader } from '@assetforge/core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

/** Resolves analysis targets to files, one keyset page at a time, and counts them for a preview. */
// phase 4b stub: Task 2
export function createAnalysisTargetReader(_db: BetterSQLite3Database): AnalysisTargetReader {
  return {
    async page(): Promise<AnalysisTargetEntry[]> {
      throw new Error('not implemented');
    },
    async count(): Promise<AnalysisPreview> {
      throw new Error('not implemented');
    },
  };
}
