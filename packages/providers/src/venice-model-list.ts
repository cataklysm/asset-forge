import type { ImageModel, JobErrorCode } from '@assetforge/contracts';
import { JobError } from '@assetforge/core';
import { LIST_MODELS_TIMEOUT_MS } from './list-timeout.js';
import { discard, readCapped, ResponseTooLarge } from './response-body.js';
import { listCode } from './venice-answers.js';
import { authorizationHeaders, type VeniceConnection } from './venice-connection.js';
import { modelsOfAnswer } from './venice-models.js';

/** Upper bound for a model list answer. */
const MAX_LIST_BYTES = 4 * 1024 * 1024;

/**
 * The edit models through `GET /models?type=inpaint`, bounded by the shorter of the entry's timeout and
 * `LIST_MODELS_TIMEOUT_MS`.
 *
 * @param connection the base URL, the fetch and the options
 * @param callerSignal aborts the call; an abort rejects with its reason and is not reported
 * @returns the models; rejects with a `JobError` of the failure's code
 */
export function listEditModels(connection: VeniceConnection, callerSignal: AbortSignal): Promise<ImageModel[]> {
  return new ModelListCall(connection, callerSignal).send();
}

/** The deadline and the HTTP status of one model list request. */
class ModelListCall {
  /** Aborted when the deadline runs out. */
  private readonly deadline = new AbortController();
  /** The answer's HTTP status once it arrived. */
  private status: number | null = null;

  /**
   * @param connection the base URL, the fetch and the options
   * @param callerSignal aborts the call
   */
  constructor(
    private readonly connection: VeniceConnection,
    private readonly callerSignal: AbortSignal,
  ) {}

  /**
   * Sends the request and parses the answer.
   *
   * @returns the models
   */
  async send(): Promise<ImageModel[]> {
    this.callerSignal.throwIfAborted();
    const { options } = this.connection;
    const timer = setTimeout(() => this.deadline.abort(), Math.min(options.timeoutMs, LIST_MODELS_TIMEOUT_MS));
    const signal = AbortSignal.any([this.callerSignal, this.deadline.signal]);

    try {
      const requestHeaders = authorizationHeaders(options);
      if (typeof requestHeaders === 'string') throw this.failure(requestHeaders);
      const fetchImpl = this.connection.fetchImpl;
      let response: Response;
      try {
        response = await fetchImpl(`${this.connection.base}/models?type=inpaint`, {
          method: 'GET',
          headers: requestHeaders,
          signal,
          redirect: 'manual',
        });
      } catch {
        throw this.failure('provider_unreachable');
      }
      this.status = response.status;

      const code = listCode(response);
      if (code !== null) {
        await discard(response);
        throw this.failure(code);
      }
      let text: string;
      try {
        text = await readCapped(response, MAX_LIST_BYTES);
      } catch (error) {
        throw this.failure(error instanceof ResponseTooLarge ? 'invalid_response' : 'provider_unreachable');
      }
      const models = modelsOfAnswer(text);
      if (models === null) throw this.failure('invalid_response');
      return models;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The error a failure rejects with, reported every time; once the deadline ran out the code is
   * `provider_timeout`, reported without a status.
   *
   * @param code the failure's code
   * @returns the caller's abort reason, or a `JobError` without a cause
   */
  private failure(code: JobErrorCode): unknown {
    if (this.callerSignal.aborted) return this.callerSignal.reason;
    const reported = this.deadline.signal.aborted ? 'provider_timeout' : code;
    this.connection.options.onFailure?.(reported, reported === 'provider_timeout' ? null : this.status);
    return new JobError(reported);
  }
}
