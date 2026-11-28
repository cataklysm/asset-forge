import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { resolveRange, type ByteRange, type RangeRequest } from './byte-range.js';

// Opening a file of the media protocol as a stream, whole or one byte range.

/** A file opened for streaming. */
export interface OpenedFile {
  /** Size of the whole file. */
  size: number;
  /** Exactly the bytes of `range` (or the whole file without one); null when the range cannot be satisfied. */
  stream: ReadableStream<Uint8Array> | null;
  /** The resolved range; null when none was asked or it cannot be satisfied. */
  range: ByteRange | null;
}

/**
 * Opens a file for streaming. The size comes from the open handle; the handle is closed when the
 * stream ends, errors or is cancelled. Rejects (with the handle closed) when the file cannot be
 * opened or is not a regular file, so the caller can answer 404 before any response exists.
 *
 * With a range the stream reads exactly the resolved bytes and nothing outside them; a range that cannot
 * be satisfied closes the handle at once and answers the size without a stream.
 *
 * @param path the absolute path of the file
 * @param range the range asked for, if any
 * @returns the size, the stream and the resolved range
 */
export async function openFile(path: string, range?: RangeRequest): Promise<OpenedFile> {
  const handle = await open(path, 'r');
  let size: number;
  let resolved: ByteRange | null = null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Not a regular file');
    size = stat.size;
    if (range !== undefined) {
      resolved = resolveRange(range, size);
      if (resolved === null) {
        await handle.close();
        return { size, stream: null, range: null };
      }
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  const options = resolved === null ? { autoClose: true } : { autoClose: true, start: resolved.start, end: resolved.end };
  const stream = Readable.toWeb(handle.createReadStream(options));
  return { size, stream: stream as ReadableStream<Uint8Array>, range: resolved };
}
