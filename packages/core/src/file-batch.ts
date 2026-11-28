import type { FileRecord } from '@assetforge/contracts';

/** The outcome of one file of a batch: the file afterwards (null once it is gone) or the error. */
export type FileBatchItem = { fileId: string; file: FileRecord | null; error: Error | null };

/**
 * Runs `operation` for each id in request order; a failure is reported for its file and never stops the next.
 *
 * @param fileIds the files, in request order
 * @param operation the work for one file; resolves to the file afterwards, null once it is gone
 * @returns one item per file, in request order
 */
export async function eachFile(
  fileIds: readonly string[],
  operation: (fileId: string) => Promise<FileRecord | null>,
): Promise<FileBatchItem[]> {
  const items: FileBatchItem[] = [];
  for (const fileId of fileIds) {
    try {
      items.push({ fileId, file: await operation(fileId), error: null });
    } catch (error) {
      items.push({
        fileId,
        file: null,
        error: error instanceof Error ? error : new Error('Unexpected error', { cause: error }),
      });
    }
  }
  return items;
}
