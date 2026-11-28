import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPublicAddress } from '@assetforge/storage';

// The decisions of a site session's request filter (spec "Browser sessions"): pure functions and a host vetter.

/** What a page window never fetches: the crawl reads links, nobody looks at the page. */
const PAGE_BLOCKED_TYPES = new Set(['image', 'media', 'font']);

/**
 * Whether the hidden page window leaves a sub-resource of this type unloaded. The login window loads everything.
 *
 * @param resourceType Electron's resource type of the request
 * @returns true when the page window cancels the request
 */
export const pageResourceBlocked = (resourceType: string): boolean => PAGE_BLOCKED_TYPES.has(resourceType);

/** The first verdict on a request: allowed, refused, or depending on the addresses of `host`. */
export type RequestDecision = 'allow' | 'refuse' | { host: string };

/** Sub-resource types that may be `data:` or `blob:`; a frame never may. */
const FRAME_TYPES = new Set(['mainFrame', 'subFrame']);

/**
 * The first step of the session's request filter: only http/https, plus `data:` and `blob:` for sub-resources. An
 * IP literal is decided at once by `isPublicAddress`; any other host has to be resolved (`{ host }`).
 *
 * @param url the URL of the request
 * @param resourceType Electron's resource type of the request
 * @returns the decision
 */
export function requestDecision(url: string, resourceType: string): RequestDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'refuse';
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:')
    return FRAME_TYPES.has(resourceType) ? 'refuse' : 'allow';
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'refuse';
  if (parsed.username !== '' || parsed.password !== '') return 'refuse';
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === '') return 'refuse';
  if (isIP(host) !== 0) return isPublicAddress(host) ? 'allow' : 'refuse';
  return { host };
}

/** Resolves a host name to its addresses. */
export type HostResolver = (host: string) => Promise<string[]>;

/**
 * The resolver used when none is injected.
 *
 * @param host the host name to resolve
 * @returns every address the system resolver answers, in its order
 */
async function systemResolver(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
}

/** Hosts one session remembers before it starts over; a page never comes close. */
const HOST_CACHE_MAX = 10_000;

/**
 * Vets a host for a session: allowed only when it resolves to at least one address and every address passes
 * `isPublicAddress`. A verdict is kept for the session's life; a failed resolution refuses and is not kept, so the
 * next request asks again.
 *
 * @param resolve the resolver; defaults to the system resolver
 * @returns the vetter, answering true for an allowed host
 */
export function createHostVetter(resolve: HostResolver = systemResolver): (host: string) => Promise<boolean> {
  const verdicts = new Map<string, Promise<boolean>>();
  return (host) => vetHost(verdicts, resolve, host);
}

/**
 * One question to the host vetter: the kept verdict, else a new one that is kept unless the resolution fails.
 *
 * @param verdicts the verdicts of the session, cleared once they reach `HOST_CACHE_MAX`
 * @param resolve the resolver
 * @param host the host of the request
 * @returns true when the host resolves and every address of it is public
 */
function vetHost(verdicts: Map<string, Promise<boolean>>, resolve: HostResolver, host: string): Promise<boolean> {
  const known = verdicts.get(host);
  if (known !== undefined) return known;
  if (verdicts.size >= HOST_CACHE_MAX) verdicts.clear();
  const verdict = resolve(host).then(
    (addresses) => addresses.length > 0 && addresses.every((address) => isPublicAddress(address)),
    () => {
      verdicts.delete(host);
      return false;
    },
  );
  verdicts.set(host, verdict);
  return verdict;
}
