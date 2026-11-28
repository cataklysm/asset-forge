import type { ImportResult } from '@assetforge/contracts';

// What the screens show of picked paths and of an import's results.

/**
 * The file name of a picked source path; the rest of the path never reaches the screen.
 *
 * @param path the picked path
 * @returns its last segment
 */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Whether a picked path names a ZIP archive: its file name ends in `.zip`, ignoring case and trailing dots and spaces.
 *
 * @param path the picked path
 * @returns true for a ZIP name
 */
export function isZipPath(path: string): boolean {
  return /\.zip$/i.test(baseName(path).replace(/[. ]+$/, ''));
}

/**
 * The title of an import result strip: '3 imported, 1 failed' and, with `duplicates`,
 * ', 2 duplicates'. Imported are the results with a complete file, failed those with an error
 * (a failed file row counts as failed only). A duplicate is still imported, so it counts in both.
 * After a cancel the title ends with ', cancelled'.
 *
 * @param results the import's results
 * @param options whether duplicates are counted and whether the import was cancelled
 * @returns the title
 */
export function importTitle(
  results: readonly ImportResult[],
  options: { duplicates: boolean; cancelled?: boolean },
): string {
  const imported = results.filter((result) => result.file?.status === 'complete').length;
  const failed = results.filter((result) => result.error !== null).length;
  let title = `${imported} imported, ${failed} failed`;
  if (options.duplicates) title += `, ${results.filter((result) => result.duplicateOf.length > 0).length} duplicates`;
  return options.cancelled === true ? `${title}, cancelled` : title;
}
