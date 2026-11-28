import net from 'node:net';
import type { RemoteOpenOptions, RemoteRequestHeaders } from '@assetforge/core';
import { bounded } from './bounded.js';
import { bareHost } from './hop-request.js';
import { failure } from './remote-failure.js';

// The rules every hop of a download passes, shared by the Node source and the session download of the site
// profiles so the two can never drift apart. None of them logs, and no failure carries a URL or an address.

/** How a hop's host is vetted. */
export interface HopAddressPolicy {
  /** Resolves a host name to its addresses; may throw or reject. */
  lookup(host: string): Promise<string[]>;
  /** Whether one resolved address may be reached. */
  allowAddress(address: string): boolean;
}

/**
 * The URL rule of one hop: parsable, `http:` or `https:`, no user info.
 *
 * @param text the URL or redirect target
 * @param base the URL a relative target is resolved against
 * @returns the parsed URL
 * @throws RemoteFileError `rejected` for anything else
 */
export function parseHop(text: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(text, base);
  } catch {
    throw failure('rejected');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw failure('rejected');
  if (url.username !== '' || url.password !== '') throw failure('rejected');
  return url;
}

/**
 * Vets the host of a hop: an IP literal, or every address it resolves to, must pass the address policy.
 *
 * @param url the hop
 * @param policy the resolver and the address policy
 * @param signal aborts the lookup with its reason
 * @param until the hop's deadline
 * @returns the literal, or the first of the resolved addresses once all of them passed; rejects `address_refused`,
 *   or `unreachable` when the host does not resolve or the lookup fails
 */
export async function vetHopHost(
  url: URL,
  policy: HopAddressPolicy,
  signal: AbortSignal,
  until: number,
): Promise<string> {
  const host = bareHost(url);
  const addresses =
    net.isIP(host) !== 0
      ? [host]
      : await bounded(
          Promise.resolve().then(() => policy.lookup(host)),
          signal,
          until,
        );
  if (addresses.length === 0) throw failure('unreachable');
  if (!addresses.every((address) => typeof address === 'string' && policy.allowAddress(address))) {
    throw failure('address_refused');
  }
  return addresses[0]!;
}

/**
 * Asks the caller's callback for the headers of exactly this hop's URL, bounded by the hop's deadline.
 *
 * @param url the hop
 * @param headersFor the caller's callback; undefined asks nothing
 * @param signal aborts the wait with its reason
 * @param until the hop's deadline
 * @returns the callback's answer as it came, not yet checked; undefined without a callback. A rejecting callback
 *   fails the hop `unreachable` without a cause
 */
export async function askHopHeaders(
  url: URL,
  headersFor: RemoteOpenOptions['headersFor'],
  signal: AbortSignal,
  until: number,
): Promise<RemoteRequestHeaders | null | undefined> {
  if (headersFor === undefined) return undefined;
  return bounded(
    Promise.resolve().then(() => headersFor(url.href)),
    signal,
    until,
  );
}
