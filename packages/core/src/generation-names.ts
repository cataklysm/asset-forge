/**
 * A file name without its last extension; a leading dot does not start an extension.
 *
 * @param name a file name
 * @returns the name before the last dot, or the whole name when there is none past the first character
 */
function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The file extension of each image type a result may be stored as. */
export const GENERATION_RESULT_EXTENSIONS: Readonly<Record<string, 'png' | 'jpg' | 'webp'>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** The names a generation stores its result under; `extension` follows the answer's image type (default PNG). */
export const generationNames = {
  /**
   * The name of an edit result.
   *
   * @param sourceName the name of the source file
   * @param rank the number of this edit of the source
   * @param extension the extension of the result
   * @returns `<source name> edit <rank>.<extension>`
   */
  edit: (sourceName: string, rank: number, extension = 'png') => `${baseName(sourceName)} edit ${rank}.${extension}`,
  /**
   * The name of an upscale result.
   *
   * @param sourceName the name of the source file
   * @param scale the upscale factor
   * @param extension the extension of the result
   * @returns `<source name> <scale>x.<extension>`
   */
  upscale: (sourceName: string, scale: 2 | 4, extension = 'png') => `${baseName(sourceName)} ${scale}x.${extension}`,
};
