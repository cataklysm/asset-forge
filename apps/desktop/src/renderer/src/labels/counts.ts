// Counted nouns shared by the label files; not re-exported by `labels.ts`.

/**
 * '1 file' / '12 files'.
 *
 * @param count the number of files
 * @returns the count with the noun in singular or plural
 */
export const fileCount = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;

/**
 * '1 asset' / '12 assets'.
 *
 * @param count the number of assets
 * @returns the count with the noun in singular or plural
 */
export const assetCount = (count: number) => `${count} ${count === 1 ? 'asset' : 'assets'}`;

/**
 * '1 prompt' / '12 prompts'.
 *
 * @param count the number of prompts
 * @returns the count with the noun in singular or plural
 */
export const promptCount = (count: number) => `${count} ${count === 1 ? 'prompt' : 'prompts'}`;
