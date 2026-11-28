import { ValidationFailedError } from './errors.js';
import { sanitizeFileName } from './file-names.js';

/** Extensions (lower case, no dot) of programs, installers and shortcuts that are never imported. */
export const REFUSED_IMPORT_EXTENSIONS: readonly string[] = [
  'exe',
  'com',
  'scr',
  'msi',
  'msp',
  'msix',
  'appx',
  'appinstaller',
  'bat',
  'cmd',
  'ps1',
  'psm1',
  'psd1',
  'vbs',
  'vbe',
  'jse',
  'wsf',
  'wsh',
  'ws',
  'wsc',
  'sct',
  'hta',
  'cpl',
  'dll',
  'sys',
  'lnk',
  'url',
  'pif',
  'reg',
  'jar',
  'app',
  'dmg',
  'pkg',
  'appimage',
  'iso',
  'vhd',
];

/**
 * Last extension after stripping trailing dots and spaces, lower case; unlike `diskExtension` a leading dot counts.
 *
 * @param fileName the file name
 * @returns the extension; null without one
 */
export function importExtension(fileName: string): string | null {
  const trimmed = fileName.replace(/[. ]+$/, '');
  const dot = trimmed.lastIndexOf('.');
  if (dot < 0) return null;
  const extension = trimmed.slice(dot + 1);
  return extension === '' ? null : extension.toLowerCase();
}

/**
 * Whether the name itself has a refused extension.
 *
 * @param name the file name
 * @returns true for a refused extension
 */
function hasRefusedExtension(name: string): boolean {
  const extension = importExtension(name);
  return extension !== null && REFUSED_IMPORT_EXTENSIONS.includes(extension);
}

/**
 * True when the name, or any of its parts between `:` (an NTFS alternate data stream such as `a.exe::$DATA` or
 * `a.exe:stream`, where Windows opens the main stream, also behind a drive such as `C:a.exe::$DATA`), has a refused
 * extension.
 *
 * @param fileName the file name
 * @returns whether the file is refused
 */
export function isRefusedImport(fileName: string): boolean {
  return hasRefusedExtension(fileName) || fileName.split(':').some(hasRefusedExtension);
}

/**
 * True for a ZIP archive by its name; decides both which sources are unpacked and that entries are not.
 *
 * @param fileName the file name
 * @returns whether the name is a ZIP archive's
 */
export function isZipArchive(fileName: string): boolean {
  return importExtension(fileName) === 'zip';
}

/** Message of the result for a file whose type is never imported; contains no path. */
export const REFUSED_IMPORT_MESSAGE: string = new ValidationFailedError('This file type cannot be imported').message;

/**
 * True when a source or archive entry of this name is never imported: by its own name, or by the
 * name it would be stored under, since truncation can drop a long fake extension and expose a
 * refused one (`<96 × a>.exe.<16 × b>` is stored as `<96 × a>.exe`).
 *
 * @param fileName the name of the source or entry
 * @returns whether it is refused
 */
export function isRefusedImportName(fileName: string): boolean {
  return isRefusedImport(fileName) || isRefusedImport(sanitizeFileName(fileName));
}
