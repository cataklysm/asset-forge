import type { Session } from 'electron';
import type { BodySource } from '@assetforge/storage';

/** The answer of a session request as Electron's net `IncomingMessage` offers it; header names are lower case. */
export interface SessionNetResponse extends BodySource {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[]>;
}

/** The part of Electron's net `ClientRequest` a session download uses. */
export interface SessionNetRequest {
  on(event: 'response', listener: (response: SessionNetResponse) => void): unknown;
  on(
    event: 'redirect',
    listener: (
      statusCode: number,
      method: string,
      redirectUrl: string,
      headers: Record<string, string | string[]>,
    ) => void,
  ): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  abort(): void;
  end(): void;
}

/**
 * The only headers a session request sets itself. The session adds its own cookies and its unchanged user agent;
 * no `Cookie`, `User-Agent` or `Referer` is ever set by hand.
 */
export const SESSION_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  Accept: '*/*',
  'Accept-Encoding': 'identity',
};

/** The options of every session request; nothing else is ever passed to `net.request`. */
export interface SessionRequestOptions {
  method: 'GET';
  url: string;
  session: Session;
  /** Each redirect is reported and aborted; the download vets and sends the next hop itself. */
  redirect: 'manual';
  /** The session's cookies go with the request and cookies it answers are stored, as in the login window. */
  useSessionCookies: true;
  referrerPolicy: 'no-referrer';
  cache: 'no-store';
  headers: Record<string, string>;
}

/**
 * The options of one session request (spec "Browser check").
 *
 * @param session the profile's hardened session
 * @param url the hop
 * @returns the request options; only `Accept` and `Accept-Encoding` are set by hand
 */
export function sessionRequestOptions(session: Session, url: string): SessionRequestOptions {
  return {
    method: 'GET',
    url,
    session,
    redirect: 'manual',
    useSessionCookies: true,
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    headers: { ...SESSION_REQUEST_HEADERS },
  };
}
