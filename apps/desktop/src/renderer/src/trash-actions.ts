import type { FileRecord } from '@assetforge/contracts';
import { call } from './api';
import { assignFailures, type ResultFailure } from './components/ResultStrip';

export type FileBatchChannel = 'files:trashMany' | 'files:restoreMany' | 'files:purgeMany';

/**
 * Sends one per-item batch for all `files` (at most 1000) and splits the answer: the ids that went
 * through and one failure per item with an error, named by the file's original name. A failure of
 * the whole call (e.g. the workspace closed) rejects.
 */
export async function runFileBatch(
  channel: FileBatchChannel,
  files: readonly FileRecord[],
): Promise<{ doneIds: string[]; failures: ResultFailure[] }> {
  const names = new Map(files.map((f) => [f.id, f.originalName]));
  const { items } = await call(channel, { fileIds: files.map((f) => f.id) });
  return {
    doneIds: items.flatMap((item) => (item.error === null ? [item.fileId] : [])),
    failures: assignFailures(items, (fileId) => names.get(fileId) ?? fileId),
  };
}

/** For a single-file action: the failure of its one item as a thrown error, so the caller shows it. */
export function throwFirst(failures: readonly ResultFailure[]): void {
  const [first] = failures;
  if (first !== undefined) throw new Error(first.message);
}
