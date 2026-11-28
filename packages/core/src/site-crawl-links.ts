import { belongsToSite, type SiteProfile } from '@assetforge/contracts';
import { ValidationFailedError } from './errors.js';
import { normalizeDownloadUrl } from './download-url.js';
import { fileKind } from './media-types.js';

/** The message for an unusable or off-site gallery URL. */
const OFF_SITE = "This address does not belong to the profile's site";

/** The kinds the extension rule decides at crawl time; any other URL passes and is decided at download. */
export const DECIDED_KINDS = new Set(['image', 'video', 'model', 'document']);

/**
 * The final URL of a loaded page as the crawl compares pages: normalised, and only when it belongs to the site.
 *
 * @param finalUrl the main frame's URL after the load, as the page loader reported it
 * @param site the profile's site
 * @returns the normalised URL; null when it is no URL or not on the site
 */
export function finalPageOf(finalUrl: string, site: string): string | null {
  let url: string;
  try {
    url = normalizeDownloadUrl(finalUrl);
  } catch {
    return null;
  }
  return belongsToSite(url, site) ? url : null;
}

/**
 * The file kind the name rule gives the last path segment of a URL.
 *
 * @param url a normalised URL
 * @returns the kind
 */
export function kindOfUrl(url: string): string {
  const path = new URL(url).pathname;
  let name = path.slice(path.lastIndexOf('/') + 1);
  try {
    name = decodeURIComponent(name);
  } catch {
    // Keep the raw segment.
  }
  return fileKind(name);
}

/**
 * The normalised gallery URL a crawl of `url` would start from. Throws ValidationFailedError with the fixed
 * off-site message for anything that is no usable URL or does not belong to the profile's site, so a caller can
 * refuse it before any page window opens.
 *
 * @param profile the profile, for its site
 * @param url the gallery URL as typed
 * @returns the normalised gallery URL
 * @throws ValidationFailedError for an unusable or off-site URL
 */
export function siteGalleryUrl(profile: Pick<SiteProfile, 'site'>, url: string): string {
  let galleryUrl: string;
  try {
    galleryUrl = normalizeDownloadUrl(url);
  } catch {
    throw new ValidationFailedError(OFF_SITE);
  }
  if (!belongsToSite(galleryUrl, profile.site)) throw new ValidationFailedError(OFF_SITE);
  return galleryUrl;
}

/**
 * Origin and path of a URL, the part robots rules and a redirect check look at.
 *
 * @param url a URL
 * @returns origin and path without query or fragment
 */
export function originAndPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}
