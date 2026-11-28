import { Readable } from 'node:stream';
import { failure } from './remote-failure.js';

/** The request side of a body: what ends it and where its failure is reported. */
export interface BodyRequest {
  /** Ends the request and its connection; may be called more than once. */
  destroy(): void;
  /** Registers a listener for a failure of the request. */
  onError(listener: () => void): void;
}

/**
 * The response side of a body, as both Node's `http.IncomingMessage` and Electron's net `IncomingMessage` offer it.
 * `complete` is Node's flag; a source without it counts as complete only once it ended.
 */
export interface BodySource {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end' | 'close' | 'aborted', listener: () => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  pause(): unknown;
  resume(): unknown;
  destroy(): unknown;
  readonly complete?: boolean;
}

/** The limits a body is read under. */
export interface BodyLimits {
  /** The most bytes the body may have. */
  maxBytes: number;
  /** How long the body may go without data while it waits for some. */
  idleTimeoutMs: number;
}

/**
 * The body as a stream that counts bytes: past `maxBytes` it fails `too_large`; without data for the idle time
 * while it waits for some, past the total deadline, on a connection error, when the source closes before its end or
 * when it is shorter than `Content-Length` it fails `unreachable`; an abort fails it with the abort reason.
 * Destroying it destroys the request.
 *
 * @param request the request the body belongs to
 * @param response the response whose data is read
 * @param limits the size limit and the idle time
 * @param signal aborts the body with its reason
 * @param deadline the time (ms since the epoch) after which the body fails `unreachable`
 * @param contentLength the announced length; null when unknown
 * @returns a readable stream of the body that fails only with `RemoteFileError` or the abort reason
 */
export function limitedBody(
  request: BodyRequest,
  response: BodySource,
  limits: BodyLimits,
  signal: AbortSignal,
  deadline: number,
  contentLength: number | null,
): Readable {
  return new LimitedBody(request, response, limits, signal, deadline, contentLength).stream;
}

/**
 * The state of one body read under limits. The response is read only once the stream is read; every way the body
 * can end goes through `fail` or `succeed`, which run at most once between them.
 */
class LimitedBody {
  /** The stream handed to the consumer. */
  readonly stream: Readable;
  private readonly request: BodyRequest;
  private readonly response: BodySource;
  private readonly limits: BodyLimits;
  private readonly signal: AbortSignal;
  private readonly contentLength: number | null;
  private readonly totalTimer: NodeJS.Timeout;
  private idleTimer: NodeJS.Timeout | undefined;
  private receivedBytes = 0;
  private isDone = false;
  private isStarted = false;
  private readonly onAbort = (): void => this.fail(this.signal.reason);

  /**
   * Sets up the stream, the total deadline, the abort and the connection listeners.
   *
   * @param request the request the body belongs to
   * @param response the response whose data is read
   * @param limits the size limit and the idle time
   * @param signal aborts the body with its reason
   * @param deadline the time (ms since the epoch) after which the body fails `unreachable`
   * @param contentLength the announced length; null when unknown
   */
  constructor(
    request: BodyRequest,
    response: BodySource,
    limits: BodyLimits,
    signal: AbortSignal,
    deadline: number,
    contentLength: number | null,
  ) {
    this.request = request;
    this.response = response;
    this.limits = limits;
    this.signal = signal;
    this.contentLength = contentLength;
    this.stream = new Readable({
      read: () => this.read(),
      destroy: (error, callback) => this.destroy(error, callback),
    });
    this.totalTimer = setTimeout(() => this.fail(failure('unreachable')), Math.max(0, deadline - Date.now()));
    // A listener added to an aborted signal never fires.
    if (signal.aborted) this.fail(signal.reason);
    else signal.addEventListener('abort', this.onAbort, { once: true });
    this.watchConnection();
  }

  /** The stream wants data: starts reading the response on the first call, then resumes it. */
  private read(): void {
    if (this.isDone) return;
    if (!this.isStarted) {
      this.isStarted = true;
      this.readResponse();
    }
    this.startIdle();
    this.response.resume();
  }

  /**
   * The stream is destroyed, by the consumer or by `fail`: ends the response and the request with it.
   *
   * @param error the error the stream is destroyed with; null without one
   * @param callback completes the destroy
   */
  private destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.isDone) this.finish();
    this.response.destroy();
    this.request.destroy();
    callback(error);
  }

  /** The failures of the connection, watched from the start. */
  private watchConnection(): void {
    // A lost connection before the first read; the body itself is only consumed once the stream is read.
    this.response.on('error', () => this.fail(failure('unreachable')));
    this.response.on('aborted', () => this.fail(failure('unreachable')));
    // After a complete body `end` came first and the stream is done, so this changes nothing then.
    this.response.on('close', () => {
      if (this.response.complete !== true) this.fail(failure('unreachable'));
    });
    this.request.onError(() => this.fail(failure('unreachable')));
  }

  /** Reads the data and the end of the response. */
  private readResponse(): void {
    this.response.on('data', (chunk: Buffer) => this.take(chunk));
    this.response.on('end', () => this.end());
  }

  /**
   * Counts a chunk and hands it on; pauses the response while the consumer wants nothing more.
   *
   * @param chunk the data that arrived
   */
  private take(chunk: Buffer): void {
    if (this.isDone) return;
    this.receivedBytes += chunk.length;
    if (this.receivedBytes > this.limits.maxBytes) {
      this.fail(failure('too_large'));
      return;
    }
    if (this.stream.push(chunk)) {
      this.startIdle();
    } else {
      this.stopIdle();
      this.response.pause();
    }
  }

  /** The response ended: the stream ends too, unless it is shorter than announced. */
  private end(): void {
    if (this.isDone) return;
    if (this.contentLength !== null && this.receivedBytes < this.contentLength) {
      this.fail(failure('unreachable'));
      return;
    }
    this.finish();
    this.stream.push(null);
  }

  /** Waits the idle time for the next data. */
  private startIdle(): void {
    this.stopIdle();
    this.idleTimer = setTimeout(() => this.fail(failure('unreachable')), this.limits.idleTimeoutMs);
  }

  /** Stops waiting for data. */
  private stopIdle(): void {
    clearTimeout(this.idleTimer);
  }

  /** Marks the body done and drops its timers and the abort listener. */
  private finish(): void {
    this.isDone = true;
    this.stopIdle();
    clearTimeout(this.totalTimer);
    this.signal.removeEventListener('abort', this.onAbort);
  }

  /**
   * Ends the stream with `error`. Before the first read the error waits for the next turn of the event loop, so a
   * consumer that attaches its listener right after `open` resolves always receives it.
   *
   * @param error the failure, or the abort reason
   */
  private fail(error: unknown): void {
    if (this.isDone) return;
    this.finish();
    if (this.isStarted) this.stream.destroy(error as Error);
    else setImmediate(() => this.stream.destroy(error as Error));
  }
}
