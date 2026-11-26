import type { ImportResult } from '@assetforge/contracts';

/** The file name of a picked source path; the rest of the path never reaches the screen. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Whether a picked path names a ZIP archive: its file name ends in `.zip`, ignoring case and trailing dots and spaces. */
export function isZipPath(path: string): boolean {
  return /\.zip$/i.test(baseName(path).replace(/[. ]+$/, ''));
}

/**
 * The title of an import result strip: '3 imported, 1 failed' and, with `duplicates`,
 * ', 2 duplicates'. Imported are the results with a complete file, failed those with an error
 * (a failed file row counts as failed only). A duplicate is still imported, so it counts in both.
 */
export function importTitle(results: readonly ImportResult[], options: { duplicates: boolean }): string {
  const imported = results.filter((r) => r.file?.status === 'complete').length;
  const failed = results.filter((r) => r.error !== null).length;
  const title = `${imported} imported, ${failed} failed`;
  if (!options.duplicates) return title;
  return `${title}, ${results.filter((r) => r.duplicateOf.length > 0).length} duplicates`;
}
