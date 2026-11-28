import type { Readable } from 'node:stream';
import { RemoteFileError, type RemoteFileSource } from './ports/remote-files.js';
import { parseRobots, type RobotsRules } from './robots.js';

/** The most of a robots.txt that is read; the rest is ignored. */
export const ROBOTS_MAX_BYTES = 512 * 1024;

export type RobotsAnswer = { kind: 'rules'; rules: RobotsRules } | { kind: 'none' } | { kind: 'unavailable' };

/** Reads at most `limit` bytes of `stream` and destroys it once it stops reading, for any reason. */
function readCapped(stream: Readable, limit: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (error: unknown, value?: Buffer) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      stream.off('data', onData);
      stream.off('end', onEnd);
      // A stream destroyed later may still emit an error; keep a listener so it never goes unhandled.
      stream.on('error', () => {});
      stream.off('error', onError);
      stream.destroy();
      if (error !== undefined) reject(error);
      else resolve(value!);
    };
    const onError = (error: unknown) => finish(error ?? new Error('stream failed'));
    const onAbort = () => finish(signal.reason);
    const onEnd = () => finish(undefined, Buffer.concat(chunks, size));
    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const room = limit - size;
      if (buffer.length >= room) {
        chunks.push(buffer.subarray(0, room));
        size += room;
        finish(undefined, Buffer.concat(chunks, size));
        return;
      }
      chunks.push(buffer);
      size += buffer.length;
    };
    stream.on('error', onError);
    if (stream.destroyed) {
      // Already gone: no `end` will come, and any error was emitted before this listener.
      finish(stream.errored ?? new Error('stream destroyed'));
      return;
    }
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    stream.on('end', onEnd);
    stream.on('data', onData);
  });
}

/**
 * Reads `<origin>/robots.txt` through `remote` without options (no cookies, the downloader's own user agent),
 * at most ROBOTS_MAX_BYTES; 404/410 answer `none`, any other failure `unavailable`. Rejects only with the abort
 * reason once `signal` aborts. Nothing it answers carries the URL.
 */
export function createRobotsReader(
  remote: RemoteFileSource,
): (origin: string, signal: AbortSignal) => Promise<RobotsAnswer> {
  return async (origin, signal) => {
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
  };
}
