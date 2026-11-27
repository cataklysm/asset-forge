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
  maxBytes: number;
  idleTimeoutMs: number;
}

/**
 * The body as a stream that counts bytes: past `maxBytes` it fails `too_large`; without data for the idle time
 * while it waits for some, past the total deadline, on a connection error, when the source closes before its end or
 * when it is shorter than `Content-Length` it fails `unreachable`; an abort fails it with the abort reason.
 * Destroying it destroys the request.
 *
 * @param req the request the body belongs to
 * @param res the response whose data is read
 * @param config the size limit and the idle time
 * @param signal aborts the body with its reason
 * @param deadline the time (ms since the epoch) after which the body fails `unreachable`
 * @param contentLength the announced length; null when unknown
 * @returns a readable stream of the body that fails only with `RemoteFileError` or the abort reason
 */
export function limitedBody(
  req: BodyRequest,
  res: BodySource,
  config: BodyLimits,
  signal: AbortSignal,
  deadline: number,
  contentLength: number | null,
): Readable {
  let received = 0;
  let done = false;
  let started = false;
  let idle: NodeJS.Timeout | undefined;

  const stopIdle = () => clearTimeout(idle);
  const startIdle = () => {
    stopIdle();
    idle = setTimeout(() => fail(failure('unreachable')), config.idleTimeoutMs);
  };
  const finish = () => {
    done = true;
    stopIdle();
    clearTimeout(total);
    signal.removeEventListener('abort', onAbort);
  };
  /**
   * Ends the stream with `error`. Before the first read the error waits for the next turn of the event loop, so a
   * consumer that attaches its listener right after `open` resolves always receives it.
   */
  const fail = (error: unknown) => {
    if (done) return;
    finish();
    if (started) out.destroy(error as Error);
    else setImmediate(() => out.destroy(error as Error));
  };

  const out = new Readable({
    read() {
      if (done) return;
      if (!started) {
        started = true;
        attach();
      }
      startIdle();
      res.resume();
    },
    destroy(error, callback) {
      if (!done) finish();
      res.destroy();
      req.destroy();
      callback(error);
    },
  });

  const onAbort = () => fail(signal.reason);
  const total = setTimeout(() => fail(failure('unreachable')), Math.max(0, deadline - Date.now()));
  // A listener added to an aborted signal never fires.
  if (signal.aborted) fail(signal.reason);
  else signal.addEventListener('abort', onAbort, { once: true });
  // A lost connection before the first read; the body itself is only consumed once the stream is read.
  res.on('error', () => fail(failure('unreachable')));
  res.on('aborted', () => fail(failure('unreachable')));
  // After a complete body `end` came first and the stream is done, so this changes nothing then.
  res.on('close', () => {
    if (res.complete !== true) fail(failure('unreachable'));
  });
  req.onError(() => fail(failure('unreachable')));
  return out;

  function attach(): void {
    res.on('data', (chunk: Buffer) => {
      if (done) return;
      received += chunk.length;
      if (received > config.maxBytes) {
        fail(failure('too_large'));
        return;
      }
      if (out.push(chunk)) {
        startIdle();
      } else {
        stopIdle();
        res.pause();
      }
    });
    res.on('end', () => {
      if (done) return;
      if (contentLength !== null && received < contentLength) {
        fail(failure('unreachable'));
        return;
      }
      finish();
      out.push(null);
    });
  }
}
