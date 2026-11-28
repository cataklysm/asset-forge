import { createHash, type Hash } from 'node:crypto';
import { Transform, type Readable, type Writable } from 'node:stream';

/** The size and checksum of a written file. */
export interface WrittenFile {
  /** The bytes written. */
  sizeBytes: number;
  /** The SHA-256 of the bytes, as lower-case hex. */
  sha256: string;
}

/**
 * The source, the hash, the byte count and the two failures of one `writeStream` call.
 *
 * A failing source is the source's problem, not the workspace storage's: pass it through.
 * A destination failure makes the pipeline destroy the source with that same error, so the
 * destination's error is recorded separately and never counts as the source's.
 */
export class StreamWrite {
  /** The first error the source emitted. */
  private sourceError: unknown;
  /** The destination's own error, when it failed before the source. */
  private destinationError: unknown;
  /** The checksum, created with the hasher. */
  private hash: Hash | undefined;
  /** The bytes passed so far. */
  private sizeBytes = 0;

  /**
   * Starts recording the source's first error.
   *
   * @param source the bytes
   * @param onProgress told the cumulative bytes after every chunk
   */
  constructor(
    readonly source: Readable,
    private readonly onProgress: ((bytesWritten: number) => void) | undefined,
  ) {
    source.once('error', (error) => {
      this.sourceError = error;
    });
  }

  /**
   * The transform that hashes and counts every chunk and reports the progress.
   *
   * @returns the transform
   */
  hasher(): Transform {
    const hash = createHash('sha256');
    this.hash = hash;
    return new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        hash.update(chunk);
        this.sizeBytes += chunk.length;
        this.reportProgress();
        callback(null, chunk);
      },
    });
  }

  /**
   * Records the destination's own error.
   *
   * @param out the file's write stream
   */
  watchDestination(out: Writable): void {
    out.once('error', (error) => {
      // The pipeline also destroys `out` with the source's error; only an error that
      // arrives before any source error is the destination's own.
      if (this.sourceError === undefined) this.destinationError = error;
    });
  }

  /**
   * Whether a failure is the source's own and passes through untranslated.
   *
   * @param error what the write rejected with
   * @returns true for the source's error that is not also the destination's
   */
  isSourceFailure(error: unknown): boolean {
    return error === this.sourceError && error !== this.destinationError;
  }

  /**
   * The size and checksum once the pipe finished.
   *
   * @returns the written file's size and checksum
   */
  written(): WrittenFile {
    return { sizeBytes: this.sizeBytes, sha256: this.hash!.digest('hex') };
  }

  /** Tells the observer the bytes so far; its throw never fails the write. */
  private reportProgress(): void {
    // Called unbound, as the observer always was.
    const onProgress = this.onProgress;
    if (onProgress === undefined) return;
    try {
      onProgress(this.sizeBytes);
    } catch {
      // A progress observer never fails the write.
    }
  }
}
