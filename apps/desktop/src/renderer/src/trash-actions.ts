import type { FileRecord } from '@assetforge/contracts';
import { ApiError, call } from './api';
import { assignFailures, type ResultFailure } from './components/ResultStrip';

// The per-item batches of the trash (delete, restore, delete permanently) and their answers.

/** The per-item batch channels of the trash. */
export type FileBatchChannel = 'files:trashMany' | 'files:restoreMany' | 'files:purgeMany';

/** The answer of a per-item batch, split. */
export interface FileBatchOutcome {
  /** The ids that went through. */
  doneIds: string[];
  /** One failure per item with an error, in item order. */
  failures: ResultFailure[];
  /** The first item's error with its code; null when no item failed. */
  firstError: ApiError | null;
}

/**
 * Sends one per-item batch for all `files` (at most 1000) and splits the answer: the ids that went
 * through and one failure per item with an error, named by the file's original name. A failure of
 * the whole call (e.g. the workspace closed) rejects.
 *
 * @param channel the batch channel
 * @param files the files
 * @returns the ids that went through, the failures and the first error
 */
export async function runFileBatch(channel: FileBatchChannel, files: readonly FileRecord[]): Promise<FileBatchOutcome> {
  const names = new Map(files.map((file) => [file.id, file.originalName]));
  const { items } = await call(channel, { fileIds: files.map((file) => file.id) });
  const failed = items.find((item) => item.error !== null)?.error ?? null;
  return {
    doneIds: items.flatMap((item) => (item.error === null ? [item.fileId] : [])),
    failures: assignFailures(items, (fileId) => names.get(fileId) ?? fileId),
    firstError: failed === null ? null : new ApiError(failed.code, failed.message),
  };
}

/**
 * For a single-file action: the failure of its one item as a thrown error with its code, so the caller shows it.
 *
 * @param firstError the batch's first error; null when no item failed
 */
export function throwFirst(firstError: ApiError | null): void {
  if (firstError !== null) throw firstError;
}
