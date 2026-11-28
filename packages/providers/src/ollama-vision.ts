import { ModelNameSchema, type JobErrorCode, type VisionRequestOptions } from '@assetforge/contracts';
import { JobError, type VisionProvider } from '@assetforge/core';
import { createJsonRequester, type JsonRequest } from './json-request.js';
import { listTimeoutOf, MAX_TIMER_MS } from './list-timeout.js';
import { composeBody, DEFAULT_REQUEST_OPTIONS, ollamaFixedFields } from './request-options.js';

/** The provider id of an Ollama entry, part of the analysis fingerprint. */
export const OLLAMA_PROVIDER = 'ollama';

/** The time limit of a chat request when none is configured. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Keys of an Ollama chat body whose objects `extra` merges into rather than replaces. */
const OLLAMA_DEEP_KEYS = ['options'] as const;

/** `listModels` asks `/api/show` for at most this many models, this many at a time, each within its own limit. */
const MAX_LISTED_MODELS = 100;
/** How many `/api/show` requests run at a time. */
const SHOW_CONCURRENCY = 4;
/** The time limit of one `/api/show` request. */
const SHOW_TIMEOUT_MS = 10_000;

/** What `createOllamaVision` is configured with. */
export interface OllamaVisionOptions {
  /** The entry's base URL; the key goes to this origin only. */
  baseUrl: string;
  /** The API key in force at call time; null for none. */
  apiKey?: () => string | null;
  /** The time limit of a chat request; default 120 s. */
  timeoutMs?: number;
  /**
   * Bound for the whole `listModels` call, capped at the largest timer delay; default (also for a value that is not
   * finite or below 1) `min(timeoutMs, LIST_MODELS_TIMEOUT_MS)`.
   */
  listTimeoutMs?: number;
  /** Replaces the global fetch, for tests. */
  fetch?: typeof fetch;
  /** Told the code and HTTP status of every failed call. */
  onFailure?: (code: JobErrorCode, status: number | null) => void;
  /** Temperature, length, thinking and extra fields of every chat request; default `DEFAULT_REQUEST_OPTIONS`. */
  requestOptions?: VisionRequestOptions;
}

/** One chat request: the image, the prompt, the model and the caller's signal. */
interface ChatInput {
  /** The image's bytes, sent as Base64. */
  image: Uint8Array;
  /** The prompt text. */
  prompt: string;
  /** The model name. */
  model: string;
  /** Aborts the request. */
  signal: AbortSignal;
}

/** The next index `showModels` workers take; shared between the workers of one list call. */
interface ShowCursor {
  /** The index of the next model to ask about. */
  next: number;
}

/** One listed model with its vision capability, null when unknown. */
type VisionModel = Awaited<ReturnType<VisionProvider['listModels']>>[number];

/** What a requester of `createJsonRequester` is. */
type JsonRequester = ReturnType<typeof createJsonRequester>;

/**
 * A `VisionProvider` over Ollama's `POST /api/chat`, `GET /api/tags` and `POST /api/show`.
 * The key, when there is one, is sent as a bearer token on every request and only to `baseUrl`.
 *
 * @param options the base URL, the key supplier, the time limits, the fetch, the failure report and the request
 *   options
 * @returns the provider
 */
export function createOllamaVision(options: OllamaVisionOptions): VisionProvider {
  const vision = new OllamaVision(options);
  return {
    analyzeImage: (request) => vision.analyzeImage(request),
    describeImage: (request) => vision.describeImage(request),
    listModels: (callerSignal) => vision.listModels(callerSignal),
  };
}

/**
 * The message content of a chat answer.
 *
 * @param body the parsed answer
 * @returns the content
 * @throws TypeError when the answer has no string content
 */
function messageContent(body: unknown): string {
  const content = (body as { message?: { content?: unknown } } | null)?.message?.content;
  if (typeof content !== 'string') throw new TypeError('no message content');
  return content;
}

/**
 * Whether a `/api/show` answer reports the vision capability.
 *
 * @param body the parsed answer
 * @returns true/false when capabilities are reported, null when not
 */
function visionCapability(body: unknown): boolean | null {
  const capabilities = (body as { capabilities?: unknown } | null)?.capabilities;
  if (!Array.isArray(capabilities)) return null;
  return capabilities.includes('vision');
}

/**
 * The valid model names of a `/api/tags` answer.
 *
 * @param body the parsed answer
 * @returns at most `MAX_LISTED_MODELS` names that pass `ModelNameSchema`
 * @throws TypeError when the answer has no model list
 */
function modelNames(body: unknown): string[] {
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) throw new TypeError('no model list');
  return models
    .map((entry) => (entry as { name?: unknown } | null)?.name)
    .filter((name): name is string => ModelNameSchema.safeParse(name).success)
    .slice(0, MAX_LISTED_MODELS);
}

/** The configured limits, the fixed body fields and the requester of one Ollama entry. */
class OllamaVision {
  /** The time limit of a chat request. */
  private readonly timeoutMs: number;
  /** The bound for the whole `listModels` call. */
  private readonly listTimeoutMs: number;
  /** The request options in force. */
  private readonly requestOptions: VisionRequestOptions;
  /** The body fields the request options set. */
  private readonly fixed: ReturnType<typeof ollamaFixedFields>;
  /** Sends one request. */
  private readonly request: JsonRequester;

  /**
   * @param options the options the provider was created with
   */
  constructor(private readonly options: OllamaVisionOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.listTimeoutMs = listTimeoutOf(options.listTimeoutMs, this.timeoutMs);
    this.requestOptions = options.requestOptions ?? DEFAULT_REQUEST_OPTIONS;
    this.fixed = ollamaFixedFields(this.requestOptions);
    this.request = createJsonRequester(options);
  }

  /**
   * Tags an image: a chat with the schema as the format, the content parsed as JSON.
   *
   * @param request the image, the prompt, the schema, the model and the signal
   * @returns the parsed answer
   */
  async analyzeImage({ image, prompt, schema, model, signal }: Parameters<VisionProvider['analyzeImage']>[0]) {
    const content = await this.chat({ image, prompt, model, signal }, schema);
    try {
      return JSON.parse(content) as unknown;
    } catch (error) {
      this.options.onFailure?.('invalid_response', 200);
      throw new JobError('invalid_response', { cause: error });
    }
  }

  /**
   * Describes an image: a chat without a format.
   *
   * @param request the image, the prompt, the model and the signal
   * @returns the answer's text
   */
  describeImage({ image, prompt, model, signal }: Parameters<VisionProvider['describeImage']>[0]): Promise<string> {
    return this.chat({ image, prompt, model, signal });
  }

  /**
   * The models through `/api/tags`, each with its vision capability from `/api/show`, within `listTimeoutMs`.
   *
   * @param callerSignal aborts the call
   * @returns the models
   */
  async listModels(callerSignal: AbortSignal): Promise<VisionModel[]> {
    callerSignal.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.listTimeoutMs);
    const signal = AbortSignal.any([callerSignal, deadline.signal]);
    try {
      // The deadline above is the real bound of `/api/tags`; its own limit only has to never fire first.
      const names = await this.request({ path: '/api/tags', signal, timeoutMs: MAX_TIMER_MS }, modelNames);

      const vision: (boolean | null)[] = new Array<boolean | null>(names.length).fill(null);
      const cursor: ShowCursor = { next: 0 };
      await Promise.all(
        Array.from({ length: Math.min(SHOW_CONCURRENCY, names.length) }, () =>
          this.showModels(names, vision, cursor, signal),
        ),
      );
      return names.map((name, index) => ({ name, vision: vision[index] ?? null }));
    } catch (error) {
      // A caller abort stays as it is; an expired deadline is one timeout, reported once.
      if (!callerSignal.aborted && deadline.signal.aborted) {
        this.options.onFailure?.('provider_timeout', null);
        throw new JobError('provider_timeout');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One chat request.
   *
   * @param input the image, the prompt, the model and the signal
   * @param format the answer format; undefined for free text
   * @returns the message content
   */
  private chat(input: ChatInput, format?: unknown): Promise<string> {
    const request: JsonRequest = {
      path: '/api/chat',
      signal: input.signal,
      timeoutMs: this.timeoutMs,
      // The adapter's own fields come last: `extra` can never change the model, the stream or the format.
      body: composeBody(
        this.fixed,
        this.requestOptions.extra,
        {
          model: input.model,
          stream: false,
          ...(format === undefined ? {} : { format }),
          messages: [{ role: 'user', content: input.prompt, images: [Buffer.from(input.image).toString('base64')] }],
        },
        OLLAMA_DEEP_KEYS,
      ),
    };
    return this.request(request, messageContent);
  }

  /**
   * One worker of the list: asks `/api/show` for the next model until none is left.
   *
   * @param names the model names
   * @param vision filled with each model's capability by index
   * @param cursor the next index, shared between the workers
   * @param signal the list's signal
   * @returns resolves once no model is left
   */
  private async showModels(
    names: string[],
    vision: (boolean | null)[],
    cursor: ShowCursor,
    signal: AbortSignal,
  ): Promise<void> {
    while (cursor.next < names.length) {
      const index = cursor.next;
      cursor.next += 1;
      vision[index] = await this.hasVision(names[index]!, signal);
    }
  }

  /**
   * The model's capabilities: true/false when reported, null when not or when `show` fails.
   *
   * @param model the model name
   * @param signal the list's signal
   * @returns the vision capability
   */
  private async hasVision(model: string, signal: AbortSignal): Promise<boolean | null> {
    try {
      // Silent: a failed show is not a provider failure, it only leaves this model unknown.
      const show = { path: '/api/show', body: { model }, signal, timeoutMs: SHOW_TIMEOUT_MS, silent: true } as const;
      return await this.request(show, visionCapability);
    } catch (error) {
      // A caller abort ends the whole list; any other failure only leaves this model unknown.
      if (signal.aborted) throw signal.reason;
      if (error instanceof JobError) return null;
      throw error;
    }
  }
}
