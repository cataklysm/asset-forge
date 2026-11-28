import type { SiteCrawlProblemReason } from '@assetforge/contracts';

/** The import from a gallery through a site profile (SiteImportDialog) and its entry buttons. */
export const SITE_IMPORT_LABEL = 'Import from site';
export const SITE_PROFILE_LABEL = 'Profile';
export const NEW_SITE_PROFILE_OPTION = 'New profile';
export const NEW_SITE_PROFILE_LABEL = 'New';
export const NEW_SITE_PROFILE_TITLE = 'Adds a profile';
export const SITE_PROFILE_NAME_LABEL = 'Name';
export const SITE_ADDRESS_LABEL = 'Site address';
export const SITE_ADDRESS_TITLE = 'Any address of the site; the profile reads only this site and its subdomains';
export const SITE_LABEL = 'Site';
export const THUMBNAILS_XPATH_LABEL = 'Thumbnails XPath';
export const THUMBNAILS_XPATH_TITLE = 'Selects the links of the gallery';
export const PAGINATION_XPATH_LABEL = 'Pagination XPath';
export const PAGINATION_XPATH_TITLE = 'Selects the links to further gallery pages; empty for one page';
export const FILE_XPATH_LABEL = 'File XPath';
export const FILE_XPATH_TITLE = 'Selects the file on a detail page; empty when a gallery link is the file';
export const SITE_KINDS_LABEL = 'Kinds';
export const MIN_SIZE_LABEL = 'Min. size';
export const MIN_SIZE_TITLE = 'In KB; smaller files are not kept';
export const URL_CONTAINS_LABEL = 'URL contains';
export const URL_CONTAINS_TITLE = 'A file address must contain this text, regardless of case';
export const MAX_PAGES_LABEL = 'Max. pages';
export const MAX_PAGES_TITLE = 'Gallery pages read at most';
export const MAX_FILES_LABEL = 'Max. files';
export const MAX_FILES_TITLE = 'Files found at most';
export const SAVE_SITE_PROFILE_TITLE = 'Saves the profile';
export const DELETE_SITE_PROFILE_TITLE = 'Deletes the profile and its login; asks first';
export const LOG_IN_LABEL = 'Log in';
export const LOG_IN_TITLE = 'Opens the site in a window of the app to log in';
export const OPEN_SITE_LABEL = 'Open site';
export const OPEN_SITE_TITLE = 'Opens the site so you can pass its check; Resume then repeats the refused downloads';
export const GALLERY_URL_LABEL = 'Gallery URL';
export const GALLERY_URL_TITLE = 'The first page of the gallery';
export const SITE_TEST_LABEL = 'Test';
export const SITE_TEST_TITLE = 'Shows which files would be imported; downloads nothing';
export const SITE_IMPORT_TITLE = 'Queues the found files; needs a test of the saved profile and this address';
export const CRAWL_PROGRESS_LABEL = 'Test progress';
export const CRAWL_CANCEL_LABEL = 'Cancel';
export const CRAWL_CANCEL_TITLE = 'Stops the test and keeps what was found';
export const FOUND_FILES_LABEL = 'Found files';

/**
 * '3 pages, 40 files'.
 *
 * @param pages the number of gallery pages read so far
 * @param files the number of files found so far
 * @returns the progress text of a running test
 */
export function crawlProgressText(pages: number, files: number): string {
  return `${pages} pages, ${files} files`;
}

/**
 * 'Delete profile Shop?'.
 *
 * @param name the site profile's name
 * @returns the title of the delete confirmation
 */
export function deleteSiteProfileTitle(name: string): string {
  return `Delete profile ${name}?`;
}

/** The count lines of a test answer, in their order: 'Pages 3'. Pages and Files always, the others above 0. */
export const SITE_CRAWL_COUNT_LABELS = {
  pages: 'Pages',
  files: 'Files',
  duplicates: 'Duplicates',
  filtered: 'Filtered',
  disallowed: 'Disallowed',
  invalid: 'Not usable',
  pageFailures: 'Page failures',
} as const;
/** Why a test stopped early, and the mark of a cancelled one. */
export const CRAWL_TRUNCATED_LABELS = { pages: 'Stopped at Max. pages', files: 'Stopped at Max. files' } as const;
export const CRAWL_CANCELLED_LABEL = 'Cancelled';

/** The list of why pages or addresses of a test gave nothing. */
export const CRAWL_PROBLEMS_LABEL = 'Problems';

/**
 * 'and 12 more': the problems the answer only counted.
 *
 * @param count the number of problems left out of the list
 * @returns the closing line of the problem list
 */
export function moreProblemsText(count: number): string {
  return `and ${count} more`;
}

/** One problem line per reason; `detail` is the host, the status or the found value (spec "Diagnostics"). */
export const CRAWL_PROBLEM_TEXTS: Record<SiteCrawlProblemReason, (detail: string) => string> = {
  no_thumbnails: () => 'No thumbnail matched on this page',
  no_file: () => 'No file matched on this page',
  timeout: () => 'The page did not finish loading',
  left_site: (host) => (host === '' ? 'Redirected off the site' : `Redirected to ${host}`),
  http_error: (status) => `The site answered HTTP ${status}`,
  load_failed: () => 'The page could not be loaded',
  robots_disallowed: () => 'Disallowed by robots.txt',
  robots_unavailable: (host) =>
    host === '' ? 'robots.txt could not be read' : `robots.txt of ${host} could not be read`,
  invalid_link: (value) => `Not a usable link: ${value}`,
  off_site: () => 'Link leaves the site',
  filtered_kind: () => 'Left out by the kinds filter',
  filtered_text: () => 'Left out by the address filter',
};

/** The headline of a test that found no file. */
export const NO_FILES_FOUND_LABEL = 'No files found';
export const NO_THUMBNAILS_HEADLINE =
  'No thumbnail matched. The login may have expired, or the expression does not fit';

/**
 * 'The site redirected to login.example.com. Log in again'.
 *
 * @param host the host the page was redirected to, or '' when unknown
 * @returns the headline of a test that left the site
 */
export function leftSiteHeadline(host: string): string {
  return host === '' ? 'The site redirected elsewhere. Log in again' : `The site redirected to ${host}. Log in again`;
}

/**
 * 'The site refused the page (HTTP 403). Log in again'.
 *
 * @param status the HTTP status of the refused page
 * @returns the headline of a test whose page was refused
 */
export function refusedPageHeadline(status: string): string {
  return `The site refused the page (HTTP ${status}). Log in again`;
}
