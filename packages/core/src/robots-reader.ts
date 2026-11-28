import type { Readable } from 'node:stream';
import { RemoteFileError, type RemoteFileSource } from './ports/remote-files.js';
import { parseRobots, type RobotsRules } from './robots.js';

/** The most of a robots.txt that is read; the rest is ignored. */
export const ROBOTS_MAX_BYTES = 512 * 1024;

/** What reading a robots.txt gave: its rules, none (404/410), or a failure. */
export type RobotsAnswer = { kind: 'rules'; rules: RobotsRules } | { kind: 'none' } | { kind: 'unavailable' };

/**
 * Reads at most `limit` bytes of `stream` and destroys it once it stops reading, for any reason.
 *
 * @param stream the body of the robots.txt
 * @param limit the most bytes read
 * @param signal aborts the read with its reason
 * @returns the bytes read
 */
function readCapped(stream: Readable, limit: number, signal: AbortSignal): Promise<Buffer> {
  return new CappedRead(stream, limit, signal).result;
}

/** One `readCapped`: collects the chunks up to the limit and settles once. */
class CappedRead {
  /** Settles with the bytes read, or with the error or abort reason that ended the read. */
  readonly result: Promise<Buffer>;
  private readonly stream: Readable;
  private readonly limit: number;
  private readonly signal: AbortSignal;
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private isDone = false;
  private resolve!: (value: Buffer) => void;
  private reject!: (reason: unknown) => void;
  private readonly onError = (error: unknown): void => this.finish(error ?? new Error('stream failed'));
  private readonly onAbort = (): void => this.finish(this.signal.reason);
  private readonly onEnd = (): void => this.finish(undefined, Buffer.concat(this.chunks, this.size));
  private readonly onData = (chunk: Buffer | string): void => this.take(chunk);

  /**
   * Starts reading: settles at once for a destroyed stream or an aborted signal.
   *
   * @param stream the body of the robots.txt
   * @param limit the most bytes read
   * @param signal aborts the read with its reason
   */
  constructor(stream: Readable, limit: number, signal: AbortSignal) {
    this.stream = stream;
    this.limit = limit;
    this.signal = signal;
    this.result = new Promise<Buffer>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.start();
  }

  /** Attaches the listeners, unless the stream is already gone or the signal aborted. */
  private start(): void {
    this.stream.on('error', this.onError);
    if (this.stream.destroyed) {
      // Already gone: no `end` will come, and any error was emitted before this listener.
      this.finish(this.stream.errored ?? new Error('stream destroyed'));
      return;
    }
    if (this.signal.aborted) {
      this.onAbort();
      return;
    }
    this.signal.addEventListener('abort', this.onAbort, { once: true });
    this.stream.on('end', this.onEnd);
    this.stream.on('data', this.onData);
  }

  /**
   * Keeps a chunk; finishes once the limit is reached.
   *
   * @param chunk the data the stream emitted
   */
  private take(chunk: Buffer | string): void {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    const room = this.limit - this.size;
    if (buffer.length >= room) {
      this.chunks.push(buffer.subarray(0, room));
      this.size += room;
      this.finish(undefined, Buffer.concat(this.chunks, this.size));
      return;
    }
    this.chunks.push(buffer);
    this.size += buffer.length;
  }

  /**
   * Settles once: detaches the listeners, destroys the stream, then resolves or rejects.
   *
   * @param error the reason the read failed; undefined on success
   * @param value the bytes read on success
   */
  private finish(error: unknown, value?: Buffer): void {
    if (this.isDone) return;
    this.isDone = true;
    this.signal.removeEventListener('abort', this.onAbort);
    this.stream.off('data', this.onData);
    this.stream.off('end', this.onEnd);
    // A stream destroyed later may still emit an error; keep a listener so it never goes unhandled.
    this.stream.on('error', () => {});
    this.stream.off('error', this.onError);
    this.stream.destroy();
    if (error !== undefined) this.reject(error);
    else this.resolve(value!);
  }
}

/**
 * Reads `<origin>/robots.txt` through `remote` without options (no cookies, the downloader's own user agent),
 * at most ROBOTS_MAX_BYTES; 404/410 answer `none`, any other failure `unavailable`. Rejects only with the abort
 * reason once `signal` aborts. Nothing it answers carries the URL.
 *
 * @param remote the downloader
 * @returns the reader of one origin's robots.txt
 */
export function createRobotsReader(
  remote: RemoteFileSource,
): (origin: string, signal: AbortSignal) => Promise<RobotsAnswer> {
  return (origin, signal) => readRobots(remote, origin, signal);
}

/**
 * Reads and parses one origin's robots.txt.
 *
 * @param remote the downloader
 * @param origin the origin, without a trailing slash
 * @param signal aborts the read
 * @returns the answer
 * @throws the abort reason once `signal` aborts
 */
async function readRobots(remote: RemoteFileSource, origin: string, signal: AbortSignal): Promise<RobotsAnswer> {
  let stream: Readable;
  try {
    const file = await remote.open(`${origin}/robots.txt`, signal);
    stream = file.stream;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof RemoteFileError && error.failure === 'not_found') return { kind: 'none' };
    return { kind: 'unavailable' };
  }
  let body: Buffer;
  try {
    body = await readCapped(stream, ROBOTS_MAX_BYTES, signal);
  } catch {
    if (signal.aborted) throw signal.reason;
    return { kind: 'unavailable' };
  }
  let text = body.toString('utf8');
  if (text.startsWith('﻿')) text = text.slice(1);
  return { kind: 'rules', rules: parseRobots(text) };
}
