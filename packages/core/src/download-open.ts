import { belongsToSite } from '@assetforge/contracts';
import { jobErrorOf } from './download-errors.js';
import { JobError } from './job-types.js';
import {
  RemoteFileError,
  type RemoteFile,
  type RemoteFileSource,
  type RemoteOpenOptions,
  type RemoteRequestHeaders,
} from './ports/remote-files.js';
import type { SiteAccess } from './ports/site-access.js';

// Opening the URL of a `file.download` job: a plain download through the remote source, a site download (payload
// v2) with its profile's login, through the profile's browser session where one exists.

/** The login of a site download (payload v2) while its hops are asked for. */
export interface SiteLogin {
  sites: SiteAccess;
  profileId: string;
  /** The site of the profile, read when the job started. */
  profileSite: string;
  /** Whether the hop asked last went out without the login because it left the profile's site. */
  isLastHopOffSite: boolean;
}

/**
 * The login of a site download.
 *
 * @param sites the site access; undefined where none is wired
 * @param profileId the profile named by the payload
 * @returns the login state; throws `download_profile_missing` without site access or when the profile is gone
 */
export async function siteLoginOf(sites: SiteAccess | undefined, profileId: string): Promise<SiteLogin> {
  const profileSite = sites === undefined ? null : await sites.siteOf(profileId);
  if (sites === undefined || profileSite === null) throw new JobError('download_profile_missing');
  return { sites, profileId, profileSite, isLastHopOffSite: false };
}

/**
 * The headers of one hop of a site download, recording whether the hop left the profile's site.
 *
 * @param login the login state of the download
 * @param hopUrl the URL of the hop
 * @returns the login's headers for the hop; null off the profile's site
 */
async function siteHopHeaders(login: SiteLogin, hopUrl: string): Promise<RemoteRequestHeaders | null> {
  const headers = await login.sites.headersFor(login.profileId, hopUrl);
  login.isLastHopOffSite = !belongsToSite(hopUrl, login.profileSite);
  return headers;
}

/**
 * Opens the URL: a plain download through the remote source, a site download with the profile's login.
 *
 * @param remote the plain network source
 * @param login the login of a site download; null for a plain one
 * @param url the address of the file
 * @param signal aborts the request
 * @returns the opened remote file; a source failure is thrown as its job error
 */
export async function openRemote(
  remote: RemoteFileSource,
  login: SiteLogin | null,
  url: string,
  signal: AbortSignal,
): Promise<RemoteFile> {
  try {
    if (login === null) return await remote.open(url, signal);
    const options: RemoteOpenOptions = { headersFor: (hopUrl) => siteHopHeaders(login, hopUrl) };
    return await openSiteDownload(remote, login, url, signal, options);
  } catch (error) {
    if (!(error instanceof RemoteFileError)) throw error;
    // A refusal of a hop that went out without the login: the login was the likely miss, not the address.
    if (error.failure === 'blocked' && login?.isLastHopOffSite === true) throw new JobError('download_login_not_sent');
    throw jobErrorOf(error);
  }
}

/**
 * Opens a site download: through the profile's browser session where the site access offers one, else through the
 * plain remote source.
 *
 * @param remote the plain network source
 * @param login the login of the download
 * @param url the address of the file
 * @param signal aborts the request
 * @param options the per-hop headers of the profile's login
 * @returns the opened remote file
 */
function openSiteDownload(
  remote: RemoteFileSource,
  login: SiteLogin,
  url: string,
  signal: AbortSignal,
  options: RemoteOpenOptions,
): Promise<RemoteFile> {
  const open = login.sites.open;
  return open === undefined
    ? remote.open(url, signal, options)
    : open.call(login.sites, login.profileId, url, signal, options);
}
