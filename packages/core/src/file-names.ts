/** The longest stored file name and workspace folder name, in code points. */
const MAX_LENGTH = 100;
/** The longest extension a truncated file name keeps, in code points. */
const MAX_EXTENSION_LENGTH = 10;

const PLACEHOLDER_STEM = 'file';

/**
 * Turns an arbitrary source name into a single safe path segment: Unicode letters and
 * digits plus `.`, `_` and `-` survive, everything else becomes `_`. Trailing dots and
 * spaces are dropped because Windows drops them when creating the file, which would make
 * the stored relative path differ from the on-disk name.
 *
 * @param name the source name, possibly with a directory
 * @returns the safe file name
 */
export function sanitizeFileName(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const replaced = base.replace(/[. ]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '_');
  const cleaned = cleanStem(replaced);
  if (cleaned === '') return PLACEHOLDER_STEM;
  return truncateKeepingExtension(cleaned);
}

/**
 * A stem made only of replacement characters (e.g. `???.png`) gets a placeholder so the
 * extension survives; a stem of dots only (e.g. `..hidden`) is a leading-dot name.
 *
 * @param replaced the name with its unsafe characters replaced
 * @returns the name without leading dots and underscores, or with the placeholder stem
 */
function cleanStem(replaced: string): string {
  const dot = replaced.lastIndexOf('.');
  const stem = dot > 0 ? replaced.slice(0, dot) : '';
  if (/^[._]+$/.test(stem) && stem.includes('_')) return PLACEHOLDER_STEM + replaced.slice(dot);
  return replaced.replace(/^[._]+/, '');
}

/**
 * Cuts a name to `MAX_LENGTH`, keeping a short extension. Counts code points so truncation never splits a
 * surrogate pair.
 *
 * @param cleaned the cleaned name
 * @returns the name, at most `MAX_LENGTH` code points long
 */
function truncateKeepingExtension(cleaned: string): string {
  const characters = [...cleaned];
  if (characters.length <= MAX_LENGTH) return cleaned;
  const extensionDot = cleaned.lastIndexOf('.');
  const extension =
    extensionDot > 0 && [...cleaned.slice(extensionDot + 1)].length <= MAX_EXTENSION_LENGTH
      ? cleaned.slice(extensionDot)
      : '';
  return (
    characters
      .slice(0, MAX_LENGTH - [...extension].length)
      .join('')
      .replace(/\.+$/, '') + extension
  );
}

const PLACEHOLDER_FOLDER = 'workspace';
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Derives the directory name for a new workspace from its display name. Unlike
 * `sanitizeFileName` it keeps spaces and punctuation, so the folder stays recognisable;
 * only characters and names that a common file system rejects are replaced.
 *
 * @param name the display name of the workspace
 * @returns the folder name
 */
export function workspaceFolderName(name: string): string {
  const replaced = trimDotsAndSpaces(name.replace(/[<>:"/\\|?*\p{Cc}]+/gu, '_').replace(/\s+/g, ' '));
  // Count code points so truncation never splits a surrogate pair.
  const cleaned = trimDotsAndSpaces([...replaced].slice(0, MAX_LENGTH).join(''));
  if (cleaned === '' || /^_+$/.test(cleaned)) return PLACEHOLDER_FOLDER;
  return WINDOWS_DEVICE_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * Drops leading and trailing dots and spaces.
 *
 * @param value the text
 * @returns the trimmed text
 */
function trimDotsAndSpaces(value: string): string {
  return value.replace(/^[. ]+/, '').replace(/[. ]+$/, '');
}
