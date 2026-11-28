import { normalizeSourceUrl } from './asset-sources.js';

/**
 * The URL rule of the import: the rule of asset sources (`normalizeSourceUrl`), then the fragment dropped,
 * since it is never sent. The answer is the identity of a URL everywhere. Throws `validation_failed`.
 *
 * @param input the URL as typed or stored
 * @returns the normalised URL
 * @throws ValidationFailedError for a URL the rule refuses
 */
export function normalizeDownloadUrl(input: string): string {
  const url = new URL(normalizeSourceUrl(input));
  url.hash = '';
  return url.href;
}
