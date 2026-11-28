import type { FileTarget, SiteImportCandidate } from '@assetforge/contracts';
import type { WorkspaceSession } from './session.js';

/** Backend batch size, independent of the visible file browser's filters and page. */
const FILE_PAGE_SIZE = 500;
/** Endpoint suffixes do not identify the file a download response will name. */
const ENDPOINT_SUFFIX = /\.(?:php\d*|phtml|asp|aspx|ashx|jsp|cgi|do|action|html?)$/i;

/**
 * The decoded filename of an obvious file URL, without guessing from query parameters.
 *
 * @param url the discovered file URL
 * @returns its complete filename; null for an endpoint or ambiguous segment
 */
function obviousName(url: string): string | null {
  try {
    const segment = new URL(url).pathname.split('/').at(-1) ?? '';
    const name = decodeURIComponent(segment);
    if (!/^.+\.[a-z\d]{1,12}$/i.test(name) || /[/\\\u0000-\u001f]/.test(name) || ENDPOINT_SUFFIX.test(name))
      return null;
    return name;
  } catch {
    return null;
  }
}

/**
 * Full filename comparison for the optional convenience rule; no suffix or extension removal.
 *
 * @param name the source filename
 * @returns its Unicode-normalized, case-insensitive comparison key
 */
const filenameKey = (name: string): string => name.normalize('NFC').toLowerCase();

/**
 * Builds review candidates against every current complete, non-trashed file of the captured asset.
 * Does not request remote metadata or treat a filename match as verified file provenance.
 *
 * @param session the captured workspace
 * @param urls raw discovered URLs; excluded candidates remain in the review result
 * @param target the captured asset/role, or the inbox
 * @param sourcePageUrl the source page when no more specific discovery provenance is supplied
 * @returns candidates with obvious names and current filename-match reasons
 */
export async function buildSiteCandidates(
  session: WorkspaceSession,
  urls: readonly string[],
  target: FileTarget | null,
  sourcePageUrl: string,
): Promise<SiteImportCandidate[]> {
  const existing = new Set<string>();
  if (target !== null) {
    for (let offset = 0; ; offset += FILE_PAGE_SIZE) {
      const page = await session.database.files.list({
        scope: { kind: 'asset', assetId: target.assetId },
        limit: FILE_PAGE_SIZE,
        offset,
      });
      for (const file of page.items) {
        if (file.assetId === target.assetId && file.status === 'complete' && file.deletedAt === null) {
          existing.add(filenameKey(file.originalName));
        }
      }
      if (page.items.length === 0 || offset + page.items.length >= page.total) break;
    }
  }
  return urls.map((url) => {
    const expectedName = obviousName(url);
    return {
      url,
      sourcePageUrl,
      expectedName,
      alreadyPresent: expectedName !== null && existing.has(filenameKey(expectedName)),
    };
  });
}

/** Selection and optional filename filtering, including explicit overrides of known matches. */
export interface SiteCandidateSelection {
  selectedUrls?: readonly string[];
  skipExistingNames?: boolean;
  includeExistingUrls?: readonly string[];
}

/**
 * Applies review selection to freshly checked candidates; unreviewed URLs cannot be injected.
 *
 * @param candidates candidates recalculated against the target's current files
 * @param options selected URLs, optional name skipping and individually forced matches
 * @returns the discovered URLs selected for the existing download queue
 */
export function selectedSiteUrls(
  candidates: readonly SiteImportCandidate[],
  options: SiteCandidateSelection,
): string[] {
  const selected = options.selectedUrls === undefined ? null : new Set(options.selectedUrls);
  const included = new Set(options.includeExistingUrls ?? []);
  return candidates
    .filter((candidate) => selected === null || selected.has(candidate.url))
    .filter((candidate) => !options.skipExistingNames || !candidate.alreadyPresent || included.has(candidate.url))
    .map((candidate) => candidate.url);
}
