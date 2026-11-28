import type { Readable } from 'node:stream';

/**
 * Why a remote file could not be fetched; each maps to exactly one job error code (`download_<failure>`, and
 * `challenge`, a browser check such as `cf-mitigated: challenge`, to `download_browser_check`).
 */
export type RemoteFileFailure =
  | 'challenge'
  | 'unreachable'
  | 'unavailable'
  | 'throttled'
  | 'blocked'
  | 'not_found'
  | 'rejected'
  | 'address_refused'
  | 'too_large';

/** The typed failure of a `RemoteFileSource`. Its message is the failure kind only, never a URL or an address. */
export class RemoteFileError extends Error {
  constructor(
    readonly failure: RemoteFileFailure,
    /** For `throttled`: how long the server asked to wait; null when it did not say. */
    readonly retryAfterMs: number | null = null,
    options?: { cause?: unknown; status?: number },
  ) {
    super(`Remote file failure: ${failure}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.status = options?.status ?? null;
    this.name = new.target.name;
  }

  /** The HTTP status behind the failure; null when no answer caused it or the source did not say. */
  readonly status: number | null;
}

/** An opened remote file: the response headers are in, the body is `stream`. */
export interface RemoteFile {
  /** Fails with RemoteFileError('too_large') past the size limit and ('unreachable') on a stall or a lost connection. */
  stream: Readable;
  /** The address after redirects; used only to name the file. */
  finalUrl: string;
  /** Lower case, without parameters. */
  contentType: string | null;
  contentLength: number | null;
  /** Raw file name from Content-Disposition. */
  dispositionName: string | null;
}

/** Headers a site profile's login adds to one request; never logged, stored or sent over IPC. */
export interface RemoteRequestHeaders {
  cookie?: string;
  userAgent?: string;
}

export interface RemoteOpenOptions {
  /** Asked once per hop with that hop's URL; null sends the request as without options. */
  headersFor?: (url: string) => Promise<RemoteRequestHeaders | null>;
}

/** The network behind the URL import. */
export interface RemoteFileSource {
  /** Rejects with RemoteFileError, or with the abort reason once `signal` aborts. */
  open(url: string, signal: AbortSignal, options?: RemoteOpenOptions): Promise<RemoteFile>;
}
