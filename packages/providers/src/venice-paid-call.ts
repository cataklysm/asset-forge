import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { IMAGE_ANSWER_MAX_BYTES, type JobErrorCode } from '@assetforge/contracts';
import { JobError } from '@assetforge/core';
import { discard } from './response-body.js';
import { declaredLength, nothingSent, paidCode } from './venice-answers.js';
import { authorizationHeaders, type VeniceConnection } from './venice-connection.js';

/** The answer types accepted from an edit or upscale; anything else is an unusable answer. */
const ANSWER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** The image an edit or upscale delivered. */
export interface PaidAnswer {
  /** The image, capped at `IMAGE_ANSWER_MAX_BYTES`. */
  stream: Readable;
  /** Its MIME type, one of `ANSWER_TYPES`. */
  mimeType: string;
}

/**
 * One edit or upscale: the answer is handed over as a capped stream; the timeout runs until it ends.
 *
 * @param connection the base URL, the fetch and the options
 * @param path the endpoint below the base URL
 * @param form the multipart body
 * @param callerSignal aborts the call; an abort rejects with its reason and is not reported
 * @returns the image; rejects with a `JobError` of the failure's code
 */
export function sendPaid(
  connection: VeniceConnection,
  path: string,
  form: FormData,
  callerSignal: AbortSignal,
): Promise<PaidAnswer> {
  return new PaidCall(connection, callerSignal).send(path, form);
}

/**
 * The MIME type of an answer that can be streamed.
 *
 * @param response a successful answer
 * @returns the type; null without a body, with a declared length over the cap or with a type not accepted
 */
function usableAnswerType(response: Response): string | null {
  const length = declaredLength(response);
  const mimeType = (response.headers.get('content-type') ?? 'image/png').split(';')[0]!.trim().toLowerCase();
  if (!response.body || (length !== null && length > IMAGE_ANSWER_MAX_BYTES) || !ANSWER_TYPES.has(mimeType)) {
    return null;
  }
  return mimeType;
}

/** The time limit, the HTTP status and the one failure report of one paid request. */
class PaidCall {
  /** Aborted when the time limit runs out. */
  private readonly timeout = new AbortController();
  /** The time limit's timer, started by `send`. */
  private timer: NodeJS.Timeout | undefined;
  /** The answer's HTTP status once it arrived. */
  private status: number | null = null;
  /** The failure was reported; at most one report per call. */
  private isReported = false;

  /**
   * @param connection the base URL, the fetch and the options
   * @param callerSignal aborts the call
   */
  constructor(
    private readonly connection: VeniceConnection,
    private readonly callerSignal: AbortSignal,
  ) {}

  /**
   * Sends the request and hands over the answer's image.
   *
   * @param path the endpoint below the base URL
   * @param form the multipart body
   * @returns the image
   */
  async send(path: string, form: FormData): Promise<PaidAnswer> {
    this.callerSignal.throwIfAborted();
    this.timer = setTimeout(() => this.timeout.abort(), this.connection.options.timeoutMs);
    const signal = AbortSignal.any([this.callerSignal, this.timeout.signal]);
    let isHandedOver = false;
    try {
      const requestHeaders = authorizationHeaders(this.connection.options);
      if (typeof requestHeaders === 'string') throw this.failure(requestHeaders);

      const fetchImpl = this.connection.fetchImpl;
      let response: Response;
      try {
        response = await fetchImpl(`${this.connection.base}${path}`, {
          method: 'POST',
          headers: requestHeaders,
          body: form,
          signal,
          redirect: 'manual',
        });
      } catch (error) {
        // Only a connection that was never made is safe to repeat; anything else may have been charged.
        throw this.failure(
          !this.timeout.signal.aborted && nothingSent(error) ? 'provider_unreachable' : 'provider_outcome_unknown',
        );
      }
      this.status = response.status;

      const code = paidCode(response);
      if (code !== null) {
        await discard(response);
        throw this.failure(code);
      }
      const mimeType = usableAnswerType(response);
      if (mimeType === null) {
        await discard(response);
        throw this.failure('provider_outcome_unknown');
      }

      const stream = this.cappedStream(response.body as WebReadableStream<Uint8Array>);
      isHandedOver = true;
      return { stream, mimeType };
    } finally {
      if (!isHandedOver) clearTimeout(this.timer);
    }
  }

  /**
   * The answer's body as a stream that fails past the cap; its end clears the time limit.
   *
   * @param body the answer's body
   * @returns the capped stream
   */
  private cappedStream(body: WebReadableStream<Uint8Array>): Readable {
    const source = Readable.fromWeb(body);
    let total = 0;
    const stream = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        total += chunk.length;
        if (total > IMAGE_ANSWER_MAX_BYTES) callback(this.failure('provider_outcome_unknown') as Error);
        else callback(null, chunk);
      },
    });
    // A cut connection, the timeout or a caller abort while the answer streams.
    source.on('error', () => stream.destroy(this.failure('provider_outcome_unknown') as Error));
    stream.on('close', () => {
      clearTimeout(this.timer);
      source.destroy();
    });
    source.pipe(stream);
    return stream;
  }

  /**
   * The error a failure rejects with, reported once. A caller abort is not a provider failure: it rejects with the
   * caller's reason and is not reported.
   *
   * @param code the failure's code
   * @returns the caller's abort reason, or a `JobError` without a cause
   */
  private failure(code: JobErrorCode): unknown {
    if (this.callerSignal.aborted) return this.callerSignal.reason;
    if (!this.isReported) {
      this.isReported = true;
      this.connection.options.onFailure?.(code, this.status);
    }
    // No cause: a fetch error may quote the request, and the request carries the key.
    return new JobError(code);
  }
}
